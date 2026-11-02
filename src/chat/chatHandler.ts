// The service worker's chat handler (PR 5.3): streams the model's answer to a
// chat question, passing each piece to `onChunk` so the chat panel can show
// it as it arrives.
//
// The content script's ChatSession (src/chat/chatSession.ts) builds the whole
// message list: the code, the explanation, earlier turns, and the new
// question. This handler only checks its shape, sends it to the local LLM
// with the user's settings, and returns the answer. Like the explain handler,
// an LLM failure comes back as a result with a message and a fix (from
// describeLlmError), not a thrown error, so the panel can show the fix.

import { describeLlmError, type Platform } from '../llm/describeLlmError';
import type { ChatMessage, LlmClient } from '../llm/types';
import type { Settings } from '../settings';

export interface ChatPayload {
  /** The messages from ChatSession.messagesFor, ending with the question. */
  messages: ChatMessage[];
}

export type ChatResult =
  | { status: 'done'; answer: string; model: string }
  | { status: 'failed'; message: string; fix: string };

export interface ChatStreamOptions {
  /** Called with each piece of the answer as the model writes it. */
  onChunk?(text: string): void;
  /** Cancels the request (the chat panel's Stop button, or the panel closing). */
  signal?: AbortSignal;
}

export interface ChatDeps {
  getSettings(): Promise<Settings>;
  createClient(settings: Settings): LlmClient;
  platform: Platform;
}

const ROLES = new Set(['system', 'user', 'assistant']);

/** True for a non-empty list of messages that ends with the user's question. */
export function isChatMessages(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        ROLES.has((m as ChatMessage).role) &&
        typeof (m as ChatMessage).content === 'string',
    ) &&
    (value.at(-1) as ChatMessage).role === 'user'
  );
}

export function createChatHandler(deps: ChatDeps) {
  return async (
    payload: ChatPayload,
    { onChunk, signal }: ChatStreamOptions = {},
  ): Promise<ChatResult> => {
    if (!isChatMessages(payload?.messages)) {
      throw new Error('chat needs a list of messages that ends with a question');
    }
    const settings = await deps.getSettings();
    try {
      const stream = deps.createClient(settings).chatStream(payload.messages, {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: settings.maxResponseTokens,
        signal,
      });
      let answer = '';
      let next = await stream.next();
      while (!next.done) {
        answer += next.value;
        onChunk?.(next.value);
        next = await stream.next();
      }
      return { status: 'done', answer, model: next.value.model };
    } catch (error) {
      const { message, fix } = describeLlmError(error, {
        url: settings.llmUrl,
        model: settings.model,
        platform: deps.platform,
      });
      return { status: 'failed', message, fix };
    }
  };
}
