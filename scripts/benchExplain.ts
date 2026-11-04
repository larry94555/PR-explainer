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
  type ExplainResult,
} from '../src/explain/explainHandler';
import {
  AHEAD_HUNK_MAX_LINES,
  AHEAD_MAX_PER_PAGE,
  AHEAD_MAX_PER_PR,
  REQUESTS_AT_ONCE,
  hunkRequest,
  visibleAddedLines,
  worthExplaining,
  type AheadLine,
  type HunkRequest,
} from '../src/explainAhead';
import { createHunkExplainHandler, linePayload, type HunkResult } from '../src/explain/hunkHandler';
import { createPrefetchQueue, explainJob } from '../src/explain/prefetchQueue';
import {
  aheadLines as patchAheadLines,
  requestsFromFiles,
  type PrFile,
} from '../src/patchRequests';
import { splitHunkLines } from '../src/explain/hunkPrompt';
import type { Explanation } from '../src/explain/parseExplanation';
import { createModelLookup } from '../src/llm/contextSize';
import { gpuStatus } from '../src/llm/gpuStatus';
import { OllamaClient } from '../src/llm/ollamaClient';
import { isSameModel } from '../src/llm/types';
import type { Platform } from '../src/llm/describeLlmError';
import { splitAnswer, thinkShare } from '../src/popup/latencyBreakdown';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import {
  formatMs,
  formatRate,
  formatShare,
  summarizeAhead,
  summarizeByHunk,
  summarizeLevel,
  summarizeWholePr,
  formatCachedShare,
  formatMinutes,
  type AheadLineResult,
  type AheadResult,
  type BenchAnswer,
  type ByHunkResult,
  type HunkBenchResult,
  type BenchRun,
  type BenchSample,
  type LevelResult,
  type ParallelResult,
  type TimedRun,
  type WholePrClick,
  type WholePrResult,
} from './benchStats.ts';

export { AHEAD_MAX_PER_PR, DEFAULT_SETTINGS, REQUESTS_AT_ONCE };

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
function loadPage(html: string): Document {
  const { window } = new JSDOM(html);
  // src/diffDom.ts checks `instanceof Element`, which must be this page's Element.
  const scope = globalThis as Record<string, unknown>;
  for (const name of ['Element', 'Node', 'HTMLElement', 'Text']) {
    scope[name] = (window as unknown as Record<string, unknown>)[name];
  }
  return window.document;
}

export function aheadLines(html: string): AheadSampleLine[] {
  const document = loadPage(html);
  const lines: AheadSampleLine[] = [];
  for (const cell of addedLineCells(document)) {
    const line = locateLine(cell);
    const request = line && worthExplaining(line.text) && lineRequest(cell)?.request;
    if (!line || !request) continue;
    lines.push({ key: `${line.filePath}:${line.lineNumber}`, context: request.text });
    if (lines.length === AHEAD_MAX_PER_PAGE) break;
  }
  return lines;
}

/** One request of the ahead mode: its timing, and whether the cache answered it. */
export type AheadAsk = (
  line: AheadSampleLine,
  cause: 'ahead' | 'click',
) => Promise<{ run: BenchRun; fromCache: boolean }>;

/**
 * Explains `lines` ahead one at a time, then clicks each. As in Explain ahead
 * (src/explainAhead.ts), a failed line ends the pass, so the lines after it
 * are not explained ahead and their clicks are fresh answers.
 */
export async function explainAheadThenClick(
  lines: readonly AheadSampleLine[],
  ask: AheadAsk,
): Promise<AheadLineResult[]> {
  const ahead: (BenchRun | undefined)[] = [];
  for (const line of lines) {
    const { run } = await ask(line, 'ahead');
    ahead.push(run);
    if (!run.ok) break;
  }
  const results: AheadLineResult[] = [];
  for (const [i, line] of lines.entries()) {
    const { run: click, fromCache } = await ask(line, 'click');
    const before = ahead[i];
    results.push({ line: line.key, ...(before && { ahead: before }), click, fromCache });
  }
  return results;
}

/** chrome.storage.session in memory, for the explanation cache. */
function memoryStorage(): SessionStorageLike {
  const items: Record<string, unknown> = {};
  return {
    get: async (keys) => Object.fromEntries(keys.map((k) => [k, items[k]])),
    set: async (values) => void Object.assign(items, values),
    remove: async (keys) => keys.forEach((k) => delete items[k]),
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

    /**
     * Explains `sample` once with `model`, timing it the way the popup does.
     * `onFirstToken` hears when the first piece of the answer arrives.
     */
    explain: (
      sample: BenchSample,
      model: string,
      onFirstToken?: () => void,
      signal?: AbortSignal,
    ): Promise<BenchRun> =>
      timed(
        handlerFor(model),
        {
          context: sample.context.join('\n'),
          ...(sample.pr && { prInfo: sample.pr }),
          ...(sample.fileContext !== undefined && { fileContext: sample.fileContext as never }),
        },
        { ...(onFirstToken && { onFirstToken }), ...(signal && { signal }) },
      ),

    /**
     * The ahead mode (PR 9.11): explains each line ahead, one at a time, as
     * Explain ahead does, then times a click on each. Both go through the
     * same handler and an explanation cache, as in the service worker, so a
     * click on a line explained ahead is answered from the cache.
     */
    aheadThenClick(lines: readonly AheadSampleLine[], model: string) {
      const explain = handlerFor(model, createExplainCache(memoryStorage()));
      return explainAheadThenClick(lines, async (line, cause) => {
        let fromCache = false;
        const run = await timed(
          explain,
          { context: line.context, pr: AHEAD_PR, cause },
          { onCached: (cached) => (fromCache = cached) },
        );
        return { run, fromCache };
      });
    },

    /**
     * The by-hunk mode (PR 10.5) for one hunk: each line on its own, as a
     * click asks with nothing cached, then the whole hunk in one request,
     * whose answers are read back from the cache the way a click finds them.
     */
    async byHunk(request: HunkRequest, model: string): Promise<HunkBenchResult> {
      const single: HunkBenchResult['single'] = [];
      const fresh = handlerFor(model);
      for (const line of request.lines) {
        let answer: BenchAnswer | undefined;
        const run = await timed(
          fresh,
          { context: line.request.text, pr: AHEAD_PR, cause: 'ahead' },
          { onAnswer: (a) => (answer = a) },
        );
        single.push({ line: line.label, run, ...(answer && { answer }) });
      }
      const cache = createExplainCache(memoryStorage());
      const settings = settingsFor(model);
      const explainHunk = createHunkExplainHandler({
        getSettings: async () => settings,
        createClient,
        platform,
        contextTokens: contextSizer,
        thinking,
        cache,
      });
      const startedAt = performance.now();
      let hunk: BenchRun;
      try {
        const result = await explainHunk({
          context: request.text,
          pr: AHEAD_PR,
          cause: 'ahead',
          hunk: {
            text: request.text,
            lines: request.lines.map((l) => ({
              label: l.label,
              context: l.request.text,
              line: l.line,
              code: l.code,
            })),
          },
        });
        hunk =
          result.status === 'failed'
            ? { ok: false, error: result.message }
            : {
                ok: true,
                totalMs: performance.now() - startedAt,
                ...(result.timings && { timings: result.timings }),
              };
      } catch (error) {
        hunk = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      // A click on each line, answered from what the hunk request saved.
      const cached = handlerFor(model, cache);
      const byHunk: (BenchAnswer | undefined)[] = [];
      for (const line of request.lines) {
        const result = await cached({ context: line.request.text, pr: AHEAD_PR });
        byHunk.push(
          result.status === 'done' && result.cached ? answerOf(result.explanation) : undefined,
        );
      }
      return { label: request.label, single, hunk, byHunk };
    },

    /** Explains `context` once with nothing cached, as a click on an idle model does. */
    single: (context: string, model: string, signal?: AbortSignal): Promise<BenchRun> =>
      timed(handlerFor(model), { context, pr: AHEAD_PR }, signal && { signal }),

    /**
     * The whole-PR mode (PR 10.8): the explain and hunk handlers sharing one
     * empty cache, as in the service worker, for prefetchWholePr.
     */
    wholePrAsk(model: string): WholePrAsk {
      const deps: ExplainDeps = {
        getSettings: async () => settingsFor(model),
        createClient,
        platform,
        contextTokens: contextSizer,
        thinking,
        cache: createExplainCache(memoryStorage()),
      };
      const explain = createExplainHandler(deps);
      const explainHunk = createHunkExplainHandler(deps);
      return (payload, options) =>
        payload.hunk ? explainHunk(payload, options) : explain(payload, options);
    },
  };
}

const answerOf = ({ what, why, concerns }: Explanation): BenchAnswer => ({ what, why, concerns });

/**
 * Runs one explain request, timing it the way the popup does: the whole
 * answer, the first piece of it, Ollama's timings and the thinking part.
 * `onCached` hears whether the answer came from the cache, and
 * `onFirstToken` when the first piece of the answer arrives.
 */
async function timed(
  explain: ReturnType<typeof createExplainHandler>,
  payload: ExplainPayload,
  {
    onCached,
    onFirstToken,
    onAnswer,
    signal,
  }: {
    onCached?: (cached: boolean) => void;
    onFirstToken?: () => void;
    onAnswer?: (answer: BenchAnswer) => void;
    /** Stops the request (the whole-PR mode's time limit). */
    signal?: AbortSignal;
  } = {},
): Promise<BenchRun> {
  const startedAt = performance.now();
  let firstTokenMs: number | undefined;
  let reply = '';
  try {
    const result = await explain(payload, {
      ...(signal && { signal }),
      onChunk: (chunk) => {
        reply += chunk;
        if (firstTokenMs === undefined && chunk) {
          firstTokenMs = performance.now() - startedAt;
          onFirstToken?.();
        }
      },
    });
    const totalMs = performance.now() - startedAt;
    if (result.status === 'failed') return { ok: false, error: result.message };
    onCached?.(result.cached !== undefined);
    onAnswer?.(answerOf(result.explanation));
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

// --- Requests at once (PR 10.1) --------------------------------------------

/** One request of the parallel mode: explains `sample`, calling `onFirstToken` when the answer starts. */
export type ParallelAsk = (sample: BenchSample, onFirstToken: () => void) => Promise<BenchRun>;

/**
 * The requests every level sends, the same list for each so the levels are
 * compared on the same work (review on #60): every sample `runs` times, and
 * more whole rounds of the samples until there are at least two rounds of the
 * highest level, so even that level has more work than it runs at once.
 */
export function levelJobs(
  samples: readonly BenchSample[],
  runs: number,
  levels: readonly number[],
) {
  const rounds = Math.max(runs, Math.ceil((Math.max(...levels) * 2) / samples.length));
  return Array.from({ length: samples.length * rounds }, (_, i) => samples[i % samples.length]!);
}

/**
 * One level of the parallel mode: keeps `atOnce` requests going until every
 * job is answered. Once the model is writing (the first piece of any answer
 * arrives, or the first request ends), `click` is sent as one more request
 * and timed. Times are from the start of the level.
 */
export async function runLevel(
  atOnce: number,
  jobs: readonly BenchSample[],
  click: BenchSample,
  ask: ParallelAsk,
  now: () => number = () => performance.now(),
): Promise<LevelResult> {
  const t0 = now();
  const at = () => now() - t0;
  const timedAsk = async (sample: BenchSample, onStarted?: () => void): Promise<TimedRun> => {
    const startMs = at();
    let firstTokenAtMs: number | undefined;
    const run = await ask(sample, () => {
      firstTokenAtMs ??= at();
      onStarted?.();
    });
    return {
      run,
      startMs,
      endMs: at(),
      ...(firstTokenAtMs !== undefined && { firstTokenAtMs }),
    };
  };

  let sendClick!: () => void;
  const busy = new Promise<void>((resolve) => (sendClick = resolve));
  const clicked = busy.then(() => timedAsk(click));

  const answers: TimedRun[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      answers[i] = await timedAsk(jobs[i]!, sendClick);
      sendClick();
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, jobs.length) }, worker));
  sendClick(); // when there were no jobs
  return { atOnce, answers, click: await clicked };
}

/**
 * The parallel mode for each model (PR 10.1): each level in turn, after
 * loading the model once with the first sample (not counted). Prints a line
 * per level as it finishes.
 */
export async function runParallel(
  bench: ReturnType<typeof createBench>,
  models: readonly string[],
  samples: readonly BenchSample[],
  levels: readonly number[],
  runs: number,
): Promise<ParallelResult[]> {
  const results: ParallelResult[] = [];
  for (const model of models) {
    console.log(`  ${model} · loading …`);
    await bench.explain(samples[0]!, model);
    const result: ParallelResult = { model, levels: [] };
    const jobs = levelJobs(samples, runs, levels);
    for (const atOnce of levels) {
      process.stdout.write(
        `  ${model} · ${atOnce} at once · ${jobs.length} answers and a click … `,
      );
      const level = await runLevel(atOnce, jobs, samples[0]!, (sample, onFirstToken) =>
        bench.explain(sample, model, onFirstToken),
      );
      result.levels.push(level);
      const s = summarizeLevel(level);
      console.log(
        `${formatRate(s.perMinute)} answers/min, median ${formatMs(s.medianMs)} per answer, ` +
          `${s.ranTogether} ran together, click ${s.clickError ? `failed: ${s.clickError}` : formatMs(s.clickMs)}` +
          (s.failed ? ` (${s.failed} failed)` : ''),
      );
    }
    const ranOn = await bench.ranOn(model);
    if (ranOn) result.ranOn = ranOn;
    results.push(result);
  }
  return results;
}

// --- By hunk (PR 10.5) -----------------------------------------------------

/**
 * The hunk requests Explain ahead would send for every added line of a saved
 * diff page: the lines of each hunk, AHEAD_HUNK_MAX_LINES at a time.
 */
export function hunkRequests(html: string): HunkRequest[] {
  const lines = visibleAddedLines(loadPage(html), () => true).filter((l) =>
    worthExplaining(l.text),
  );
  const byHunk = new Map<string, AheadLine[]>();
  for (const line of lines) {
    const id = line.hunk?.id ?? line.key;
    byHunk.set(id, [...(byHunk.get(id) ?? []), line]);
  }
  return [...byHunk.values()]
    .flatMap((group) => splitHunkLines(group, AHEAD_HUNK_MAX_LINES))
    .flatMap((part) => {
      const request = hunkRequest(part);
      return request ? [request] : [];
    });
}

/** The by-hunk mode for each model (PR 10.5), after loading the model with `warmSample`. */
export async function runByHunk(
  bench: ReturnType<typeof createBench>,
  models: readonly string[],
  warmSample: BenchSample,
): Promise<ByHunkResult[]> {
  const root = resolve(import.meta.dirname, '..');
  const requests = hunkRequests(readFileSync(join(root, AHEAD_PAGE), 'utf8'));
  const lines = requests.reduce((n, r) => n + r.lines.length, 0);
  const results: ByHunkResult[] = [];
  for (const model of models) {
    console.log(`  ${model} · loading, then ${lines} lines in ${requests.length} hunks …`);
    await bench.explain(warmSample, model); // loads the model; not counted
    const result: ByHunkResult = { model, page: AHEAD_PAGE, hunks: [] };
    for (const request of requests) {
      const hunk = await bench.byHunk(request, model);
      result.hunks.push(hunk);
      const s = summarizeByHunk([hunk]);
      console.log(
        `  ${model} · ${request.label} · one at a time ${formatMs(s.singlePerLineMs)} per line, ` +
          (hunk.hunk.ok
            ? `by hunk ${formatMs(s.hunkPerLineMs)} per line (${s.hunkAnswered} of ${s.lines} answered)`
            : `by hunk failed: ${hunk.hunk.error}`),
      );
    }
    const ranOn = await bench.ranOn(model);
    if (ranOn) result.ranOn = ranOn;
    results.push(result);
  }
  return results;
}

// --- Whole PR (PR 10.8) ----------------------------------------------------

/** The saved PR the whole-PR mode prefetches: the src/ files of #66 (PR 10.7), as GitHub's API lists them. */
export const WHOLE_PR_SAMPLE = 'tests/fixtures/github-pr-66-src-files.json';

/**
 * How long the whole-PR mode lets one model run, from loading it to the end
 * of the prefetch: past the last checkpoint (15 minutes).
 */
export const WHOLE_PR_MAX_MS = 20 * 60_000;

/** How many lines are asked one at a time first, for the time per line without hunks. */
export const WHOLE_PR_SINGLE_LINES = 10;

/** The requests Whole PR sends for a saved PR. */
export interface WholePrPlan {
  /** Changed lines worth explaining. */
  lines: number;
  /** Lines sent, at most `maxLines`. */
  sent: number;
  /** One per hunk, AHEAD_HUNK_MAX_LINES lines at most, in the PR's order. */
  requests: HunkRequest[];
}

/**
 * What Whole PR (PR 10.6) sends for `files` (the API's list of a PR's files):
 * every changed line worth explaining, built as a click would build it
 * (src/patchRequests.ts), up to the per-PR limit, grouped by hunk.
 */
export function wholePrPlan(files: readonly PrFile[], maxLines = AHEAD_MAX_PER_PR): WholePrPlan {
  const all = patchAheadLines(requestsFromFiles(files));
  const byHunk = new Map<string, AheadLine[]>();
  for (const line of all.slice(0, maxLines)) {
    const id = line.hunk?.id ?? line.key;
    byHunk.set(id, [...(byHunk.get(id) ?? []), line]);
  }
  const requests = [...byHunk.values()]
    .flatMap((group) => splitHunkLines(group, AHEAD_HUNK_MAX_LINES))
    .flatMap((part) => {
      const request = hunkRequest(part);
      return request ? [request] : [];
    });
  return { lines: all.length, sent: requests.reduce((n, r) => n + r.lines.length, 0), requests };
}

/** What the service worker's queue runs: the explain handler, or the hunk handler for a hunk. */
export type WholePrAsk = (
  payload: ExplainPayload,
  options: { signal: AbortSignal; onChunk(text: string): void },
) => Promise<ExplainResult | HunkResult>;

export interface WholePrOptions {
  /** Requests at once. */
  atOnce?: number;
  /** Stops the run (dropping what is left) after this long. */
  maxMs?: number;
  now?: () => number;
  /** Send a click on a line not reached yet once the first request is in. Default true. */
  click?: boolean;
}

export type WholePrRun = Pick<WholePrResult, 'totalMs' | 'stopped' | 'answered' | 'failures'> & {
  click?: WholePrClick;
};

/**
 * Sends every request of `requests` through the service worker's queue
 * (src/explain/prefetchQueue.ts), wired as src/background.ts wires it: a hunk
 * request goes to the hunk handler, the lines its answer left out come back
 * one by one, a failed request is tried once more. Records when each line is
 * answered. Once the first request is in (the model is busy with the next),
 * it clicks the last line of the PR, which the background work has not
 * reached, and records how long the click waited and what it stopped.
 */
export async function prefetchWholePr(
  requests: readonly HunkRequest[],
  ask: WholePrAsk,
  {
    atOnce = 1,
    maxMs = WHOLE_PR_MAX_MS,
    now = () => performance.now(),
    click = true,
  }: WholePrOptions = {},
): Promise<WholePrRun> {
  const t0 = now();
  const at = () => now() - t0;
  const labelOf = new Map(requests.flatMap((r) => r.lines.map((l) => [l.request.text, l.label])));
  const answered = new Map<string, number>();
  const mark = (label: string) => {
    // The clicked line is the click's answer, even when the click joined its
    // queued background job (review on #67).
    if (label === clicked?.line) return;
    if (!answered.has(label)) answered.set(label, at());
  };
  const lastError = new Map<string, string>();
  const failures: string[] = [];
  let clicked: (WholePrClick & { pending: boolean }) | undefined;
  let stopped = false;
  let sentAll = false;
  let finishRun!: () => void;
  const ran = new Promise<void>((resolve) => (finishRun = resolve));

  const queue = createPrefetchQueue<ExplainPayload, ExplainResult | HunkResult>({
    concurrency: atOnce,
    now: at,
    run: async (payload, options) => {
      const result = await ask(payload, options);
      // Only what the background work answered with the model counts (review
      // on #67): the click is timed on its own, and a line found in the cache
      // was answered by the click, since the run starts with an empty cache.
      if (payload.cause === 'click') return result;
      const label = payload.job?.label ?? labelOf.get(payload.context) ?? payload.context;
      if (result.status === 'failed') lastError.set(label, result.message);
      else if (result.status === 'hunk') {
        result.lines.forEach((line, i) => {
          if (line.status === 'done') mark(payload.hunk?.lines[i]?.label ?? line.label);
        });
      } else if (result.cached === undefined) mark(labelOf.get(payload.context) ?? label);
      return result;
    },
    failed: (result) => result.status === 'failed',
    cached: (result) =>
      result.status === 'hunk'
        ? result.lines.every((line) => line.status === 'cached')
        : result.status === 'done' && result.cached !== undefined,
    followUps: (spec, result) =>
      result.status === 'hunk' && spec.payload.hunk
        ? result.lines.flatMap((line, i) =>
            line.status === 'missing'
              ? [explainJob(linePayload(spec.payload, spec.payload.hunk!.lines[i]!))]
              : [],
          )
        : [],
    onEvent: (event) => {
      if (event.priority === 'click') {
        if (event.type === 'started' && clicked) clicked.startedAtMs ??= at();
      } else {
        const waiting = clicked && clicked.startedAtMs === undefined;
        if (waiting && event.type === 'cancelled') clicked!.cancelled += 1;
        if (waiting && ['finished', 'skipped', 'failed', 'retry'].includes(event.type)) {
          clicked!.finishedWhileWaiting += 1;
        }
        if (event.type === 'failed') {
          failures.push(`${event.label}: ${lastError.get(event.label) ?? 'failed'}`);
        }
        // The first answer is in and more is waiting: time a click now.
        if (click && !clicked && sentAll && event.type !== 'queued' && event.waiting > 0) {
          if (['finished', 'skipped', 'failed'].includes(event.type)) queueMicrotask(sendClick);
        }
      }
      // Checked once the event is over: a finished hunk's follow-ups are
      // queued just after it is reported.
      if (sentAll && event.running === 0 && event.waiting === 0) queueMicrotask(finishIfIdle);
    },
  });

  function finishIfIdle(): void {
    const { running, waiting } = queue.state();
    if (running.length === 0 && waiting.length === 0 && !clicked?.pending) finishRun();
  }

  function sendClick(): void {
    if (clicked || stopped) return;
    const target = requests.at(-1)?.lines.at(-1);
    if (!target || answered.has(target.label)) return;
    const sentAtMs = at();
    clicked = {
      line: target.label,
      sentAtMs,
      run: { ok: false, error: 'not answered' },
      finishedWhileWaiting: 0,
      cancelled: 0,
      pending: true,
    };
    const state = clicked;
    let firstTokenMs: number | undefined;
    queue
      .add(explainJob({ context: target.request.text, pr: AHEAD_PR, cause: 'click' }), {
        onChunk: (text) => {
          if (firstTokenMs === undefined && text) firstTokenMs = at() - sentAtMs;
        },
      })
      .then(
        (result): BenchRun =>
          result.status === 'failed'
            ? { ok: false, error: result.message }
            : {
                ok: true,
                totalMs: at() - sentAtMs,
                ...(firstTokenMs !== undefined && { firstTokenMs }),
                ...(result.status === 'done' && result.timings && { timings: result.timings }),
              },
        (error: unknown): BenchRun => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((run) => {
        state.run = run;
        state.pending = false;
        finishIfIdle();
      });
  }

  const timer = setTimeout(() => {
    stopped = true;
    queue.drop(() => true);
    finishRun();
  }, maxMs);
  // Every request at once, as the content script's pass would hand them
  // over; the queue runs them in the PR's order.
  requests.forEach((request, order) => {
    const payload: ExplainPayload =
      request.lines.length === 1
        ? {
            context: request.lines[0]!.request.text,
            pr: AHEAD_PR,
            cause: 'ahead',
            job: { label: request.lines[0]!.label, priority: 'rest', order },
          }
        : {
            context: request.text,
            pr: AHEAD_PR,
            cause: 'ahead',
            job: { label: request.label, priority: 'rest', order },
            hunk: {
              text: request.text,
              lines: request.lines.map((l) => ({
                label: l.label,
                context: l.request.text,
                line: l.line,
                code: l.code,
              })),
            },
          };
    // A request dropped at the time limit rejects; its lines are simply not answered.
    queue.add(explainJob(payload)).catch(() => {});
  });
  sentAll = true;
  if (requests.length === 0) finishRun();
  await ran;
  clearTimeout(timer);
  const totalMs = at();
  const answeredLines = [...answered].map(([line, atMs]) => ({ line, atMs }));
  answeredLines.sort((a, b) => a.atMs - b.atMs);
  const result: WholePrRun = {
    totalMs,
    stopped: stopped && answered.size < labelOf.size,
    answered: answeredLines,
    failures,
  };
  if (clicked) {
    const { line, sentAtMs, startedAtMs, run, finishedWhileWaiting, cancelled } = clicked;
    result.click = {
      line,
      sentAtMs,
      ...(startedAtMs !== undefined && { startedAtMs }),
      run,
      finishedWhileWaiting,
      cancelled,
    };
  }
  return result;
}

/**
 * The whole-PR mode for each model (PR 10.8): loads the model (not counted),
 * asks WHOLE_PR_SINGLE_LINES lines one at a time, then prefetches the whole
 * saved PR through the queue with an empty cache. Prints progress as it goes.
 */
export async function runWholePr(
  bench: ReturnType<typeof createBench>,
  models: readonly string[],
  warmSample: BenchSample,
  {
    atOnce = 1,
    maxMs = WHOLE_PR_MAX_MS,
    sample = WHOLE_PR_SAMPLE,
  }: { atOnce?: number; maxMs?: number; sample?: string } = {},
): Promise<WholePrResult[]> {
  const root = resolve(import.meta.dirname, '..');
  const files = JSON.parse(readFileSync(join(root, sample), 'utf8')) as PrFile[];
  const plan = wholePrPlan(files);
  const results: WholePrResult[] = [];
  for (const model of models) {
    // `maxMs` covers the whole model (review on #67): loading it and the lines
    // one at a time too, so a slow or stuck Ollama cannot run past it.
    const modelStarted = performance.now();
    const left = () => maxMs - (performance.now() - modelStarted);
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), maxMs);
    console.log(`  ${model} · loading, then ${WHOLE_PR_SINGLE_LINES} lines one at a time …`);
    await bench.explain(warmSample, model, undefined, deadline.signal); // loads the model; not counted
    const single: BenchRun[] = [];
    for (const line of plan.requests.flatMap((r) => r.lines).slice(0, WHOLE_PR_SINGLE_LINES)) {
      if (deadline.signal.aborted) break;
      single.push(await bench.single(line.request.text, model, deadline.signal));
    }
    clearTimeout(deadlineTimer);
    console.log(
      `  ${model} · the whole PR: ${plan.sent} lines in ${plan.requests.length} requests, ` +
        `${formatMinutes(Math.max(0, left()))} at most …`,
    );
    const ask = bench.wholePrAsk(model);
    const started = performance.now();
    let reported = 0;
    const run = await prefetchWholePr(
      plan.requests,
      async (payload, options) => {
        const result = await ask(payload, options);
        // A line of progress about once a minute.
        const minute = Math.floor((performance.now() - started) / 60_000);
        if (minute > reported) {
          reported = minute;
          console.log(`  ${model} · ${minute} min …`);
        }
        return result;
      },
      // The rest of the model's time; when none is left, the run stops at once.
      { atOnce, maxMs: Math.max(0, left()) },
    );
    const result: WholePrResult = {
      model,
      sample,
      lines: plan.lines,
      sent: plan.sent,
      requests: plan.requests.length,
      atOnce,
      single,
      ...run,
    };
    const ranOn = await bench.ranOn(model);
    if (ranOn) result.ranOn = ranOn;
    const s = summarizeWholePr(result);
    console.log(
      `  ${model} · whole PR ${formatMinutes(s.wholePrMs, s.estimated)}, ` +
        `${formatMs(s.byHunkPerLineMs)} per line by hunk (${formatMs(s.singlePerLineMs)} one at a time), ` +
        s.cached.map((c) => `after ${c.minutes} min ${formatCachedShare(c, s.lines)}`).join(', '),
    );
    results.push(result);
  }
  return results;
}
