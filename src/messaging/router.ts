// Service worker side: a registry of request handlers and the
// chrome.runtime.onMessage listener that dispatches to them.

import type {
  ExtensionRuntime,
  MessageListener,
  MessageSenderLike,
  PayloadOf,
  RequestEnvelope,
  RequestType,
  ResponseEnvelope,
  ResultOf,
  SerializedError,
} from './protocol';

/** Runs one request. `sender` says which tab sent it, for handlers that care (PR 8.3). */
export type Handler<T extends RequestType> = (
  payload: PayloadOf<T>,
  sender: MessageSenderLike,
) => ResultOf<T> | Promise<ResultOf<T>>;

function isRequest(message: unknown): message is RequestEnvelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { source?: unknown }).source === 'pr-explainer' &&
    typeof (message as { type?: unknown }).type === 'string'
  );
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

export class MessageRouter {
  // Stored untyped; `on` is the typed way in, so each handler gets its own payload.
  private readonly handlers = new Map<
    string,
    (payload: unknown, sender: MessageSenderLike) => unknown
  >();

  on<T extends RequestType>(type: T, handler: Handler<T>): this {
    if (this.handlers.has(type)) throw new Error(`A handler for "${type}" is already registered`);
    this.handlers.set(type, handler as (payload: unknown, sender: MessageSenderLike) => unknown);
    return this;
  }

  // Runs the handler for `request` and wraps its result or error.
  async dispatch(
    request: RequestEnvelope,
    sender: MessageSenderLike = {},
  ): Promise<ResponseEnvelope> {
    const handler = this.handlers.get(request.type);
    if (!handler) {
      return {
        ok: false,
        error: { name: 'UnknownRequestError', message: `Unknown request type "${request.type}"` },
      };
    }
    try {
      return {
        ok: true,
        result: (await handler(request.payload, sender)) as ResultOf<RequestType>,
      };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  }

  // The onMessage listener. It answers only our own extension's messages and
  // returns true so Chrome keeps the channel open for the async answer.
  listener(runtimeId: string): MessageListener {
    return (message, sender, sendResponse) => {
      if (sender.id !== runtimeId || !isRequest(message)) return false;
      void this.dispatch(message, sender).then(sendResponse);
      return true;
    };
  }

  listen(runtime: ExtensionRuntime = chrome.runtime): void {
    runtime.onMessage.addListener(this.listener(runtime.id));
  }
}
