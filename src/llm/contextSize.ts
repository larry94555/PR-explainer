// The context window to run the model with (PR 6.2): the user's Context size
// setting, or, when that is 0 (automatic), what the model's own settings ask
// for, else its trained size, capped at AUTO_CONTEXT_TOKENS. Every request
// passes the result to Ollama as num_ctx, so explanations and chat run with
// the same window (a change of window makes Ollama reload the model) and the
// prompt budget matches what the model really gets.
//
// Automatic sizes are looked up once per server and model with /api/show and
// remembered while the service worker runs. A failed lookup is not
// remembered: the request goes ahead with the fallback, and the next one
// asks again.

import type { Settings } from '../settings';
import type { LlmClient } from './types';

/**
 * The most an automatic size uses. Bigger windows cost memory and time on a
 * laptop; users who want more can set it.
 */
export const AUTO_CONTEXT_TOKENS = 4096;

/** Used when the server cannot say: Ollama's own default for most models. */
export const FALLBACK_CONTEXT_TOKENS = 4096;

/** Room left for the reply's framing and the estimate's rough edges. */
export const PROMPT_MARGIN_TOKENS = 32;

export type ContextSizer = (settings: Settings, signal?: AbortSignal) => Promise<number>;

export function createContextSizer(createClient: (settings: Settings) => LlmClient): ContextSizer {
  const known = new Map<string, number>();
  return async (settings, signal) => {
    if (settings.contextTokens > 0) return settings.contextTokens;
    const key = `${settings.llmUrl} ${settings.model}`;
    const remembered = known.get(key);
    if (remembered !== undefined) return remembered;
    try {
      const { maxTokens, configuredTokens } = await createClient(settings).modelContext(
        settings.model,
        { signal },
      );
      const size = Math.min(
        configuredTokens ?? AUTO_CONTEXT_TOKENS,
        maxTokens ?? Number.POSITIVE_INFINITY,
      );
      known.set(key, size);
      return size;
    } catch {
      return FALLBACK_CONTEXT_TOKENS;
    }
  };
}

/** The tokens a prompt may use in a `contextTokens` window with room for the reply. */
export function promptBudget(contextTokens: number, maxResponseTokens: number): number {
  return contextTokens - maxResponseTokens - PROMPT_MARGIN_TOKENS;
}
