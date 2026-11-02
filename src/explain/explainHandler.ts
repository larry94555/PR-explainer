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

import { FALLBACK_CONTEXT_TOKENS, promptBudget, type ContextSizer } from '../llm/contextSize';
import { describeLlmError, type Platform } from '../llm/describeLlmError';
import type { ChatMessage, LlmClient, LlmTimings } from '../llm/types';
import type { Settings } from '../settings';
import { explainCacheKey, type ExplainCache } from './explainCache';
import type { FileContext, PrInfo } from './explainPrompt';
import { buildFittedExplainPrompt, type PromptReport } from './fitPrompt';
import { parseExplanation, type Explanation } from './parseExplanation';
import { PromptTooLargeError } from './tokenBudget';

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
}

export type ExplainResult =
  | {
      status: 'done';
      explanation: Explanation;
      model: string;
      cached?: CachedInfo;
      /** The prompt as sent, when the Show prompt setting is on. */
      prompt?: PromptReport;
      /** Where the server's time went (PR 8.1). Left out for a cached answer. */
      timings?: LlmTimings;
    }
  | { status: 'failed'; message: string; fix: string };

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
  createClient(settings: Settings): LlmClient;
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
}

/** The context window when no ContextSizer is given. */
export const settingsContextTokens: ContextSizer = async (settings) =>
  settings.contextTokens > 0 ? settings.contextTokens : FALLBACK_CONTEXT_TOKENS;

export function createExplainHandler(deps: ExplainDeps) {
  return async (
    payload: ExplainPayload,
    { onChunk, signal }: ExplainStreamOptions = {},
  ): Promise<ExplainResult> => {
    if (typeof payload?.context !== 'string' || !payload.context.trim()) {
      throw new Error('explain needs a non-empty context');
    }
    const settings = await deps.getSettings();
    const now = deps.now ?? Date.now;
    const { cache } = deps;
    const contextTokens = await (deps.contextTokens ?? settingsContextTokens)(settings, signal);
    const budget = promptBudget(contextTokens, settings.maxResponseTokens);
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
      return {
        status: 'failed',
        ...tooLargeError(error, contextTokens, settings.maxResponseTokens),
      };
    }
    const { messages } = fitted;
    const prompt: PromptReport | undefined = settings.showPrompt
      ? {
          text: promptText(messages),
          tokens: fitted.tokens,
          budget,
          contextTokens,
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
          })
        : null;
    if (cache && key && payload.fresh !== true) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) {
        return {
          status: 'done',
          explanation: hit.explanation,
          model: hit.model,
          cached: { elapsedMs: hit.elapsedMs, savedAt: hit.savedAt },
          ...(prompt && { prompt }),
        };
      }
    }
    const startedAt = now();
    try {
      const stream = deps.createClient(settings).chatStream(messages, {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: settings.maxResponseTokens,
        contextTokens,
        signal,
      });
      let content = '';
      let next = await stream.next();
      while (!next.done) {
        content += next.value;
        onChunk?.(next.value);
        next = await stream.next();
      }
      const explanation = parseExplanation(content);
      const { model, timings } = next.value;
      if (cache && key) {
        // A failed save only means the next click asks the model again.
        await cache
          .set(key, { explanation, model, elapsedMs: now() - startedAt, savedAt: now() })
          .catch(() => {});
      }
      return {
        status: 'done',
        explanation,
        model,
        ...(prompt && { prompt }),
        ...(timings && { timings }),
      };
    } catch (error) {
      const { message, fix } = describeLlmError(error, {
        url: settings.llmUrl,
        model: settings.model,
        platform: deps.platform,
      });
      return { status: 'failed', message, fix };
    }
  };
}
