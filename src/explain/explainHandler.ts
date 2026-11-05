// The service worker's `explain` handler: reads the settings, streams the
// prompt's reply from the local LLM (passing each piece to `onChunk` so the
// popup can show it as it arrives), and parses the full reply into three
// sections at the end.
//
// LLM failures come back as a result with a message and a fix (from
// describeLlmError) instead of a thrown error, because the messaging layer
// only carries an error's name and message, and the popup (PR 3.4) needs the
// fix too.
//
// Finished explanations are cached (src/explain/explainCache.ts) when the
// request names its PR. A cached answer comes back at once, marked `cached`,
// unless the request asks for a `fresh` one (the popup's Regenerate button).
//
// The PR's title and description, when the content script sends them, go
// into the prompt (and so into the cache key) so "Why it's needed" can refer
// to the PR's stated goal (PR 6.1).
//
// The prompt is cut to fit the model's context window (PR 6.2, see
// src/explain/fitPrompt.ts), and the model is run with that window. When even
// the code is too long, the result says so with a fix. With the Show prompt
// setting on, the result carries the prompt as sent.
//
// The content script may also send the function or block around the code,
// read from the full file at the PR's head (PR 6.3). It is checked here, and
// it is the first thing cut when the prompt is too long.
//
// An answer from the model carries the server's timings (PR 8.1), for the
// popup's latency Details. A cached answer has none.
//
// With Context size on automatic, the window is sized to the prompt and the
// answer (PR 8.5, src/llm/numCtx.ts) instead of always the largest allowed,
// and the window the model is already loaded with is kept when it fits.
//
// Every result carries the service worker's tasks for the request (PR 9.1):
// reading the settings, looking up the context size and the loaded window
// (only when those ran), building the prompt, the cache, waiting for the
// model, and parsing the answer. The content script lines them up with its
// own tasks for the popup's Details.
//
// The trace also carries every round trip to Ollama the request made (PR
// 9.2): the context size, the loaded window and the explanation itself, with
// the messages sent and the reply. A request made for Explain on hover is
// marked so, and a warm-up still loading the model when the request came is
// listed too, marked as the warm-up's. They are returned, never stored.
//
// A reasoning model is asked not to think (PR 9.5, `think: false`) unless the
// Let the model think setting is on. Whether the model can think comes from
// the same /api/show lookup as the context size, and is checked only when
// the model will run. Thinking the server returns in its own field is never
// part of the explanation; it comes back as `thinking`, for the Think row in
// Details.
//
// The window the model was last run with is remembered (PR 9.7,
// src/llm/loadedWindow.ts), so a warm click asks /api/ps only when that is
// not known: the first time, after the model or server changed, or after a
// request failed.

import {
  FALLBACK_CONTEXT_TOKENS,
  promptBudget,
  thinkOption,
  type ContextSizer,
  type ThinkingCheck,
} from '../llm/contextSize';
import { describeLlmError, llmErrorKind, type Platform } from '../llm/describeLlmError';
import { createRoundTripLog, type RoundTripLog, type RoundTripSink } from '../net/roundTrips';
import type { LoadedWindowMemory } from '../llm/loadedWindow';
import { chooseNumCtx } from '../llm/numCtx';
import type { ChatMessage, LlmClient, LlmErrorKind, LlmTimings } from '../llm/types';
import type { Settings } from '../settings';
import { cachedKind, explainCacheKey, type CachedKind, type ExplainCache } from './explainCache';
import type { FileContext, PrInfo } from './explainPrompt';
import { buildFittedExplainPrompt, type PromptReport } from './fitPrompt';
import { parseExplanation, type Explanation } from './parseExplanation';
import { PromptTooLargeError } from './tokenBudget';
import type { TraceTask, WorkerTrace } from '../trace/types';
import type { HunkPayload } from './hunkHandler';

export interface ExplainPayload {
  /** The context block from formatContext (src/lineContext.ts). */
  context: string;
  /**
   * The PR the line is in, such as "owner/repo#17". Without it the answer is
   * neither looked up in nor saved to the cache.
   */
  pr?: string;
  /** Skip the cache and ask the model again (the Regenerate button). */
  fresh?: boolean;
  /** The PR's title and description (PR 6.1), added to the prompt. */
  prInfo?: PrInfo;
  /** The block around the code in the full file (PR 6.3), added to the prompt. */
  fileContext?: FileContext;
  /** Why it was asked: a click (the default), Explain on hover (PR 8.7) or Explain ahead (PR 9.10). */
  cause?: 'click' | 'hover' | 'ahead';
  /** Groups this request's round trips with the click's in the debug log (PR 9.3). */
  debugId?: string;
  /**
   * For the background queue (PR 10.3, src/explain/prefetchQueue.ts): a name
   * for the line, such as "src/a.ts:added:12", and where it is in the PR.
   */
  job?: ExplainJobInfo;
  /**
   * Every changed line of a hunk to explain in one request (PR 10.5,
   * src/explain/hunkHandler.ts), for the background queue. `context` is then
   * the hunk's diff section.
   */
  hunk?: HunkPayload;
}

export interface ExplainJobInfo {
  label: string;
  order?: number;
  /**
   * For Explain ahead's whole-PR mode (PR 10.6): how near the screen the
   * code is. Only background priorities are taken.
   */
  priority?: 'on-screen' | 'near-screen' | 'rest';
}

/** The most file lines accepted, so a bad message cannot make a huge prompt. */
const MAX_FILE_CONTEXT_LINES = 2000;

/** `value` as a FileContext, or undefined when it is not one (it is never trusted). */
export function toFileContext(value: unknown): FileContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Partial<Record<keyof FileContext, unknown>>;
  const whole = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
  if (v.kind !== 'block' && v.kind !== 'window') return undefined;
  if (!whole(v.startLine) || !whole(v.focusStart) || !whole(v.focusEnd)) return undefined;
  if (!whole(v.headerLines) || v.startLine < 1 || v.focusEnd < v.focusStart) return undefined;
  const { lines } = v;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_FILE_CONTEXT_LINES) {
    return undefined;
  }
  if (!lines.every((l) => typeof l === 'string')) return undefined;
  return {
    kind: v.kind,
    startLine: v.startLine,
    lines: lines as string[],
    focusStart: v.focusStart,
    focusEnd: v.focusEnd,
    headerLines: v.headerLines,
  };
}

/** `value` as a PrInfo, or undefined when it is not one (it is never trusted). */
export function toPrInfo(value: unknown): PrInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { title, description } = value as Partial<Record<keyof PrInfo, unknown>>;
  if (typeof title !== 'string' || typeof description !== 'string') return undefined;
  return { title, description };
}

/** Set on an answer that came from the cache instead of the model. */
export interface CachedInfo {
  /** How long the model took to write it the first time. */
  elapsedMs: number;
  /** When it was saved (Date.now()). */
  savedAt: number;
  /** Written by Explain ahead rather than for a click or hover (PR 10.7). */
  prefetched?: true;
  /** What wrote it (PR 11.11). Left out for answers saved before it existed. */
  kind?: CachedKind;
}

export type ExplainResult =
  | {
      status: 'done';
      explanation: Explanation;
      model: string;
      cached?: CachedInfo;
      /**
       * The answer's cache key (PR 11.11), so a rating can name the answer
       * without its text. Left out when the answer is not cached.
       */
      key?: string;
      /** The prompt as sent, when the Show prompt setting is on. */
      prompt?: PromptReport;
      /** Where the server's time went (PR 8.1). Left out for a cached answer. */
      timings?: LlmTimings;
      /**
       * Thinking the model returned in its own field (PR 9.5), never shown as
       * the answer. Used to split Think from Write answer in Details.
       */
      thinking?: string;
      /** The service worker's tasks (PR 9.1). */
      trace?: WorkerTrace;
    }
  | {
      status: 'failed';
      message: string;
      fix: string;
      /** Why the model call failed, when it did (PR 11.6: tells Ollama is down). */
      kind?: LlmErrorKind;
      trace?: WorkerTrace;
    };

/** The message and fix for code too long for the model's context window. */
export function tooLargeError(
  error: PromptTooLargeError,
  contextTokens: number,
  maxResponseTokens: number,
): { message: string; fix: string } {
  return {
    message:
      `This code is too long for the model's context: the prompt needs about ` +
      `${error.needed} tokens, and a ${contextTokens}-token context with ` +
      `${maxResponseTokens} kept for the answer leaves ${Math.max(0, error.budget)}.`,
    fix:
      'Raise **Context size** or lower **Max response length** in the settings, ' +
      'or select fewer lines.',
  };
}

function promptText(messages: ChatMessage[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
}

export interface ExplainStreamOptions {
  /** Called with each piece of the reply as the model writes it. */
  onChunk?(text: string): void;
  /** Cancels the request (the popup's Stop button, or the popup closing). */
  signal?: AbortSignal;
}

export interface ExplainDeps {
  getSettings(): Promise<Settings>;
  /** `roundTrips` records each request the client makes (PR 9.2). */
  createClient(settings: Settings, options?: { roundTrips?: RoundTripLog }): LlmClient;
  platform: Platform;
  /** Leaving it out turns caching off. */
  cache?: ExplainCache;
  /** Clock in milliseconds. Tests pass a fake one. */
  now?: () => number;
  /**
   * The context window for these settings (src/llm/contextSize.ts). Without it,
   * the setting is used, or FALLBACK_CONTEXT_TOKENS when it is automatic.
   */
  contextTokens?: ContextSizer;
  /**
   * Whether the model can think and which `think` values it accepts
   * (PR 9.5), from the same lookup as
   * `contextTokens`. Without it, `think` is never sent.
   */
  thinking?: ThinkingCheck;
  /** The round trips of warm-ups still loading the model (src/llm/warmup.ts). */
  warmupRoundTrips?: () => RoundTripLog[];
  /** Gets each round trip as it starts, runs and ends, for the debug log (PR 9.3, 9.4). */
  onRoundTrip?: RoundTripSink;
  /**
   * The window the model was last run with (PR 9.7), shared with the chat and
   * the warm-up. Without it, /api/ps is asked before every explanation.
   */
  loadedWindow?: LoadedWindowMemory;
}

/** The context window when no ContextSizer is given. */
export const settingsContextTokens: ContextSizer = async (settings) =>
  settings.contextTokens > 0 ? settings.contextTokens : FALLBACK_CONTEXT_TOKENS;

/** The window the model is loaded with, or undefined when that is unknown. Never throws. */
async function loadedWindow(
  client: LlmClient,
  model: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  if (!model) return undefined;
  try {
    const tokens = await client.loadedContextTokens(model, { signal });
    return typeof tokens === 'number' ? tokens : undefined;
  } catch {
    // Not knowing only means the window may change; the request goes ahead.
    return undefined;
  }
}

/**
 * Records the service worker's tasks for one request, timed with `now` from
 * when the recorder was made.
 */
export function createTaskRecorder(now: () => number) {
  const origin = now();
  const tasks: TraceTask[] = [];
  const add = (key: string, label: string, start: number, extra: Partial<TraceTask> = {}) => {
    tasks.push({
      key,
      label,
      source: 'worker',
      startMs: start - origin,
      durationMs: Math.max(0, now() - start),
      ...extra,
    });
  };
  return {
    now,
    /** When the recorder was made, from `now`. */
    origin,
    /** Records a task that started at `start` (from `now`) and ends now. */
    add,
    /**
     * Runs `work` as a task. A task that throws is recorded as failed. When
     * `keep` returns false the task is not recorded (it did nothing worth
     * showing, such as a lookup answered from memory).
     */
    async time<T>(
      key: string,
      label: string,
      work: () => T | Promise<T>,
      keep: () => boolean = () => true,
    ): Promise<T> {
      const start = now();
      try {
        const value = await work();
        if (keep()) add(key, label, start);
        return value;
      } catch (error) {
        add(key, label, start, { status: 'failed' });
        throw error;
      }
    },
    trace: (): WorkerTrace => ({ tasks: [...tasks], totalMs: Math.max(0, now() - origin) }),
  };
}

export function createExplainHandler(deps: ExplainDeps) {
  return async (
    payload: ExplainPayload,
    { onChunk, signal }: ExplainStreamOptions = {},
  ): Promise<ExplainResult> => {
    if (typeof payload?.context !== 'string' || !payload.context.trim()) {
      throw new Error('explain needs a non-empty context');
    }
    const now = deps.now ?? Date.now;
    const tasks = createTaskRecorder(now);
    const cause = payload.cause === 'hover' || payload.cause === 'ahead' ? payload.cause : 'click';
    const roundTrips = createRoundTripLog(cause, now, {
      ...(typeof payload.debugId === 'string' && { group: payload.debugId.slice(0, 100) }),
      onUpdate: deps.onRoundTrip,
    });
    // A warm-up still running is what this request may wait behind.
    const warmups = deps.warmupRoundTrips?.() ?? [];
    const trace = (): WorkerTrace => ({
      ...tasks.trace(),
      roundTrips: [
        ...warmups.flatMap((log) => log.list(tasks.origin)),
        ...roundTrips.list(tasks.origin),
      ].sort((a, b) => a.startMs - b.startMs),
    });
    const settings = await tasks.time('settings', 'Read settings', () => deps.getSettings());
    const { cache } = deps;
    // Recorded only when the server was asked, not when the size was known.
    let lookedUp = false;
    const contextTokens = await tasks.time(
      'context-size',
      'Look up context size',
      () =>
        (deps.contextTokens ?? settingsContextTokens)(
          settings,
          signal,
          () => {
            lookedUp = true;
          },
          roundTrips,
        ),
      () => lookedUp,
    );
    const budget = promptBudget(contextTokens, settings.maxResponseTokens);
    const fitStart = now();
    let fitted;
    try {
      fitted = buildFittedExplainPrompt(
        payload.context,
        toPrInfo(payload.prInfo),
        budget,
        toFileContext(payload.fileContext),
      );
    } catch (error) {
      if (!(error instanceof PromptTooLargeError)) throw error;
      tasks.add('fit-prompt', 'Build the prompt', fitStart, { status: 'failed' });
      return {
        status: 'failed',
        ...tooLargeError(error, contextTokens, settings.maxResponseTokens),
        trace: trace(),
      };
    }
    const { messages } = fitted;
    const client = deps.createClient(settings, { roundTrips });
    // The window to run with: a set Context size as it is; on automatic,
    // just what this prompt needs, or the loaded model's window if it fits.
    const windowFor = (loaded?: number) =>
      settings.contextTokens > 0
        ? contextTokens
        : chooseNumCtx({
            promptTokens: fitted.tokens,
            answerTokens: settings.maxResponseTokens,
            limit: contextTokens,
            loaded,
          });
    const report = (numCtx: number): PromptReport | undefined =>
      settings.showPrompt
        ? {
            text: promptText(messages),
            tokens: fitted.tokens,
            budget,
            contextTokens: numCtx,
            trimmed: fitted.trimmed,
          }
        : undefined;
    // Everything that shapes the answer is in the key, so changing the model,
    // the temperature, the response limit, or the prompt is a miss.
    const key =
      cache && typeof payload.pr === 'string' && payload.pr && settings.model
        ? await explainCacheKey({
            pr: payload.pr,
            model: settings.model,
            temperature: settings.temperature,
            maxResponseTokens: settings.maxResponseTokens,
            messages,
            letModelThink: settings.letModelThink,
          })
        : null;
    tasks.add('fit-prompt', 'Build the prompt', fitStart);
    if (cache && key && payload.fresh !== true) {
      const hit = await tasks.time('cache', 'Check the cache', () =>
        cache.get(key).catch(() => null),
      );
      if (hit) {
        const prompt = report(windowFor());
        return {
          status: 'done',
          explanation: hit.explanation,
          model: hit.model,
          cached: {
            elapsedMs: hit.elapsedMs,
            savedAt: hit.savedAt,
            ...(hit.prefetched && { prefetched: true }),
            ...cachedKind(hit.kind),
          },
          key,
          ...(prompt && { prompt }),
          trace: trace(),
        };
      }
    }
    // Asked only when the model will run, so a cached answer costs no request,
    // and only when the last request did not already say (PR 9.7).
    const remembered = deps.loadedWindow?.known(settings);
    const numCtx =
      settings.contextTokens > 0
        ? contextTokens
        : windowFor(
            remembered ??
              (settings.model
                ? await tasks.time('loaded-window', 'Check loaded window', () =>
                    loadedWindow(client, settings.model, signal),
                  )
                : undefined),
          );
    // Usually known from the context size lookup, so this costs no round trip.
    let thinkLookedUp = false;
    const think = thinkOption(
      deps.thinking
        ? await tasks.time(
            'can-think',
            'Check if the model thinks',
            () =>
              deps.thinking!(
                settings,
                signal,
                () => {
                  thinkLookedUp = true;
                },
                roundTrips,
              ),
            () => thinkLookedUp,
          )
        : undefined,
      settings.letModelThink,
    );
    const prompt = report(numCtx);
    const startedAt = now();
    let firstChunkAt: number | undefined;
    let modelDone = false;
    const modelTask = (status?: 'failed') => {
      if (modelDone) return;
      modelDone = true;
      tasks.add('model', 'Wait for the model', startedAt, {
        ...(firstChunkAt !== undefined && { firstChunkMs: firstChunkAt - startedAt }),
        ...(status && { status }),
      });
    };
    // Taken as the request is sent, so an older request ending later cannot
    // overwrite what this one says.
    const windowTicket = deps.loadedWindow?.start(settings, numCtx);
    try {
      const stream = client.chatStream(messages, {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: settings.maxResponseTokens,
        contextTokens: numCtx,
        keepAliveMinutes: settings.keepAliveMinutes,
        ...(think !== undefined && { think }),
        signal,
      });
      let content = '';
      let next = await stream.next();
      while (!next.done) {
        if (next.value) firstChunkAt ??= now();
        content += next.value;
        onChunk?.(next.value);
        next = await stream.next();
      }
      modelTask();
      // The model is now loaded with this window.
      windowTicket?.done();
      const { model, timings, doneReason, thinking } = next.value;
      // "length" means the answer hit maxResponseTokens and stopped early.
      const explanation = await tasks.time('parse', 'Parse the answer', () =>
        parseExplanation(content, { cutOff: doneReason === 'length' }),
      );
      if (cache && key) {
        // A failed save only means the next click asks the model again.
        const elapsedMs = now() - startedAt;
        await tasks.time('cache-save', 'Save to the cache', () =>
          cache
            .set(
              key,
              {
                explanation,
                model,
                elapsedMs,
                savedAt: now(),
                ...(payload.cause === 'ahead' && { prefetched: true }),
                kind: cause,
              },
              payload.pr,
            )
            .catch(() => {}),
        );
      }
      return {
        status: 'done',
        explanation,
        model,
        ...(cache && key && { key }),
        ...(prompt && { prompt }),
        ...(timings && { timings }),
        ...(thinking && { thinking }),
        trace: trace(),
      };
    } catch (error) {
      modelTask('failed');
      // A failed or stopped request may not have loaded the model: ask next time.
      windowTicket?.failed();
      const { message, fix } = describeLlmError(error, {
        url: settings.llmUrl,
        model: settings.model,
        platform: deps.platform,
      });
      const kind = llmErrorKind(error);
      return { status: 'failed', message, fix, ...(kind && { kind }), trace: trace() };
    }
  };
}
