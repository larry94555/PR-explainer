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
  /** The context window to run the model with, prompt and reply together, in tokens. */
  contextTokens?: number;
  /**
   * How long the server keeps the model in memory after this request, in
   * minutes (PR 8.3). Left to the server's default (5 minutes) when omitted.
   */
  keepAliveMinutes?: number;
  /** Cancels the request. The promise then rejects with kind "aborted". */
  signal?: AbortSignal;
}

export interface ChatReply {
  /** The assistant's reply text. */
  content: string;
  /** The model that answered, as the server names it. */
  model: string;
  /** Where the server's time went, when it says (PR 8.1). */
  timings?: LlmTimings;
}

/**
 * Where the server's time went on one reply (PR 8.1), in milliseconds. Each
 * field is left out when the server does not report it.
 */
export interface LlmTimings {
  /** The whole request, as the server measured it. */
  totalMs?: number;
  /** Loading the model into memory (near zero when it was already loaded). */
  loadMs?: number;
  /** How many prompt tokens the model read (cached ones are not counted). */
  promptTokens?: number;
  /** Reading the prompt. */
  promptMs?: number;
  /** How many tokens the model wrote. */
  answerTokens?: number;
  /** Writing the answer. */
  answerMs?: number;
}

/** What chatStream returns once the reply is complete. */
export interface ChatStreamEnd {
  /** The model that answered, as the server names it. */
  model: string;
  /** Why the model stopped, when the server says: "stop" (finished) or "length" (hit the limit). */
  doneReason?: string;
  /** Where the server's time went, when it says (PR 8.1). */
  timings?: LlmTimings;
}

export interface ModelInfo {
  /** The name to pass as ChatOptions.model, for example "qwen2.5-coder:7b". */
  name: string;
  /** Size on disk in bytes, when the server reports it. */
  sizeBytes?: number;
}

/** One model loaded in memory right now, as /api/ps lists it (PR 8.6). */
export interface RunningModel {
  name: string;
  /** How much memory the loaded model takes, in bytes, when the server says. */
  sizeBytes?: number;
  /** How much of that is in the GPU's video memory, in bytes, when the server says. */
  vramBytes?: number;
  /** The context window it is loaded with, when the server says. */
  contextTokens?: number;
}

/** What the server says about one model's context window (PR 6.2). */
export interface ModelContext {
  /** The longest context the model was trained for, when the server says. */
  maxTokens?: number;
  /** The context size the model's own settings ask for (Ollama's num_ctx), if any. */
  configuredTokens?: number;
}

/** Whether `listed` (a name from /api/ps) is `model`; "llama3" is listed as "llama3:latest". */
export function isSameModel(listed: string, model: string): boolean {
  return listed === model || (!model.includes(':') && listed === `${model}:latest`);
}

export interface LlmClient {
  listModels(options?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  /** The models loaded in memory right now, by name (PR 8.3). */
  loadedModels(options?: { signal?: AbortSignal }): Promise<string[]>;
  /**
   * The models loaded in memory right now, with how much of each is on the
   * GPU (PR 8.6).
   */
  runningModels(options?: { signal?: AbortSignal }): Promise<RunningModel[]>;
  /**
   * The context window `model` is loaded with right now (PR 8.5), or
   * undefined when it is not loaded or the server does not say.
   */
  loadedContextTokens(
    model: string,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined>;
  /**
   * Loads `model` into memory without asking it anything, and keeps it there
   * for `keepAliveMinutes` (PR 8.3), with a `contextTokens` window when given
   * (PR 8.5). Resolves once it is loaded.
   */
  loadModel(
    model: string,
    options?: { keepAliveMinutes?: number; contextTokens?: number; signal?: AbortSignal },
  ): Promise<void>;
  /** Looks up `model`'s context window. */
  modelContext(model: string, options?: { signal?: AbortSignal }): Promise<ModelContext>;
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
 * - blocked: the request was not sent, because it was not to an LLM on this
 *   computer (src/net/llmFetch.ts, PR 7.4).
 */
export type LlmErrorKind =
  | 'connection'
  | 'model-not-found'
  | 'origin-blocked'
  | 'no-model'
  | 'bad-response'
  | 'http'
  | 'aborted'
  | 'blocked';

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
