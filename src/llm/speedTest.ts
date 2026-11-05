// The settings page's Speed test (PR 8.6): runs one short sample explanation
// on each installed coding model, one model at a time, and ranks them by how
// long the answer took. The model's size and whether it runs on the GPU make
// the biggest difference to speed, and this shows the user both.
//
// Each model is loaded first, with the context window an explanation would
// use, so the time is what a click takes once the model is warm (PR 8.3) and
// the GPU share is what explanations get. The share is read from /api/ps
// while the model is loaded. Every model but the one picked in the settings is unloaded after its
// answer, so models tested earlier do not take video memory from later ones;
// the picked one is tested last and stays loaded.

import { SAMPLE_CONTEXT } from '../explain/sampleContext';
import { buildExplainPrompt } from '../explain/explainPrompt';
import { gpuStatus, type GpuStatus } from './gpuStatus';
import { LATENCY_GOAL_MS } from './latencyGoal';
import { MIN_NUM_CTX } from './numCtx';
import { isSameModel, LlmError, type LlmClient, type ModelInfo } from './types';

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
  /**
   * The Context size setting: a set window is used as it is, so the test
   * loads the same KV cache (and so the same GPU fit) as an explanation would.
   * 0 (automatic) uses MIN_NUM_CTX, which is what automatic sizing (PR 8.5)
   * and the warm-up give a short explanation like the sample.
   */
  contextTokens: number;
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
  const contextTokens = options.contextTokens > 0 ? options.contextTokens : MIN_NUM_CTX;
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
        contextTokens,
        signal,
      });
      const gpu = await readGpu(client, model, signal);
      const started = now();
      const reply = await client.chat(messages, {
        model,
        temperature: options.temperature,
        maxResponseTokens: options.maxResponseTokens,
        contextTokens,
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

/** The fastest model that answered under LATENCY_GOAL_MS (PR 9.9), if any. */
export function fastestUnderGoal(results: readonly SpeedResult[]): string | undefined {
  const [first] = rankResults(results);
  return first?.status === 'done' && first.totalMs < LATENCY_GOAL_MS ? first.model : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Measure (PR 11.7) ---
//
// The Make Ollama faster section times the picked model alone and keeps the
// result, so a time taken after changing an Ollama setting and restarting
// Ollama can be shown next to the one from before. Only the last two times of
// each model are kept: before and after.

/** The chrome.storage.local key holding the saved measurements. */
export const MEASUREMENTS_KEY = 'speedMeasurements';

/** How many models keep measurements; the oldest model is dropped after that. */
export const MAX_MEASURED_MODELS = 20;

/** One saved Measure result. */
export interface Measurement {
  model: string;
  /** From asking to the full answer, with the model already loaded. */
  totalMs: number;
  tokensPerSecond?: number;
  /** Where the model ran, as `ollama ps` writes it ("100% GPU"). */
  processor?: string;
  /** When it was measured, in milliseconds since 1970. */
  at: number;
}

/** The part of chrome.storage.local the measurements use. */
export interface MeasurementStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The measurement a finished Speed test result gives, or undefined when it did not answer. */
export function measurementFrom(result: SpeedResult, at: number): Measurement | undefined {
  if (result.status !== 'done') return undefined;
  return {
    model: result.model,
    totalMs: result.totalMs,
    ...(result.tokensPerSecond !== undefined && { tokensPerSecond: result.tokensPerSecond }),
    ...(result.gpu && { processor: result.gpu.processor }),
    at,
  };
}

/** Keeps only well-formed measurements from whatever storage held. */
export function parseMeasurements(raw: unknown): Measurement[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is Measurement =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as Measurement).model === 'string' &&
      Number.isFinite((m as Measurement).totalMs) &&
      Number.isFinite((m as Measurement).at),
  );
}

/**
 * Adds `added`, keeping the last two of each model (before and after) and the
 * MAX_MEASURED_MODELS models measured most recently. Oldest first.
 */
export function addMeasurement(list: readonly Measurement[], added: Measurement): Measurement[] {
  const sameModel = list.filter((m) => isSameModel(m.model, added.model));
  const previous = sameModel.at(-1);
  const others = list.filter((m) => !isSameModel(m.model, added.model));
  const kept = [...others, ...(previous ? [previous] : []), added];
  const models = [...new Set(kept.map((m) => m.model))];
  const dropped = new Set(models.slice(0, Math.max(0, models.length - MAX_MEASURED_MODELS)));
  return kept.filter((m) => !dropped.has(m.model));
}

/** The last two measurements of `model`: the one before and the latest. */
export function measurementsFor(
  list: readonly Measurement[],
  model: string,
): { previous?: Measurement; latest?: Measurement } {
  const own = list.filter((m) => isSameModel(m.model, model));
  const latest = own.at(-1);
  const previous = own.length > 1 ? own.at(-2) : undefined;
  return { ...(previous && { previous }), ...(latest && { latest }) };
}

/** A change under this share of the time is within run-to-run noise. */
export const SAME_SPEED_SHARE = 0.05;

export interface Comparison {
  /** The latest time minus the previous one: below 0 is faster. */
  diffMs: number;
  /** diffMs as a share of the previous time, from -1 up. */
  share: number;
  kind: 'faster' | 'slower' | 'same';
  /** One sentence for the user. */
  text: string;
}

/** How the latest measurement compares with the one before. */
export function compareMeasurements(previous: Measurement, latest: Measurement): Comparison {
  const diffMs = latest.totalMs - previous.totalMs;
  const share = previous.totalMs > 0 ? diffMs / previous.totalMs : 0;
  const seconds = `${(Math.abs(diffMs) / 1000).toFixed(1)} s`;
  const percent = `${Math.round(Math.abs(share) * 100)}%`;
  if (Math.abs(share) < SAME_SPEED_SHARE) {
    return {
      diffMs,
      share,
      kind: 'same',
      text: `About the same as before (${percent} difference), which is within run-to-run noise.`,
    };
  }
  return diffMs < 0
    ? {
        diffMs,
        share,
        kind: 'faster',
        text: `${seconds} faster than before (${percent} less time).`,
      }
    : {
        diffMs,
        share,
        kind: 'slower',
        text: `${seconds} slower than before (${percent} more time).`,
      };
}

/** The saved measurements, oldest first; none when storage fails. */
export async function loadMeasurements(storage: MeasurementStorage): Promise<Measurement[]> {
  try {
    const stored = await storage.get([MEASUREMENTS_KEY]);
    return parseMeasurements(stored[MEASUREMENTS_KEY]);
  } catch {
    return [];
  }
}

/** Saves `added` with the ones kept before, and returns the new list. */
export async function saveMeasurement(
  storage: MeasurementStorage,
  added: Measurement,
): Promise<Measurement[]> {
  const list = addMeasurement(await loadMeasurements(storage), added);
  await storage.set({ [MEASUREMENTS_KEY]: list });
  return list;
}
