// The only way the content script reaches the network (PR 7.4). It reads a
// PR's description and files from GitHub, with the user's GitHub cookies, and
// nothing else: a request to any other address is refused before it is sent.
// The content script never talks to the LLM; that goes through the service
// worker and src/net/llmFetch.ts.
//
// This file must not be imported by the service worker or the options page:
// content.js is a classic script and cannot load a shared chunk (see
// src/content.ts), so each side has its own guard.

/** The only places the content script may fetch from. */
export const GITHUB_ORIGINS: readonly string[] = [
  'https://github.com',
  // Where github.com/<owner>/<repo>/raw/... redirects, and where public files
  // are read from directly (src/fileContext.ts).
  'https://raw.githubusercontent.com',
];

/** Thrown, before anything is sent, for a request to an address not allowed. */
export class BlockedRequestError extends Error {
  override name = 'BlockedRequestError';
  constructor(readonly url: string) {
    super(`PR Explainer refused to send a request to ${url}: only GitHub is allowed here.`);
  }
}

/**
 * The origin `url` points at, resolved against `base` (the page's address,
 * so "/owner/repo/pull/1" is github.com), if it is one of `allowed`.
 */
export function allowedGithubUrl(url: string, base: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return null;
  }
  return GITHUB_ORIGINS.includes(parsed.origin) && !parsed.username && !parsed.password
    ? parsed
    : null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Wraps `baseFetch` (the global fetch by default) so it only reaches GitHub.
 * `pageUrl` resolves relative paths; it defaults to the page's address.
 */
export function createGithubFetch(
  baseFetch: FetchLike = (input, init) => fetch(input, init),
  pageUrl: () => string = () => location.href,
): FetchLike {
  return async (input, init) => {
    const url = allowedGithubUrl(input, pageUrl());
    if (!url) throw new BlockedRequestError(input);
    return baseFetch(url.href, init);
  };
}
