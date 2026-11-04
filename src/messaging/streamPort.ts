// Service worker side of the stream ports (see ExplainPortName and
// ChatPortName in protocol.ts): runs one request per port, forwards each
// piece of the reply as it arrives, and aborts the request when the content
// script disconnects (Stop button, popup or chat panel closed, tab closed or
// reloaded).

import type { ChatPayload, ChatResult, ChatStreamOptions } from '../chat/chatHandler';
import type {
  ExplainJobInfo,
  ExplainPayload,
  ExplainResult,
  ExplainStreamOptions,
} from '../explain/explainHandler';
import type {
  ChatPortName,
  ExplainPortName,
  PortLike,
  PortRuntime,
  StreamPortMessage,
} from './protocol';

export const EXPLAIN_PORT: ExplainPortName = 'pr-explainer:explain';
export const CHAT_PORT: ChatPortName = 'pr-explainer:chat';

export type StreamingExplain = (
  payload: ExplainPayload,
  /** `tab` is the tab that asked, for the background queue (PR 10.3). */
  options: ExplainStreamOptions & { tab?: number },
) => Promise<ExplainResult>;

export type StreamingChat = (
  payload: ChatPayload,
  options: ChatStreamOptions,
) => Promise<ChatResult>;

type Start = { type: 'start' } & Record<string, unknown>;

function isStart(message: unknown): message is Start {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'start'
  );
}

/**
 * Handles one connected port: waits for its `start` message, turns it into
 * the handler's payload with `read`, and streams `run`'s reply back.
 */
function serveStreamPort<P, R>(
  port: PortLike,
  read: (start: Start) => P,
  run: (payload: P, options: { signal: AbortSignal; onChunk(text: string): void }) => Promise<R>,
): void {
  const controller = new AbortController();
  let open = true;
  const close = () => {
    open = false;
    controller.abort();
  };
  port.onDisconnect.addListener(close);
  // Posting to a port the other side has closed throws. That must not stop the
  // service worker, so a failed post is treated like a disconnect.
  const send = (message: StreamPortMessage<R>) => {
    if (!open) return;
    try {
      port.postMessage(message);
    } catch {
      close();
    }
  };

  let started = false;
  port.onMessage.addListener((message) => {
    if (started || !isStart(message)) return;
    started = true;
    const fail = (error: unknown) =>
      send({
        type: 'error',
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
    // A payload `read` cannot use is reported like a handler that rejects.
    let reply: Promise<R>;
    try {
      reply = run(read(message), {
        signal: controller.signal,
        onChunk: (text) => send({ type: 'chunk', text }),
      });
    } catch (error) {
      fail(error);
      return;
    }
    reply.then((result) => send({ type: 'result', result }), fail);
  });
}

/** The queue's name for the line and its place in the PR, when they are well formed. */
function toJobInfo(value: unknown): ExplainJobInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { label, order } = value as { label?: unknown; order?: unknown };
  if (typeof label !== 'string' || !label) return undefined;
  return {
    label: label.slice(0, 200),
    ...(typeof order === 'number' && Number.isFinite(order) && { order }),
  };
}

/** Handles one connected explain port. Exported for the tests. */
export function serveExplainPort(port: PortLike, explain: StreamingExplain): void {
  const tab = port.sender?.tab?.id;
  serveStreamPort(
    port,
    (message) => {
      const job = toJobInfo(message.job);
      return {
        context: message.context as string,
        pr: typeof message.pr === 'string' ? message.pr : undefined,
        fresh: message.fresh === true,
        // Explain on hover (PR 8.7) and Explain ahead (PR 9.10) say so, for
        // their round trips (PR 9.2).
        cause:
          message.cause === 'hover' || message.cause === 'ahead'
            ? (message.cause as 'hover' | 'ahead')
            : ('click' as const),
        // Groups the request's round trips in the debug log (PR 9.3); the
        // handler shortens it.
        ...(typeof message.debugId === 'string' && { debugId: message.debugId }),
        // The line's name and place in the PR, for the background queue (PR 10.3).
        ...(job && { job }),
      };
    },
    (payload, options) => explain(payload, { ...options, ...(tab !== undefined && { tab }) }),
  );
}

/** Handles one connected chat port. Exported for the tests. */
export function serveChatPort(port: PortLike, chat: StreamingChat): void {
  serveStreamPort(
    port,
    (message) => ({ messages: message.messages as ChatPayload['messages'] }),
    chat,
  );
}

function listen(runtime: PortRuntime, name: string, serve: (port: PortLike) => void): void {
  runtime.onConnect.addListener((port) => {
    if (port.name !== name || port.sender?.id !== runtime.id) return;
    serve(port);
  });
}

/** Answers explain ports from our own extension's pages and content scripts. */
export function listenForExplainPorts(runtime: PortRuntime, explain: StreamingExplain): void {
  listen(runtime, EXPLAIN_PORT, (port) => serveExplainPort(port, explain));
}

/** Answers chat ports from our own extension's pages and content scripts. */
export function listenForChatPorts(runtime: PortRuntime, chat: StreamingChat): void {
  listen(runtime, CHAT_PORT, (port) => serveChatPort(port, chat));
}
