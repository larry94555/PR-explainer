// The requests the content script can send to the service worker, and the
// shapes that travel over chrome.runtime messaging.
//
// This file holds types only. Both entries import it with `import type`, which
// is erased at build time, so it never becomes a shared chunk (content scripts
// cannot load chunks; see src/content.ts).

// Each request type maps to the payload it takes and the result it returns.
// Later PRs add entries here, for example `explain` in PR 3.3.
export interface RequestMap {
  ping: { payload: undefined; result: { receivedAt: number } };
}

export type RequestType = keyof RequestMap;
export type PayloadOf<T extends RequestType> = RequestMap[T]['payload'];
export type ResultOf<T extends RequestType> = RequestMap[T]['result'];

// Tags our messages so the service worker can ignore anything else.
export type MessageSource = 'pr-explainer';

export interface RequestEnvelope<T extends RequestType = RequestType> {
  source: MessageSource;
  type: T;
  payload: PayloadOf<T>;
}

export interface SerializedError {
  name: string;
  message: string;
}

export type ResponseEnvelope<T extends RequestType = RequestType> =
  { ok: true; result: ResultOf<T> } | { ok: false; error: SerializedError };

// The parts of chrome.runtime this layer uses. Passing it in (instead of
// reading the global) lets the tests use a fake.
export interface MessageSenderLike {
  id?: string;
}

export type MessageListener = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

export interface ExtensionRuntime {
  id: string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: { addListener(listener: MessageListener): void };
}
