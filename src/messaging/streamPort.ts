// Service worker side of the explain port (see ExplainPortName in
// protocol.ts): runs one explanation per port, forwards each piece of the
// reply as it arrives, and aborts the request when the content script
// disconnects (Stop button, popup closed, tab closed or reloaded).

import type {
  ExplainPayload,
  ExplainResult,
  ExplainStreamOptions,
} from '../explain/explainHandler';
import type {
  ExplainPortMessage,
  ExplainPortName,
  ExplainPortRequest,
  PortLike,
  PortRuntime,
} from './protocol';

export const EXPLAIN_PORT: ExplainPortName = 'pr-explainer:explain';

export type StreamingExplain = (
  payload: ExplainPayload,
  options: ExplainStreamOptions,
) => Promise<ExplainResult>;

function isStart(message: unknown): message is ExplainPortRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'start'
  );
}

/** Handles one connected port. Exported for the tests. */
export function serveExplainPort(port: PortLike, explain: StreamingExplain): void {
  const controller = new AbortController();
  let open = true;
  const close = () => {
    open = false;
    controller.abort();
  };
  port.onDisconnect.addListener(close);
  // Posting to a port the other side has closed throws. That must not stop the
  // service worker, so a failed post is treated like a disconnect.
  const send = (message: ExplainPortMessage) => {
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
    explain(
      { context: message.context },
      { signal: controller.signal, onChunk: (text) => send({ type: 'chunk', text }) },
    ).then(
      (result) => send({ type: 'result', result }),
      (error: unknown) =>
        send({
          type: 'error',
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'Error', message: String(error) },
        }),
    );
  });
}

/** Answers explain ports from our own extension's pages and content scripts. */
export function listenForExplainPorts(runtime: PortRuntime, explain: StreamingExplain): void {
  runtime.onConnect.addListener((port) => {
    if (port.name !== EXPLAIN_PORT || port.sender?.id !== runtime.id) return;
    serveExplainPort(port, explain);
  });
}
