// The only way the service worker and the options page reach the network
// (PR 7.4): every request goes to the LLM server the user set, and that
// server must be on this computer. A request to any other address is refused
// before it is sent, so code from a PR cannot leave the laptop even if a bug
// built the wrong URL or a bad URL got into storage.
//
// Not imported by the content script (see src/net/githubFetch.ts).

import { LlmError } from '../llm/types';
import { isLocalHostname } from '../settings';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The origin of `llmUrl`, such as "http://localhost:11434", if it is on this computer. */
export function localLlmOrigin(llmUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(llmUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return isLocalHostname(url.hostname) ? url.origin : null;
}

/**
 * Wraps `baseFetch` (the global fetch by default) so it only reaches the LLM
 * server at `llmUrl`. Anything else rejects with LlmError "blocked".
 */
export function createLlmFetch(
  llmUrl: string,
  baseFetch: FetchLike = (input, init) => fetch(input, init),
): FetchLike {
  const origin = localLlmOrigin(llmUrl);
  return async (input, init) => {
    let target: URL | null = null;
    try {
      target = new URL(input);
    } catch {
      // Refused below.
    }
    if (!origin || !target || target.origin !== origin || target.username || target.password) {
      throw new LlmError(
        'blocked',
        origin
          ? `Refused to send a request to ${input}: only ${origin} is allowed.`
          : `Refused to send code to ${llmUrl}: the LLM must run on this computer.`,
      );
    }
    return baseFetch(target.href, init);
  };
}
