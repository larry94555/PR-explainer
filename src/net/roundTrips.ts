// The service worker's round trips to Ollama (PR 9.2). Every request it
// makes goes through src/net/llmFetch.ts, which records each one in a
// RoundTripLog when it is given one: where it went, why, when it started and
// how long it took (until the whole reply was read), its status, and the
// bytes sent and received. For /api/chat it also keeps the messages sent and
// the reply, put together from the stream's pieces.
//
// One log is made per request from the content script (an explanation, or a
// warm-up), so its round trips are tied to the click or cause that made
// them. Logs live only as long as that request: nothing is stored here. With
// the Debug window setting on, each round trip is also handed to the debug
// log (src/debug/debugLog.ts, PR 9.3) through `onUpdate`: as it starts, as
// its reply grows (at most every PROGRESS_MS, for the debug window, PR 9.4),
// and as it ends.
//
// Not imported by the content script, which records its GitHub round trips
// in src/net/githubFetch.ts with the same shape (src/trace/types.ts): the two
// sides cannot share code (see src/content.ts).

import { readTimings } from '../llm/ollamaClient';
import type { LlmTimings } from '../llm/types';
import type { RoundTrip, RoundTripCause, RoundTripStatus } from '../trace/types';

/** How often a running round trip's reply so far is handed to `onUpdate`. */
export const PROGRESS_MS = 250;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Why the service worker asks `path`, for a request made because of `cause`. */
export function purposeOf(path: string, cause: RoundTripCause): string {
  switch (path) {
    case '/api/show':
      // The context size and, from PR 9.5, whether the model can think.
      return 'model details';
    case '/api/ps':
      return cause === 'warmup' ? 'is the model loaded' : 'loaded window';
    case '/api/chat':
      if (cause === 'warmup') return 'load the model';
      return cause === 'chat' ? 'chat answer' : 'explanation';
    case '/api/tags':
      return 'list models';
    default:
      return path;
  }
}

/** One round trip as it is being recorded. */
interface Entry {
  trip: RoundTrip;
  /** From the log's clock. */
  startedAt: number;
  /** The reply's text, kept for /api/chat only. */
  body?: string;
  /** When onUpdate last heard about it, from the log's clock. */
  toldAt?: number;
}

/**
 * Called with each round trip as it starts and while it runs (status
 * "running", PR 9.4), and once as it ends (PR 9.3), timed from the log's
 * origin. Every call for one round trip has the same `trip.id`.
 */
export type RoundTripSink = (trip: RoundTrip, log: RoundTripLog) => void;

export interface RoundTripLogOptions {
  /** Ties the round trips to one click or cause; a new id when left out. */
  group?: string;
  onUpdate?: RoundTripSink;
}

export interface RoundTripLog {
  readonly cause: RoundTripCause;
  /** Ties this log's round trips together in the debug log (PR 9.3). */
  readonly group: string;
  /** When the log was made, from its clock. */
  readonly origin: number;
  /** Sends `url` with `send` and records it. */
  record(
    url: string,
    init: RequestInit | undefined,
    send: () => Promise<Response>,
  ): Promise<Response>;
  /** Records a request refused before it was sent. */
  refuse(url: string, init: RequestInit | undefined, error: unknown): void;
  /** The round trips so far, timed from `origin` (default: when the log was made). */
  list(origin?: number): RoundTrip[];
}

function endpointOf(url: string): { endpoint: string; path: string } {
  try {
    const parsed = new URL(url);
    return { endpoint: parsed.host + parsed.pathname, path: parsed.pathname };
  } catch {
    return { endpoint: url, path: url };
  }
}

/** The bytes of a request body sent as text (the only kind sent here). */
function sizeOf(body: RequestInit['body']): number {
  return typeof body === 'string' ? new TextEncoder().encode(body).length : 0;
}

/** The messages of a /api/chat body, or undefined when it has none. */
function messagesOf(body: RequestInit['body']): RoundTrip['messages'] {
  if (typeof body !== 'string') return undefined;
  try {
    const { messages } = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    return messages.map((m: unknown) => {
      const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
      return { role: String(role), content: typeof content === 'string' ? content : '' };
    });
  } catch {
    return undefined;
  }
}

/** The `think` field of a /api/chat body (PR 9.5), or undefined when it has none. */
function thinkOf(body: RequestInit['body']): boolean | string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const { think } = JSON.parse(body) as { think?: unknown };
    return typeof think === 'boolean' || typeof think === 'string' ? think : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reply and thinking in a /api/chat body: one JSON object, or a stream
 * of them, one per line, each with a piece of `message.content` (and
 * `message.thinking` when Ollama returns thinking in its own field).
 */
export function chatReplyOf(body: string): {
  reply: string;
  thinking: string;
  timings?: LlmTimings;
} {
  let reply = '';
  let thinking = '';
  let timings: LlmTimings | undefined;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        message?: { content?: unknown; thinking?: unknown };
        done?: unknown;
      };
      const { message } = parsed;
      if (typeof message?.content === 'string') reply += message.content;
      if (typeof message?.thinking === 'string') thinking += message.thinking;
      // The last line says where Ollama's time went (PR 9.4).
      if (parsed.done === true) timings = readTimings(parsed);
    } catch {
      // A line cut off mid-reply: the rest is still worth showing.
    }
  }
  return { reply, thinking, ...(timings && { timings }) };
}

/** Whether a streamed /api/chat body has its last line, the one with "done": true. */
function endsStream(body: string): boolean {
  const lines = body.split('\n');
  // The text after the last newline may still be cut off.
  lines.pop();
  return lines.some((line) => {
    if (!/"done"\s*:\s*true/.test(line)) return false;
    try {
      return (JSON.parse(line) as { done?: unknown }).done === true;
    } catch {
      return false;
    }
  });
}

function isAbort(error: unknown, init: RequestInit | undefined): boolean {
  return (
    init?.signal?.aborted === true ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A new id for a group of round trips. */
export function newGroupId(): string {
  return crypto.randomUUID();
}

export function createRoundTripLog(
  cause: RoundTripCause,
  now: () => number = Date.now,
  { group = newGroupId(), onUpdate }: RoundTripLogOptions = {},
): RoundTripLog {
  const origin = now();
  const entries: Entry[] = [];
  let count = 0;

  /** Hands the round trip, as it is now, to onUpdate. */
  const tell = (entry: Entry) => {
    if (!onUpdate) return;
    const running = entry.trip.status === 'running';
    const trip: RoundTrip = {
      ...entry.trip,
      startMs: entry.startedAt - origin,
      ...(running && { durationMs: Math.max(0, now() - entry.startedAt) }),
    };
    if (running && entry.body) {
      const { reply, thinking } = chatReplyOf(entry.body);
      if (reply) trip.reply = reply;
      if (thinking) trip.thinking = thinking;
    }
    entry.toldAt = now();
    try {
      // `log` is made below; a round trip can only start after that.
      onUpdate(trip, log);
    } catch {
      // The debug log must never break a request.
    }
  };

  const begin = (url: string, init: RequestInit | undefined): Entry => {
    const { endpoint, path } = endpointOf(url);
    const isChat = path === '/api/chat';
    const messages = isChat ? messagesOf(init?.body) : undefined;
    const think = isChat ? thinkOf(init?.body) : undefined;
    const entry: Entry = {
      startedAt: now(),
      trip: {
        id: `${group}:${++count}`,
        target: 'ollama',
        method: init?.method ?? 'GET',
        endpoint,
        purpose: purposeOf(path, cause),
        cause,
        startMs: 0,
        durationMs: 0,
        status: 'running',
        bytesSent: sizeOf(init?.body),
        bytesReceived: 0,
        ...(messages && { messages }),
        ...(think !== undefined && { think }),
      },
      ...(isChat && { body: '' }),
    };
    entries.push(entry);
    tell(entry);
    return entry;
  };

  const end = (entry: Entry, status: RoundTripStatus, error?: unknown) => {
    if (entry.trip.status !== 'running') return;
    entry.trip.status = status;
    entry.trip.durationMs = Math.max(0, now() - entry.startedAt);
    if (error !== undefined) entry.trip.error = messageOf(error);
    if (entry.body !== undefined) {
      const { reply, thinking, timings } = chatReplyOf(entry.body);
      if (reply) entry.trip.reply = reply;
      if (thinking) entry.trip.thinking = thinking;
      if (timings) entry.trip.timings = timings;
    }
    tell(entry);
  };

  /**
   * The same response with its body counted as it is read, so the round
   * trip ends when the caller has read the whole reply, or cancelled it
   * (Stop, or the popup closing).
   */
  const watch = (entry: Entry, response: Response, init: RequestInit | undefined): Response => {
    const status = response.ok ? 'done' : 'failed';
    if (!response.ok) entry.trip.error = `HTTP ${response.status}`;
    if (!response.body) {
      end(entry, status);
      return response;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          end(entry, isAbort(error, init) ? 'cancelled' : 'failed', error);
          controller.error(error);
          return;
        }
        if (chunk.done) {
          if (entry.body !== undefined) entry.body += decoder.decode();
          end(entry, status);
          controller.close();
          return;
        }
        entry.trip.bytesReceived += chunk.value.byteLength;
        if (entry.body !== undefined) {
          entry.body += decoder.decode(chunk.value, { stream: true });
          // The client stops reading at the stream's last line, so that is
          // where the round trip ends, even if the connection closes later.
          if (endsStream(entry.body)) end(entry, status);
          else if (now() - (entry.toldAt ?? 0) >= PROGRESS_MS) tell(entry);
        }
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

  const log: RoundTripLog = {
    cause,
    group,
    origin,
    async record(url, init, send) {
      const entry = begin(url, init);
      let response: Response;
      try {
        response = await send();
      } catch (error) {
        end(entry, isAbort(error, init) ? 'cancelled' : 'failed', error);
        throw error;
      }
      entry.trip.httpStatus = response.status;
      return watch(entry, response, init);
    },
    refuse(url, init, error) {
      end(begin(url, init), 'refused', error);
    },
    list(from = origin) {
      return entries.map(({ trip, startedAt }) => ({
        ...trip,
        startMs: startedAt - from,
        durationMs: trip.status === 'running' ? Math.max(0, now() - startedAt) : trip.durationMs,
      }));
    },
  };
  return log;
}
