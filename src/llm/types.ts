// What the rest of the extension needs from a local LLM server. Ollama is the
// only implementation for now (see ollamaClient.ts); keeping callers on this
// interface means another local server, such as LM Studio, can be added later
// without changing them.

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** Model name as listModels() returns it. */
  model: string;
  /** Sampling temperature. Left to the server's default when omitted. */
  temperature?: number;
  /** Upper limit on the reply length, in tokens. */
  maxResponseTokens?: number;
  /** Cancels the request. The promise then rejects with kind "aborted". */
  signal?: AbortSignal;
}

export interface ChatReply {
  /** The assistant's reply text. */
  content: string;
  /** The model that answered, as the server names it. */
  model: string;
}

/** What chatStream returns once the reply is complete. */
export interface ChatStreamEnd {
  /** The model that answered, as the server names it. */
  model: string;
  /** Why the model stopped, when the server says: "stop" (finished) or "length" (hit the limit). */
  doneReason?: string;
}

export interface ModelInfo {
  /** The name to pass as ChatOptions.model, for example "qwen2.5-coder:7b". */
  name: string;
  /** Size on disk in bytes, when the server reports it. */
  sizeBytes?: number;
}

export interface LlmClient {
  listModels(options?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatReply>;
  /**
   * Like chat(), but yields the reply in pieces as the model writes them.
   * Aborting `options.signal`, or leaving a `for await` loop early, ends the
   * request. Failures throw the same LlmError kinds as chat().
   */
  chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string, ChatStreamEnd, undefined>;
}

/**
 * Why a call to the LLM failed. describeLlmError (describeLlmError.ts) turns
 * each kind into a message with a fix for the user.
 * - connection: nothing answered at the URL (server not running, wrong port).
 * - model-not-found: the server does not have the requested model.
 * - origin-blocked: the server refused the extension's origin (HTTP 403).
 * - no-model: chat() was called without a model name.
 * - bad-response: the reply was not the JSON we expected.
 * - http: any other HTTP error status.
 * - aborted: the caller cancelled the request.
 */
export type LlmErrorKind =
  | 'connection'
  | 'model-not-found'
  | 'origin-blocked'
  | 'no-model'
  | 'bad-response'
  | 'http'
  | 'aborted';

export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly details: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
  }
}
