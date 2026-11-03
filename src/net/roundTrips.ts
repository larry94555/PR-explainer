// The service worker's round trips to Ollama (PR 9.2). Every request it
// makes goes through src/net/llmFetch.ts, which records each one in a
// RoundTripLog when it is given one: where it went, why, when it started and
// how long it took (until the whole reply was read), its status, and the
// bytes sent and received. For /api/chat it also keeps the messages sent and
// the reply, put together from the stream's pieces.
//
// One log is made per request from the content script (an explanation, or a
// warm-up), so its round trips are tied to the click or cause that made
// them. Logs live only as long as that request: nothing is stored.
//
// Not imported by the content script, which records its GitHub round trips
// in src/net/githubFetch.ts with the same shape (src/trace/types.ts): the two
// sides cannot share code (see src/content.ts).

import type { RoundTrip, RoundTripCause, RoundTripStatus } from '../trace/types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Why the service worker asks `path`, for a request made because of `cause`. */
export function purposeOf(path: string, cause: RoundTripCause): string {
  switch (path) {
    case '/api/show':
      return 'context size';
    case '/api/ps':
      return cause === 'warmup' ? 'is the model loaded' : 'loaded window';
    case '/api/chat':
      return cause === 'warmup' ? 'load the model' : 'explanation';
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
}

export interface RoundTripLog {
  readonly cause: RoundTripCause;
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

/**
 * The reply and thinking in a /api/chat body: one JSON object, or a stream
 * of them, one per line, each with a piece of `message.content` (and
 * `message.thinking` when Ollama returns thinking in its own field).
 */
export function chatReplyOf(body: string): { reply: string; thinking: string } {
  let reply = '';
  let thinking = '';
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const { message } = JSON.parse(line) as {
        message?: { content?: unknown; thinking?: unknown };
      };
      if (typeof message?.content === 'string') reply += message.content;
      if (typeof message?.thinking === 'string') thinking += message.thinking;
    } catch {
      // A line cut off mid-reply: the rest is still worth showing.
    }
  }
  return { reply, thinking };
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

export function createRoundTripLog(
  cause: RoundTripCause,
  now: () => number = Date.now,
): RoundTripLog {
  const origin = now();
  const entries: Entry[] = [];

  const begin = (url: string, init: RequestInit | undefined): Entry => {
    const { endpoint, path } = endpointOf(url);
    const isChat = path === '/api/chat';
    const messages = isChat ? messagesOf(init?.body) : undefined;
    const entry: Entry = {
      startedAt: now(),
      trip: {
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
      },
      ...(isChat && { body: '' }),
    };
    entries.push(entry);
    return entry;
  };

  const end = (entry: Entry, status: RoundTripStatus, error?: unknown) => {
    if (entry.trip.status !== 'running') return;
    entry.trip.status = status;
    entry.trip.durationMs = Math.max(0, now() - entry.startedAt);
    if (error !== undefined) entry.trip.error = messageOf(error);
    if (entry.body !== undefined) {
      const { reply, thinking } = chatReplyOf(entry.body);
      if (reply) entry.trip.reply = reply;
      if (thinking) entry.trip.thinking = thinking;
    }
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

  return {
    cause,
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
}
