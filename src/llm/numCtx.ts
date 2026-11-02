// The context window (Ollama's num_ctx) to run one explanation with (PR 8.5).
//
// A smaller window uses less memory, so more of the model fits on the GPU
// and less time goes into setting up the window. But Ollama reloads the
// model whenever num_ctx changes, which costs seconds and throws away the
// prompt it has cached. So the window is not cut to the exact size of each
// prompt: it is rounded up to a power of two (2048, 4096, ...), and when the
// model is already loaded with a window big enough for this prompt, that
// window is used as it is.
//
// This only applies when Context size is automatic. A size the user set is
// always sent as it is.

import { PROMPT_MARGIN_TOKENS } from './contextSize';

/** The smallest window used: enough for most explanations, so the size seldom changes. */
export const MIN_NUM_CTX = 2048;

export interface NumCtxInput {
  /** Estimated tokens in the prompt. */
  promptTokens: number;
  /** The longest answer allowed (num_predict). */
  answerTokens: number;
  /** The largest window allowed: the automatic context size, within the model's limit. */
  limit: number;
  /** The window the model is loaded with now, from /api/ps, if it is loaded. */
  loaded?: number;
}

/** The tokens a request needs: prompt, answer, and the margin promptBudget leaves. */
export function neededTokens(promptTokens: number, answerTokens: number): number {
  return promptTokens + answerTokens + PROMPT_MARGIN_TOKENS;
}

/** The smallest power of two that is at least `n` and at least MIN_NUM_CTX. */
export function roundUpWindow(n: number): number {
  let size = MIN_NUM_CTX;
  while (size < n) size *= 2;
  return size;
}

/**
 * The num_ctx for a request: the loaded window when it already fits (so the
 * model is not reloaded), else what the prompt and answer need rounded up,
 * never more than `limit`.
 */
export function chooseNumCtx({ promptTokens, answerTokens, limit, loaded }: NumCtxInput): number {
  const needed = neededTokens(promptTokens, answerTokens);
  if (loaded !== undefined && loaded >= needed && loaded <= limit) return loaded;
  return Math.min(limit, roundUpWindow(needed));
}

/** The window to load the model with ahead of the first click (PR 8.3's warm-up). */
export function startingNumCtx(limit: number): number {
  return Math.min(limit, MIN_NUM_CTX);
}
