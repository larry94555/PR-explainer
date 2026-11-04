// The extension's own explain path, for `npm run bench` (PR 8.2). The
// benchmark goes through createExplainHandler, the same code the service
// worker runs on a click, so it measures the real prompt (cut to the same
// budget), the same context window (num_ctx), and the same answer limit.
//
// The extension's source uses import paths without ".ts", which Node cannot
// follow, so scripts/bench.ts loads this file through Vite (runnerImport).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { lineRequest } from '../src/clickHandler';
import { addedLineCells, locateLine } from '../src/diffDom';
import { createExplainCache, type SessionStorageLike } from '../src/explain/explainCache';
import {
  createExplainHandler,
  type ExplainDeps,
  type ExplainPayload,
} from '../src/explain/explainHandler';
import { AHEAD_MAX_PER_PAGE, worthExplaining } from '../src/explainAhead';
import { createModelLookup } from '../src/llm/contextSize';
import { gpuStatus } from '../src/llm/gpuStatus';
import { OllamaClient } from '../src/llm/ollamaClient';
import { isSameModel } from '../src/llm/types';
import type { Platform } from '../src/llm/describeLlmError';
import { splitAnswer, thinkShare } from '../src/popup/latencyBreakdown';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import {
  formatMs,
  formatShare,
  summarizeAhead,
  type AheadLineResult,
  type AheadResult,
  type BenchRun,
  type BenchSample,
} from './benchStats.ts';

export { DEFAULT_SETTINGS };

/** The PR the ahead mode's answers are cached under (any name works; the cache needs one). */
const AHEAD_PR = 'bench/ahead';

/** A line the ahead mode explains: its name and the context a click on it would send. */
export interface AheadSampleLine {
  key: string;
  context: string;
}

/**
 * The added lines of a saved GitHub diff page, top to bottom, as Explain ahead
 * (PR 9.10) picks them: blank and closing lines skipped, at most
 * AHEAD_MAX_PER_PAGE, each with the request a click builds (lineRequest).
 */
export function aheadLines(html: string): AheadSampleLine[] {
  const { window } = new JSDOM(html);
  // src/diffDom.ts checks `instanceof Element`, which must be this page's Element.
  const scope = globalThis as Record<string, unknown>;
  for (const name of ['Element', 'Node', 'HTMLElement', 'Text']) {
    scope[name] = (window as unknown as Record<string, unknown>)[name];
  }
  const lines: AheadSampleLine[] = [];
  for (const cell of addedLineCells(window.document)) {
    const line = locateLine(cell);
    const request = line && worthExplaining(line.text) && lineRequest(cell)?.request;
    if (!line || !request) continue;
    lines.push({ key: `${line.filePath}:${line.lineNumber}`, context: request.text });
    if (lines.length === AHEAD_MAX_PER_PAGE) break;
  }
  return lines;
}

/** chrome.storage.session in memory, for the explanation cache. */
function memoryStorage(): SessionStorageLike {
  const items: Record<string, unknown> = {};
  return {
    get: async (keys) => Object.fromEntries(keys.map((k) => [k, items[k]])),
    set: async (values) => void Object.assign(items, values),
  };
}

export function createBench(llmUrl: string, platform: Platform, overrides: Partial<Settings> = {}) {
  const client = new OllamaClient({ baseUrl: llmUrl });
  const createClient = () => client;
  const { contextTokens: contextSizer, thinking } = createModelLookup(createClient);
  const settingsFor = (model: string): Settings => ({
    ...DEFAULT_SETTINGS,
    ...overrides,
    llmUrl,
    model,
  });

  const handlerFor = (model: string, cache?: ExplainDeps['cache']) =>
    createExplainHandler({
      getSettings: async () => settingsFor(model),
      createClient,
      platform,
      contextTokens: contextSizer,
      thinking,
      ...(cache && { cache }),
    });

  return {
    listModels: () => client.listModels(),

    /** Unloads `model` (keep_alive 0), so the next run starts cold. */
    unload: (model: string) => client.loadModel(model, { keepAliveMinutes: 0 }),

    /** Where `model` runs, worded like `ollama ps` ("100% GPU"), or undefined when not loaded. */
    async ranOn(model: string): Promise<string | undefined> {
      const running = await client.runningModels().catch(() => []);
      const found = running.find((m) => isSameModel(m.name, model));
      return found && gpuStatus(found).processor;
    },

    /** The context window explanations with `model` run with. */
    contextTokens: (model: string) => contextSizer(settingsFor(model)),

    /** Explains `sample` once with `model`, timing it the way the popup does. */
    explain: (sample: BenchSample, model: string): Promise<BenchRun> =>
      timed(handlerFor(model), {
        context: sample.context.join('\n'),
        ...(sample.pr && { prInfo: sample.pr }),
        ...(sample.fileContext !== undefined && { fileContext: sample.fileContext as never }),
      }),

    /**
     * The ahead mode (PR 9.11): explains each line ahead, one at a time, as
     * Explain ahead does, then times a click on each. Both go through the
     * same handler and an explanation cache, as in the service worker, so a
     * click on a line explained ahead is answered from the cache.
     */
    async aheadThenClick(lines: readonly AheadSampleLine[], model: string) {
      const explain = handlerFor(model, createExplainCache(memoryStorage()));
      const ahead: BenchRun[] = [];
      for (const line of lines) {
        ahead.push(await timed(explain, { context: line.context, pr: AHEAD_PR, cause: 'ahead' }));
      }
      const results: AheadLineResult[] = [];
      for (const [i, line] of lines.entries()) {
        let fromCache = false;
        const click = await timed(
          explain,
          { context: line.context, pr: AHEAD_PR, cause: 'click' },
          (cached) => (fromCache = cached),
        );
        results.push({ line: line.key, ahead: ahead[i]!, click, fromCache });
      }
      return results;
    },
  };
}

/**
 * Runs one explain request, timing it the way the popup does: the whole
 * answer, the first piece of it, Ollama's timings and the thinking part.
 * `onCached` hears whether the answer came from the cache.
 */
async function timed(
  explain: ReturnType<typeof createExplainHandler>,
  payload: ExplainPayload,
  onCached?: (cached: boolean) => void,
): Promise<BenchRun> {
  const startedAt = performance.now();
  let firstTokenMs: number | undefined;
  let reply = '';
  try {
    const result = await explain(payload, {
      onChunk: (chunk) => {
        reply += chunk;
        if (firstTokenMs === undefined && chunk) firstTokenMs = performance.now() - startedAt;
      },
    });
    const totalMs = performance.now() - startedAt;
    if (result.status === 'failed') return { ok: false, error: result.message };
    onCached?.(result.cached !== undefined);
    const { timings } = result;
    // The thinking part of the answer, as the popup's Think row works it out
    // (PR 9.1), with thinking in its own field counted too (PR 9.5).
    const { think } = splitAnswer(
      { tokens: timings?.answerTokens, ms: timings?.answerMs },
      thinkShare(reply, result.thinking),
    );
    return {
      ok: true,
      totalMs,
      ...(firstTokenMs !== undefined && { firstTokenMs }),
      ...(timings && { timings }),
      ...((think.tokens !== undefined || think.ms !== undefined) && { think }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The saved diff page the ahead mode explains (GitHub's newer split layout, 7 added lines). */
export const AHEAD_PAGE = 'tests/fixtures/github-diff-new-split.html';

/**
 * The ahead mode for each model (PR 9.11). The model is loaded first with
 * `warmSample`, as the warm-up does when a PR opens, so the ahead times do
 * not include loading it.
 */
export async function runAhead(
  bench: ReturnType<typeof createBench>,
  models: readonly string[],
  warmSample: BenchSample,
): Promise<AheadResult[]> {
  const root = resolve(import.meta.dirname, '..');
  const lines = aheadLines(readFileSync(join(root, AHEAD_PAGE), 'utf8'));
  const results: AheadResult[] = [];
  for (const model of models) {
    console.log(`  ${model} · loading, then explaining ${lines.length} lines ahead …`);
    await bench.explain(warmSample, model); // loads the model; not counted
    const result: AheadResult = {
      model,
      page: AHEAD_PAGE,
      lines: await bench.aheadThenClick(lines, model),
    };
    const ranOn = await bench.ranOn(model);
    if (ranOn) result.ranOn = ranOn;
    const s = summarizeAhead(result.lines);
    console.log(
      `  ${model} · ahead ${formatMs(s.aheadTotalMs)} in all (${formatMs(s.aheadMedianMs)} per line), ` +
        `clicks within 2 s: ${formatShare(s)}`,
    );
    results.push(result);
  }
  return results;
}
