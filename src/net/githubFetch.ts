// The only way the content script reaches the network (PR 7.4). It reads a
// PR's description and files from GitHub, with the user's GitHub cookies, and
// nothing else: a request to any other address is refused before it is sent,
// and redirects are refused too, since the browser would follow one to an
// address this guard never saw.
// The content script never talks to the LLM; that goes through the service
// worker and src/net/llmFetch.ts.
//
// This file must not be imported by the service worker or the options page:
// content.js is a classic script and cannot load a shared chunk (see
// src/content.ts), so each side has its own guard.
//
// Every request, sent or refused, is recorded as a round trip (PR 9.2) in a
// GithubRoundTrips log, with the same shape as the service worker's (src/net/
// roundTrips.ts, which this side cannot import). A click picks out the ones
// it waited on.

import type { RoundTrip, RoundTripStatus } from '../trace/types';

/** GitHub's API, which the content script may use for one thing only (API_PATH). */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** The one API address allowed: a page of a PR's changed files. */
export const API_PATH = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/;

/** The only places the content script may fetch from. */
export const GITHUB_ORIGINS: readonly string[] = [
  'https://github.com',
  // Where public files are read from (src/fileContext.ts).
  'https://raw.githubusercontent.com',
  // The list of a PR's changed files and their diffs (src/patchRequests.ts,
  // PR 10.4), and nothing else on the API: see API_PATH.
  GITHUB_API_ORIGIN,
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
  if (!GITHUB_ORIGINS.includes(parsed.origin) || parsed.username || parsed.password) return null;
  if (parsed.origin === GITHUB_API_ORIGIN && !API_PATH.test(parsed.pathname)) return null;
  return parsed;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A guarded fetch; `purpose` says why, for its round trip (such as "file at head"). */
export type GithubFetch = (
  input: string,
  init?: RequestInit,
  purpose?: string,
) => Promise<Response>;

/** The most round trips kept; older ones are no longer of use to a click. */
const MAX_ROUND_TRIPS = 50;

interface Entry {
  trip: RoundTrip;
  /** From the log's clock. */
  startedAt: number;
}

/** The content script's GitHub round trips (PR 9.2), kept for the page only. */
export interface GithubRoundTrips {
  /** Clock in milliseconds. */
  now(): number;
  /** Sends `url` with `send` and records it. */
  record(url: string, purpose: string, send: () => Promise<Response>): Promise<Response>;
  /** Records a request refused before it was sent. */
  refuse(url: string, purpose: string, error: unknown): void;
  /**
   * The round trips a click that started at `since` (from `now`) waited on,
   * timed from it: those it started, and those still running when it came
   * (marked "page"). Ones that ended before it are left out.
   */
  since(since: number, until?: number): RoundTrip[];
}

function isAbort(error: unknown, init?: RequestInit): boolean {
  return (
    init?.signal?.aborted === true ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

export function createGithubRoundTrips(
  now: () => number = () => performance.now(),
): GithubRoundTrips {
  const entries: Entry[] = [];
  const end = (entry: Entry, status: RoundTripStatus, error?: unknown) => {
    if (entry.trip.status !== 'running') return;
    entry.trip.status = status;
    entry.trip.durationMs = Math.max(0, now() - entry.startedAt);
    if (error !== undefined) {
      entry.trip.error = error instanceof Error ? error.message : String(error);
    }
  };
  // The response with its body counted as it is read, so the round trip
  // ends when the caller has read it all (as src/net/roundTrips.ts does).
  const watch = (entry: Entry, response: Response): Response => {
    const status = response.ok ? 'done' : 'failed';
    if (!response.ok) entry.trip.error = `HTTP ${response.status}`;
    if (!response.body) {
      end(entry, status);
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          end(entry, isAbort(error) ? 'cancelled' : 'failed', error);
          controller.error(error);
          return;
        }
        if (chunk.done) {
          end(entry, status);
          controller.close();
          return;
        }
        entry.trip.bytesReceived += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        end(entry, 'cancelled', reason ?? 'The reply was not read to the end.');
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const begin = (url: string, purpose: string): Entry => {
    let endpoint = url;
    try {
      const parsed = new URL(url);
      endpoint = parsed.host + parsed.pathname;
    } catch {
      // Kept as it was given.
    }
    const entry: Entry = {
      startedAt: now(),
      trip: {
        target: 'github',
        method: 'GET',
        endpoint,
        purpose,
        cause: 'click',
        startMs: 0,
        durationMs: 0,
        status: 'running',
        bytesSent: 0,
        bytesReceived: 0,
      },
    };
    entries.push(entry);
    if (entries.length > MAX_ROUND_TRIPS) entries.shift();
    return entry;
  };

  return {
    now,
    record(url, purpose, send) {
      const entry = begin(url, purpose);
      return send().then(
        (response) => {
          entry.trip.httpStatus = response.status;
          return watch(entry, response);
        },
        (failure: unknown) => {
          end(entry, isAbort(failure) ? 'cancelled' : 'failed', failure);
          throw failure;
        },
      );
    },
    refuse(url, purpose, error) {
      end(begin(url, purpose), 'refused', error);
    },
    since(since, until = now()) {
      return entries
        .filter(
          ({ trip, startedAt }) =>
            startedAt <= until &&
            (trip.status === 'running' || startedAt + trip.durationMs >= since),
        )
        .map(({ trip, startedAt }) => ({
          ...trip,
          cause: startedAt < since ? ('page' as const) : ('click' as const),
          startMs: startedAt - since,
          durationMs: trip.status === 'running' ? Math.max(0, now() - startedAt) : trip.durationMs,
        }));
    },
  };
}

/**
 * Wraps `baseFetch` (the global fetch by default) so it only reaches GitHub.
 * `pageUrl` resolves relative paths; it defaults to the page's address.
 * Each request, sent or refused, is recorded in `roundTrips` when given.
 */
export function createGithubFetch(
  baseFetch: FetchLike = (input, init) => fetch(input, init),
  pageUrl: () => string = () => location.href,
  roundTrips?: GithubRoundTrips,
): GithubFetch {
  return async (input, init, purpose = 'GitHub') => {
    const url = allowedGithubUrl(input, pageUrl());
    if (!url) {
      const error = new BlockedRequestError(input);
      roundTrips?.refuse(input, purpose, error);
      throw error;
    }
    // A redirect fails the request instead of being followed (PR 7.4 review).
    // The API is read without the user's GitHub sign-in (PR 10.4).
    const send = () =>
      baseFetch(url.href, {
        ...init,
        ...(url.origin === GITHUB_API_ORIGIN && { credentials: 'omit' as const }),
        redirect: 'error',
      });
    return roundTrips ? roundTrips.record(url.href, purpose, send) : send();
  };
}
