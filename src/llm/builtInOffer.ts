// When Ollama is not running and Chrome's built-in model is ready (PR 11.13),
// a failed explanation offers to use the built-in model instead: the service
// worker marks the result with `offer`, and the popup shows a button that
// sets Model server to Chrome built-in and asks again.
//
// Whether the built-in model is ready is asked at most once every
// AVAILABILITY_TTL_MS, since asking may open the offscreen document
// (src/llm/offscreenAi.ts) and clicks while Ollama is down come quickly.

import type { ModelServer } from '../settings';
import type { BuiltInAvailability } from './chromeAiClient';
import type { LlmErrorKind } from './types';

export const AVAILABILITY_TTL_MS = 30_000;

export interface BuiltInOfferDeps {
  modelServer(): Promise<ModelServer>;
  availability(): Promise<BuiltInAvailability>;
  /** Clock in milliseconds. Tests pass a fake one. */
  now?: () => number;
}

interface FailedLike {
  status: string;
  kind?: LlmErrorKind;
}

export type WithOffer<R> = R & { offer?: 'chrome-built-in' };

/** Adds the offer to a result that failed because Ollama is not running, when it applies. */
export function createBuiltInOffer(deps: BuiltInOfferDeps) {
  const now = deps.now ?? Date.now;
  let known: { state: BuiltInAvailability; at: number } | undefined;
  const availability = async () => {
    if (known && now() - known.at < AVAILABILITY_TTL_MS) return known.state;
    const state = await deps.availability().catch(() => 'unsupported' as const);
    known = { state, at: now() };
    return state;
  };
  return async <R extends FailedLike>(result: R): Promise<WithOffer<R>> => {
    if (result.status !== 'failed' || result.kind !== 'connection') return result;
    if ((await deps.modelServer().catch(() => 'chrome')) !== 'ollama') return result;
    return (await availability()) === 'available'
      ? { ...result, offer: 'chrome-built-in' }
      : result;
  };
}
