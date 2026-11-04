// The requests the content script can send to the service worker, and the
// shapes that travel over chrome.runtime messaging.
//
// This file holds types only. Both entries import it with `import type`, which
// is erased at build time, so it never becomes a shared chunk (content scripts
// cannot load chunks; see src/content.ts).

import type { ChatPayload, ChatResult } from '../chat/chatHandler';
import type { DebugLogPayload } from '../debug/types';
import type { ExplainPayload, ExplainResult } from '../explain/explainHandler';
import type { AheadProgress } from '../explainAhead';
import type { WarmupPayload, WarmupResult } from '../llm/warmup';

// Each request type maps to the payload it takes and the result it returns.
// Later PRs add entries here. Explanations stream over a port instead (below).
export interface RequestMap {
  ping: { payload: undefined; result: { receivedAt: number } };
  // Loads the model ahead of the first click on a PR's diffs (PR 8.3).
  warmup: { payload: WarmupPayload; result: WarmupResult };
  // A click's GitHub round trips and trace, for the debug log (PR 9.3).
  debugLogAdd: { payload: DebugLogPayload; result: { added: number } };
  // Empties the debug log (the debug window's Clear button, PR 9.4).
  debugLogClear: { payload: undefined; result: { cleared: true } };
  // Opens the debug window, or brings it to the front (the popup's Debug button, PR 9.4).
  openDebugWindow: { payload: undefined; result: { window: 'opened' | 'focused' } };
  // Whole PR's progress in the sending tab, for the toolbar icon, or null to
  // clear it (PR 10.7).
  aheadProgress: { payload: AheadProgress | null; result: { shown: boolean } };
  // Empties the session cache and the answers saved on disk (the settings
  // page's Clear saved answers button, PR 10.9).
  clearSavedAnswers: { payload: undefined; result: { cleared: true } };
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
  /** The tab a content script message came from. */
  tab?: { id?: number };
  /** The page that sent it, such as an extension page's chrome-extension:// address. */
  url?: string;
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

// Explanations stream over a long-lived port (chrome.runtime.connect), so the
// reply can be shown as it arrives and stopped midway. The content script
// opens the port and sends one `start` message. The service worker answers
// with any number of `chunk` messages, then one `result` (or `error` if the
// handler threw). Disconnecting the port, from the Stop button or by closing
// the popup, aborts the request. Each side keeps its own copy of the port name
// (they cannot share runtime code); this type makes TypeScript check they match.
export type ExplainPortName = 'pr-explainer:explain';

export type ExplainPortRequest = { type: 'start' } & ExplainPayload;

/** What the service worker sends back over a stream port with result type R. */
export type StreamPortMessage<R> =
  | { type: 'chunk'; text: string }
  | { type: 'result'; result: R }
  | { type: 'error'; error: SerializedError };

export type ExplainPortMessage = StreamPortMessage<ExplainResult>;

// Chat answers (PR 5.3) stream over their own port in the same way: one
// `start` carrying the whole message list the ChatSession built, then chunks
// and one result. Disconnecting (the chat panel's Stop button, or closing the
// panel) aborts the request.
export type ChatPortName = 'pr-explainer:chat';

export type ChatPortRequest = { type: 'start' } & ChatPayload;

export type ChatPortMessage = StreamPortMessage<ChatResult>;

// The parts of a chrome.runtime.Port this layer uses.
export interface PortLike {
  name: string;
  sender?: MessageSenderLike;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

// The parts of chrome.runtime the port layer uses. `lastError` says why a
// port closed, when Chrome closed it.
export interface PortRuntime {
  id: string;
  connect(info: { name: string }): PortLike;
  onConnect: { addListener(listener: (port: PortLike) => void): void };
  lastError?: { message?: string };
}
