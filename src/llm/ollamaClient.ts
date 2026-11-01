// LlmClient for Ollama's HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md):
// GET /api/tags lists installed models, POST /api/chat answers a conversation.
// Streaming arrives in PR 4.1; for now every chat waits for the full reply.
//
// Runs in the service worker. The manifest's localhost host_permissions let
// the worker reach Ollama without CORS, but Chrome still sends an Origin
// header, which Ollama may reject with 403 (see the origin-blocked error).

import {
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatReply,
  type LlmClient,
  type ModelInfo,
} from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaClientOptions {
  /** Server address with no trailing slash, for example "http://localhost:11434". */
  baseUrl: string;
  /** Defaults to the global fetch. Tests pass a fake. */
  fetch?: FetchLike;
}

export class OllamaClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Wrapped so fetch is not called with the client as `this`.
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const body = await this.request('/api/tags', { method: 'GET', signal: options.signal });
    const models = (body as { models?: unknown }).models;
    if (!Array.isArray(models)) throw badResponse('/api/tags', 'missing "models" list');
    return models.map((m: unknown) => {
      const { name, size } = (m ?? {}) as { name?: unknown; size?: unknown };
      if (typeof name !== 'string') throw badResponse('/api/tags', 'a model has no name');
      return typeof size === 'number' ? { name, sizeBytes: size } : { name };
    });
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatReply> {
    const model = options.model.trim();
    if (!model) throw new LlmError('no-model', 'No model selected. Pick one in the settings.');
    const body = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildChatBody(messages, { ...options, model })),
        signal: options.signal,
      },
      model,
    );
    const { message, model: replyModel } = body as {
      message?: { content?: unknown };
      model?: unknown;
    };
    if (typeof message?.content !== 'string') {
      throw badResponse('/api/chat', 'missing "message.content"');
    }
    return { content: message.content, model: typeof replyModel === 'string' ? replyModel : model };
  }

  // Sends one request and returns the parsed JSON body, turning every failure
  // into an LlmError. `model` is set for requests where a 404 means the model
  // is missing.
  private async request(path: string, init: RequestInit, model?: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch (cause) {
      if (isAbort(cause)) throw new LlmError('aborted', 'The request was cancelled.', { cause });
      // fetch rejects with a TypeError ("Failed to fetch") when nothing listens.
      throw new LlmError('connection', `Could not connect to ${this.baseUrl}.`, { cause });
    }

    if (!response.ok) throw await httpError(response, path, model);

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (isAbort(cause)) throw new LlmError('aborted', 'The request was cancelled.', { cause });
      throw new LlmError('connection', `The connection to ${this.baseUrl} was lost.`, { cause });
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed;
    } catch (cause) {
      throw new LlmError('bad-response', `${path} did not return a JSON object.`, { cause });
    }
  }
}

/** The JSON body for POST /api/chat. Exported for tests. */
export function buildChatBody(messages: ChatMessage[], options: ChatOptions) {
  const modelOptions: { temperature?: number; num_predict?: number } = {};
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.maxResponseTokens !== undefined) modelOptions.num_predict = options.maxResponseTokens;
  return {
    model: options.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: false,
    options: modelOptions,
  };
}

// Checks the name rather than `instanceof DOMException`, which is not
// reliable across realms (and in jsdom, DOMException is not an Error).
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function badResponse(path: string, problem: string): LlmError {
  return new LlmError('bad-response', `Unexpected reply from ${path}: ${problem}.`);
}

// Ollama puts the reason in {"error": "..."}; fall back to the status text.
async function httpError(response: Response, path: string, model?: string): Promise<LlmError> {
  const status = response.status;
  let serverMessage = '';
  try {
    const text = await response.text();
    try {
      const { error } = JSON.parse(text) as { error?: unknown };
      serverMessage = typeof error === 'string' ? error : text;
    } catch {
      serverMessage = text;
    }
  } catch {
    // The body is only extra detail; the status is enough.
  }
  const detail = serverMessage.trim() || response.statusText || `HTTP ${status}`;

  if (status === 404 && model !== undefined) {
    return new LlmError('model-not-found', `Model "${model}" is not installed (${detail}).`, {
      status,
    });
  }
  if (status === 403) {
    return new LlmError('origin-blocked', `The server refused this extension (${detail}).`, {
      status,
    });
  }
  return new LlmError('http', `${path} failed with HTTP ${status} (${detail}).`, { status });
}
