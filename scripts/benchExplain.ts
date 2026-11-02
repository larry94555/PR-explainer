// The extension's own explain path, for `npm run bench` (PR 8.2). The
// benchmark goes through createExplainHandler, the same code the service
// worker runs on a click, so it measures the real prompt (cut to the same
// budget), the same context window (num_ctx), and the same answer limit.
//
// The extension's source uses import paths without ".ts", which Node cannot
// follow, so scripts/bench.ts loads this file through Vite (runnerImport).

import { createExplainHandler } from '../src/explain/explainHandler';
import { createContextSizer } from '../src/llm/contextSize';
import { gpuStatus } from '../src/llm/gpuStatus';
import { OllamaClient } from '../src/llm/ollamaClient';
import { isSameModel } from '../src/llm/types';
import type { Platform } from '../src/llm/describeLlmError';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import type { BenchRun, BenchSample } from './benchStats.ts';

export { DEFAULT_SETTINGS };

export function createBench(llmUrl: string, platform: Platform, overrides: Partial<Settings> = {}) {
  const client = new OllamaClient({ baseUrl: llmUrl });
  const createClient = () => client;
  const contextSizer = createContextSizer(createClient);
  const settingsFor = (model: string): Settings => ({
    ...DEFAULT_SETTINGS,
    ...overrides,
    llmUrl,
    model,
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
    async explain(sample: BenchSample, model: string): Promise<BenchRun> {
      const explain = createExplainHandler({
        getSettings: async () => settingsFor(model),
        createClient,
        platform,
        contextTokens: contextSizer,
      });
      const startedAt = performance.now();
      let firstTokenMs: number | undefined;
      try {
        const result = await explain(
          {
            context: sample.context.join('\n'),
            ...(sample.pr && { prInfo: sample.pr }),
            ...(sample.fileContext !== undefined && {
              fileContext: sample.fileContext as never,
            }),
          },
          {
            onChunk: (chunk) => {
              if (firstTokenMs === undefined && chunk) firstTokenMs = performance.now() - startedAt;
            },
          },
        );
        const totalMs = performance.now() - startedAt;
        if (result.status === 'failed') return { ok: false, error: result.message };
        return {
          ok: true,
          totalMs,
          ...(firstTokenMs !== undefined && { firstTokenMs }),
          ...('timings' in result && result.timings && { timings: result.timings }),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
