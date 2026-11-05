// Chrome's built-in model from the service worker (PR 11.13). Chrome gives
// the Prompt API to pages, not always to workers, so when the worker has no
// `LanguageModel` the client runs in an offscreen document (offscreen.html,
// src/offscreen/main.ts) and the worker talks to it over a port.
//
// Each call opens its own port: the worker sends one request, the offscreen
// document answers with any number of `chunk` messages, then `end` or
// `error`. Closing the port (Stop, or the popup closing) stops the request,
// as with the explain and chat ports (src/messaging/streamPort.ts).

import type { PortLike } from '../messaging/protocol';
import { ChromeAiClient, type BuiltInAvailability } from './chromeAiClient';
import { llmErrorKind } from './describeLlmError';
import {
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatReply,
  type ChatStreamEnd,
  type LlmClient,
  type LlmErrorKind,
  type ModelContext,
  type ModelInfo,
} from './types';

export const CHROME_AI_PORT = 'pr-explainer:chrome-ai';

/** What the worker asks the offscreen document. `options` never holds the signal. */
export type ChromeAiRequest =
  | { op: 'availability' }
  | { op: 'listModels' }
  | { op: 'loadModel' }
  | { op: 'modelContext' }
  | { op: 'chat'; messages: ChatMessage[]; options: Omit<ChatOptions, 'signal'> };

export type ChromeAiReply =
  | { type: 'chunk'; text: string }
  | { type: 'end'; value: unknown }
  | { type: 'error'; kind?: LlmErrorKind; message: string };

/** The parts of chrome.runtime the offscreen document's side uses. */
export interface ChromeAiConnect {
  onConnect: { addListener(listener: (port: PortLike) => void): void };
}

/** Answers the worker's requests with `client` (run in the offscreen document). */
export function serveChromeAi(runtime: ChromeAiConnect, client: ChromeAiClient): void {
  runtime.onConnect.addListener((port) => {
    if (port.name !== CHROME_AI_PORT) return;
    const stop = new AbortController();
    let open = true;
    port.onDisconnect.addListener(() => {
      open = false;
      stop.abort();
    });
    const send = (reply: ChromeAiReply) => {
      if (open) port.postMessage(reply);
    };
    port.onMessage.addListener((message) => {
      const request = message as ChromeAiRequest;
      const signal = stop.signal;
      const run = async (): Promise<unknown> => {
        switch (request.op) {
          case 'availability':
            return client.availability();
          case 'listModels':
            return client.listModels();
          case 'loadModel':
            return client.loadModel('', { signal });
          case 'modelContext':
            return client.modelContext('', { signal });
          case 'chat': {
            const stream = client.chatStream(request.messages, { ...request.options, signal });
            let next = await stream.next();
            while (!next.done) {
              send({ type: 'chunk', text: next.value });
              next = await stream.next();
            }
            return next.value;
          }
        }
      };
      run().then(
        (value) => send({ type: 'end', value }),
        (error: unknown) => {
          const kind = llmErrorKind(error);
          send({
            type: 'error',
            ...(kind && { kind }),
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
  });
}

export interface OffscreenAiDeps {
  /** Makes sure the offscreen document is open, so a port reaches it. */
  ensureDocument(): Promise<void>;
  connect(info: { name: string }): PortLike;
}

/**
 * The worker's side: the LlmClient for the built-in model, each call asked
 * of the offscreen document.
 */
export class OffscreenAiClient implements LlmClient {
  constructor(private readonly deps: OffscreenAiDeps) {}

  /** Sends `request` and yields each chunk, then returns the `end` value. */
  private async *call<T>(
    request: ChromeAiRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string, T, undefined> {
    if (signal?.aborted) throw new LlmError('aborted', 'The request was cancelled.');
    try {
      await this.deps.ensureDocument();
    } catch (error) {
      throw new LlmError(
        'built-in-error',
        `Could not open the page that runs it: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const port = this.deps.connect({ name: CHROME_AI_PORT });
    // Messages arrive as events; the generator takes them in order.
    const queue: (ChromeAiReply | 'closed')[] = [];
    let wake: (() => void) | undefined;
    const push = (item: ChromeAiReply | 'closed') => {
      queue.push(item);
      wake?.();
    };
    port.onMessage.addListener((message) => push(message as ChromeAiReply));
    port.onDisconnect.addListener(() => push('closed'));
    const abort = () => push('closed');
    signal?.addEventListener('abort', abort);
    try {
      try {
        port.postMessage(request);
      } catch {
        // Chrome closed the port at once: nothing in the document listens.
        push('closed');
      }
      for (;;) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        const item = queue.shift()!;
        if (signal?.aborted) throw new LlmError('aborted', 'The request was cancelled.');
        if (item === 'closed') {
          throw new LlmError('built-in-error', 'The page that runs it closed before answering.');
        }
        if (item.type === 'chunk') yield item.text;
        else if (item.type === 'end') return item.value as T;
        else throw new LlmError(item.kind ?? 'built-in-error', item.message);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      // Closing the port stops the request in the offscreen document when
      // the caller stopped early or cancelled; after the end it is tidying up.
      port.disconnect();
    }
  }

  /** Runs a call with no chunks to its end value. */
  private async ask<T>(request: ChromeAiRequest, signal?: AbortSignal): Promise<T> {
    const stream = this.call<T>(request, signal);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value;
  }

  /** Whether this computer can use the built-in model. Never throws. */
  async availability(): Promise<BuiltInAvailability> {
    try {
      return await this.ask<BuiltInAvailability>({ op: 'availability' });
    } catch {
      return 'unsupported';
    }
  }

  listModels(options: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    return this.ask({ op: 'listModels' }, options.signal);
  }

  async loadedModels(): Promise<string[]> {
    return [];
  }

  async runningModels(): Promise<never[]> {
    return [];
  }

  async loadedContextTokens(): Promise<undefined> {
    return undefined;
  }

  async loadModel(_model: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.ask({ op: 'loadModel' }, options.signal);
  }

  modelContext(_model: string, options: { signal?: AbortSignal } = {}): Promise<ModelContext> {
    return this.ask({ op: 'modelContext' }, options.signal);
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatReply> {
    const stream = this.chatStream(messages, options);
    let content = '';
    let next = await stream.next();
    while (!next.done) {
      content += next.value;
      next = await stream.next();
    }
    return { content, model: next.value.model };
  }

  chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string, ChatStreamEnd, undefined> {
    const { signal, ...rest } = options;
    return this.call<ChatStreamEnd>({ op: 'chat', messages, options: rest }, signal);
  }
}

/** The parts of chrome.offscreen and chrome.runtime that open the document. */
export interface OffscreenLike {
  createDocument(info: { url: string; reasons: string[]; justification: string }): Promise<void>;
}
export interface ContextsRuntime {
  getContexts(filter: {
    contextTypes: string[];
    documentUrls?: string[];
  }): Promise<readonly unknown[]>;
  getURL(path: string): string;
}

export const OFFSCREEN_PATH = 'offscreen.html';

/**
 * Opens offscreen.html once, unless it is already open (it stays open after
 * the worker restarts). Calls at the same time share one creation.
 */
export function offscreenDocument(
  offscreen: OffscreenLike,
  runtime: ContextsRuntime,
): () => Promise<void> {
  let creating: Promise<void> | undefined;
  return async () => {
    const open = await runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [runtime.getURL(OFFSCREEN_PATH)],
    });
    if (open.length > 0) return;
    creating ??= offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        // Chrome has no reason for running a built-in model; this is the nearest.
        reasons: ['WORKERS'],
        justification:
          "Runs Chrome's built-in language model, which the service worker cannot reach.",
      })
      .finally(() => {
        creating = undefined;
      });
    await creating;
  };
}
