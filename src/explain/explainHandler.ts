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

import { describeLlmError, type Platform } from '../llm/describeLlmError';
import type { LlmClient } from '../llm/types';
import type { Settings } from '../settings';
import { explainCacheKey, type ExplainCache } from './explainCache';
import { buildExplainPrompt } from './explainPrompt';
import { parseExplanation, type Explanation } from './parseExplanation';

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
}

/** Set on an answer that came from the cache instead of the model. */
export interface CachedInfo {
  /** How long the model took to write it the first time. */
  elapsedMs: number;
  /** When it was saved (Date.now()). */
  savedAt: number;
}

export type ExplainResult =
  | { status: 'done'; explanation: Explanation; model: string; cached?: CachedInfo }
  | { status: 'failed'; message: string; fix: string };

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
}

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
    const key =
      cache && typeof payload.pr === 'string' && payload.pr && settings.model
        ? await explainCacheKey({ pr: payload.pr, model: settings.model, context: payload.context })
        : null;
    if (cache && key && payload.fresh !== true) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) {
        return {
          status: 'done',
          explanation: hit.explanation,
          model: hit.model,
          cached: { elapsedMs: hit.elapsedMs, savedAt: hit.savedAt },
        };
      }
    }
    const startedAt = now();
    try {
      const stream = deps.createClient(settings).chatStream(buildExplainPrompt(payload.context), {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: settings.maxResponseTokens,
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
      const model = next.value.model;
      if (cache && key) {
        // A failed save only means the next click asks the model again.
        await cache
          .set(key, { explanation, model, elapsedMs: now() - startedAt, savedAt: now() })
          .catch(() => {});
      }
      return { status: 'done', explanation, model };
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
