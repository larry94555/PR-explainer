// The settings page's Speed test (PR 8.6): runs one short sample explanation
// on each installed coding model, one model at a time, and ranks them by how
// long the answer took. The model's size and whether it runs on the GPU make
// the biggest difference to speed, and this shows the user both.
//
// Each model is loaded first, so the time is what a click takes once the
// model is warm (PR 8.3), and its GPU share is read from /api/ps while it is
// loaded. Every model but the one picked in the settings is unloaded after its
// answer, so models tested earlier do not take video memory from later ones;
// the picked one is tested last and stays loaded.

import { SAMPLE_CONTEXT } from '../explain/sampleContext';
import { buildExplainPrompt } from '../explain/explainPrompt';
import { gpuStatus, type GpuStatus } from './gpuStatus';
import { MIN_NUM_CTX } from './numCtx';
import { isSameModel, LlmError, type LlmClient, type ModelInfo } from './types';

/** The goal from Milestone 8: an explanation in under 10 seconds. */
export const SPEED_GOAL_MS = 10_000;

// Names of models made for code: qwen2.5-coder, codellama, codegemma,
// deepseek-coder, starcoder2, codestral, devstral, granite-code, and so on.
const CODING_MODEL = /cod(e|er|ing)|starcoder|devstral/i;
// Embedding models cannot chat.
const EMBEDDING_MODEL = /embed/i;

/**
 * The models to time: the coding models, or every model that can chat when
 * none is a coding model.
 */
export function speedTestModels(models: readonly ModelInfo[]): string[] {
  const chat = models.map((m) => m.name).filter((name) => !EMBEDDING_MODEL.test(name));
  const coding = chat.filter((name) => CODING_MODEL.test(name));
  return coding.length > 0 ? coding : chat;
}

export type SpeedResult =
  | {
      model: string;
      status: 'done';
      /** From asking to the full answer, with the model already loaded. */
      totalMs: number;
      /** How fast the answer was written, when the server says. */
      tokensPerSecond?: number;
      /** Where the model ran, when /api/ps said. */
      gpu?: GpuStatus;
    }
  | { model: string; status: 'failed'; message: string }
  | { model: string; status: 'stopped' };

export interface SpeedTestOptions {
  client: LlmClient;
  models: readonly string[];
  /** The model picked in the settings: tested last and kept loaded. */
  current?: string;
  temperature: number;
  maxResponseTokens: number;
  keepAliveMinutes: number;
  signal?: AbortSignal;
  /** Called after each model, with the results so far, in test order. */
  onProgress?(results: SpeedResult[], next?: string): void;
  /** Milliseconds. Defaults to performance.now. */
  now?: () => number;
}

/** Times each model in turn. Never throws; a stopped test marks the models left. */
export async function runSpeedTest(options: SpeedTestOptions): Promise<SpeedResult[]> {
  const { client, signal, current } = options;
  const now = options.now ?? (() => performance.now());
  const messages = buildExplainPrompt(SAMPLE_CONTEXT);
  // The picked model goes last, so it is the one left loaded.
  const isCurrent = (m: string) => !!current && isSameModel(m, current);
  const order = [
    ...options.models.filter((m) => !isCurrent(m)),
    ...options.models.filter(isCurrent),
  ];
  const results: SpeedResult[] = [];
  options.onProgress?.([...results], order[0]);
  for (const model of order) {
    if (signal?.aborted) {
      results.push({ model, status: 'stopped' });
      continue;
    }
    const keepAliveMinutes = isCurrent(model) ? options.keepAliveMinutes : 0;
    try {
      await client.loadModel(model, {
        keepAliveMinutes: Math.max(1, keepAliveMinutes),
        contextTokens: MIN_NUM_CTX,
        signal,
      });
      const gpu = await readGpu(client, model, signal);
      const started = now();
      const reply = await client.chat(messages, {
        model,
        temperature: options.temperature,
        maxResponseTokens: options.maxResponseTokens,
        contextTokens: MIN_NUM_CTX,
        keepAliveMinutes,
        signal,
      });
      const totalMs = now() - started;
      const { answerTokens, answerMs } = reply.timings ?? {};
      const tokensPerSecond =
        answerTokens !== undefined && answerMs ? (answerTokens / answerMs) * 1000 : undefined;
      results.push({
        model,
        status: 'done',
        totalMs,
        ...(tokensPerSecond !== undefined && { tokensPerSecond }),
        ...(gpu && { gpu }),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof LlmError && error.kind === 'aborted')) {
        results.push({ model, status: 'stopped' });
      } else {
        results.push({ model, status: 'failed', message: errorMessage(error) });
      }
    }
    options.onProgress?.([...results], order[results.length]);
  }
  return results;
}

// Where the model runs, or undefined when /api/ps cannot say.
async function readGpu(
  client: LlmClient,
  model: string,
  signal: AbortSignal | undefined,
): Promise<GpuStatus | undefined> {
  try {
    const running = await client.runningModels({ signal });
    const found = running.find((m) => isSameModel(m.name, model));
    return found ? gpuStatus(found) : undefined;
  } catch {
    if (signal?.aborted) throw new LlmError('aborted', 'The request was cancelled.');
    return undefined;
  }
}

/** Fastest first; failed and stopped models after, in test order. */
export function rankResults(results: readonly SpeedResult[]): SpeedResult[] {
  const done = results.filter((r) => r.status === 'done');
  const rest = results.filter((r) => r.status !== 'done');
  return [...done.sort((a, b) => a.totalMs - b.totalMs), ...rest];
}

/** The fastest model that answered under SPEED_GOAL_MS, if any. */
export function fastestUnderGoal(results: readonly SpeedResult[]): string | undefined {
  const [first] = rankResults(results);
  return first?.status === 'done' && first.totalMs < SPEED_GOAL_MS ? first.model : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
