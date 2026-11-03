// LlmClient for Ollama's HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md):
// GET /api/tags lists installed models, GET /api/ps lists the loaded ones
// (PR 8.3) and how much of each is on the GPU (PR 8.6), POST /api/show describes one (its context window, PR 6.2),
// POST /api/chat answers a conversation,
// either all at once (chat) or as a stream of newline-delimited JSON objects
// (chatStream).
//
// Runs in the service worker. The manifest's localhost host_permissions let
// the worker reach Ollama without CORS, but Chrome still sends an Origin
// header, which Ollama may reject with 403 (see the origin-blocked error).
// Every request goes through createLlmFetch (PR 7.4), which refuses any
// address that is not the configured server on this computer.
//
// A finished reply carries Ollama's timing fields (PR 8.1), read by
// readTimings and converted from nanoseconds to milliseconds.
//
// Every chat request says how long to keep the model loaded afterwards
// (keep_alive, PR 8.3); Ollama's own default unloads it after 5 idle minutes.
// A chat request with no messages only loads the model (loadModel).

import {
  isSameModel,
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatReply,
  type ChatStreamEnd,
  type LlmClient,
  type LlmTimings,
  type ModelContext,
  type ModelInfo,
  type RunningModel,
} from './types';
import { createLlmFetch, type FetchLike } from '../net/llmFetch';
import type { RoundTripLog } from '../net/roundTrips';

export type { FetchLike } from '../net/llmFetch';

export interface OllamaClientOptions {
  /** Server address with no trailing slash, for example "http://localhost:11434". */
  baseUrl: string;
  /** Defaults to the global fetch. Tests pass a fake. Either way it is guarded. */
  fetch?: FetchLike;
  /** Where to record each request (PR 9.2). */
  roundTrips?: RoundTripLog;
}

export class OllamaClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = createLlmFetch(this.baseUrl, options.fetch, options.roundTrips);
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

  async loadedModels(options: { signal?: AbortSignal } = {}): Promise<string[]> {
    return (await this.runningModels(options)).map((m) => m.name);
  }

  async runningModels(options: { signal?: AbortSignal } = {}): Promise<RunningModel[]> {
    const body = await this.request('/api/ps', { method: 'GET', signal: options.signal });
    const models = (body as { models?: unknown }).models;
    if (!Array.isArray(models)) throw badResponse('/api/ps', 'missing "models" list');
    return models.flatMap((m: unknown) => {
      const { name, model, size, size_vram, context_length } = (m ?? {}) as Record<string, unknown>;
      const found = typeof name === 'string' ? name : model;
      if (typeof found !== 'string') return [];
      // Older Ollama versions do not report context_length.
      return [
        {
          name: found,
          ...(isWholeNumber(size) && { sizeBytes: size }),
          ...(isWholeNumber(size_vram) && { vramBytes: size_vram }),
          ...(isPositiveInteger(context_length) && { contextTokens: context_length }),
        },
      ];
    });
  }

  async loadedContextTokens(
    model: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<number | undefined> {
    const running = await this.runningModels(options);
    return running.find((m) => isSameModel(m.name, model))?.contextTokens;
  }

  async loadModel(
    model: string,
    options: { keepAliveMinutes?: number; contextTokens?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const name = requireModel({ model });
    // Ollama loads the model and answers at once when there are no messages.
    // The window is sent too: loading with one and asking with another
    // would make Ollama load the model again on the first click (PR 8.5).
    const body = {
      model: name,
      messages: [],
      stream: false,
      ...keepAlive(options.keepAliveMinutes),
      ...(options.contextTokens !== undefined && {
        options: { num_ctx: options.contextTokens },
      }),
    };
    await this.request('/api/chat', chatInit(body, options.signal), name);
  }

  async modelContext(model: string, options: { signal?: AbortSignal } = {}): Promise<ModelContext> {
    const name = requireModel({ model });
    const body = await this.request('/api/show', chatInit({ model: name }, options.signal), name);
    const { model_info, parameters } = body as { model_info?: unknown; parameters?: unknown };
    const result: ModelContext = {};
    // model_info holds "<architecture>.context_length", such as "qwen2.context_length".
    if (typeof model_info === 'object' && model_info !== null) {
      for (const [key, value] of Object.entries(model_info)) {
        if (key.endsWith('.context_length') && isPositiveInteger(value)) result.maxTokens = value;
      }
    }
    // parameters is the Modelfile's PARAMETER lines as text, such as "num_ctx 8192\nstop ...".
    const numCtx = typeof parameters === 'string' && /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
    if (numCtx && isPositiveInteger(Number(numCtx[1]))) result.configuredTokens = Number(numCtx[1]);
    return result;
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatReply> {
    const model = requireModel(options);
    const body = await this.request(
      '/api/chat',
      chatInit(buildChatBody(messages, { ...options, model }), options.signal),
      model,
    );
    const { message, model: replyModel } = body as {
      message?: { content?: unknown };
      model?: unknown;
    };
    if (typeof message?.content !== 'string') {
      throw badResponse('/api/chat', 'missing "message.content"');
    }
    const timings = readTimings(body);
    return {
      content: message.content,
      model: typeof replyModel === 'string' ? replyModel : model,
      ...(timings && { timings }),
    };
  }

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string, ChatStreamEnd, undefined> {
    const model = requireModel(options);
    const { signal } = options;
    const body = { ...buildChatBody(messages, { ...options, model }), stream: true };
    // Checked here too, because an injected fetch may ignore the signal.
    throwIfAborted(signal);
    const response = await this.send('/api/chat', chatInit(body, signal), model);
    if (!response.body) throw badResponse('/api/chat', 'no response body');

    // Cancelling the reader on abort makes a pending read() finish, even when
    // the stream itself ignores the signal, so the loop below always notices.
    const reader = response.body.getReader();
    const onAbort = () => void reader.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort);
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    try {
      while (!finished) {
        throwIfAborted(signal);
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (cause) {
          throw this.readError(cause, signal);
        }
        throwIfAborted(signal);
        // At the end of the stream, flush the decoder and add a newline so a
        // last line without one is still handled.
        buffer += chunk.done
          ? decoder.decode() + '\n'
          : decoder.decode(chunk.value, { stream: true });

        let newline: number;
        while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const part = parseStreamLine(line);
          if (part.content) yield part.content;
          if (part.done) {
            finished = true;
            return {
              model: part.model ?? model,
              ...(part.doneReason && { doneReason: part.doneReason }),
              ...(part.timings && { timings: part.timings }),
            };
          }
        }
        if (chunk.done) break;
      }
      throw new LlmError('connection', `The connection to ${this.baseUrl} closed mid-reply.`);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // Ends the HTTP request when the caller stops early or something threw,
      // so Ollama stops generating.
      if (!finished) await reader.cancel().catch(() => {});
    }
  }

  // Sends one request and returns the parsed JSON body, turning every failure
  // into an LlmError. `model` is set for requests where a 404 means the model
  // is missing.
  private async request(path: string, init: RequestInit, model?: string): Promise<unknown> {
    const response = await this.send(path, init, model);
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw this.readError(cause);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed;
    } catch (cause) {
      throw new LlmError('bad-response', `${path} did not return a JSON object.`, { cause });
    }
  }

  // Sends one request and returns the response once its status is OK.
  private async send(path: string, init: RequestInit, model?: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      // Refused by the guard: nothing was sent.
      if (cause instanceof LlmError && cause.kind === 'blocked') throw cause;
      // Some fetches reject an aborted request with an error not named AbortError.
      if (isAbort(cause) || init.signal?.aborted) throw abortedError(cause);
      // fetch rejects with a TypeError ("Failed to fetch") when nothing listens.
      throw new LlmError('connection', `Could not connect to ${this.baseUrl}.`, { cause });
    }
    if (!response.ok) throw await httpError(response, path, model);
    return response;
  }

  // The error for a body that failed while it was being read.
  private readError(cause: unknown, signal?: AbortSignal): LlmError {
    if (isAbort(cause) || signal?.aborted) return abortedError(cause);
    return new LlmError('connection', `The connection to ${this.baseUrl} was lost.`, { cause });
  }
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function requireModel(options: Pick<ChatOptions, 'model'>): string {
  const model = options.model.trim();
  if (!model) throw new LlmError('no-model', 'No model selected. Pick one in the settings.');
  return model;
}

function chatInit(body: object, signal: AbortSignal | undefined): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

interface StreamPart {
  content: string;
  done: boolean;
  model?: string;
  doneReason?: string;
  timings?: LlmTimings;
}

// Ollama's timing fields on a finished reply, as nanoseconds and counts.
const TIMING_FIELDS = {
  total_duration: 'totalMs',
  load_duration: 'loadMs',
  prompt_eval_count: 'promptTokens',
  prompt_eval_duration: 'promptMs',
  eval_count: 'answerTokens',
  eval_duration: 'answerMs',
} as const satisfies Record<string, keyof LlmTimings>;

/**
 * The timing fields of a finished reply, with durations in milliseconds, or
 * undefined when it has none. A field that is missing or not a number is left
 * out, since older servers and cached prompts leave some out. Exported for tests.
 */
export function readTimings(body: unknown): LlmTimings | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const timings: LlmTimings = {};
  for (const [field, key] of Object.entries(TIMING_FIELDS)) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    timings[key] = key.endsWith('Tokens') ? value : value / 1e6;
  }
  return Object.keys(timings).length ? timings : undefined;
}

// One line of Ollama's stream: {"model": ..., "message": {"content": "..."},
// "done": false}, ending with "done": true (and "done_reason"). If the model
// fails mid-reply, Ollama sends {"error": "..."} instead.
function parseStreamLine(line: string): StreamPart {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new LlmError('bad-response', '/api/chat sent a line that is not JSON.', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw badResponse('/api/chat', 'a stream line is not an object');
  }
  const { error, message, done, model, done_reason } = parsed as {
    error?: unknown;
    message?: { content?: unknown };
    done?: unknown;
    model?: unknown;
    done_reason?: unknown;
  };
  if (typeof error === 'string') {
    throw new LlmError('http', `Ollama stopped mid-reply (${error}).`);
  }
  const content = message?.content;
  if (content !== undefined && typeof content !== 'string') {
    throw badResponse('/api/chat', '"message.content" is not text');
  }
  if (content === undefined && done !== true) {
    throw badResponse('/api/chat', 'a stream line has no "message.content"');
  }
  const timings = done === true ? readTimings(parsed) : undefined;
  return {
    content: content ?? '',
    done: done === true,
    ...(typeof model === 'string' && { model }),
    ...(typeof done_reason === 'string' && { doneReason: done_reason }),
    ...(timings && { timings }),
  };
}

function abortedError(cause?: unknown): LlmError {
  return new LlmError('aborted', 'The request was cancelled.', { cause });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError(signal.reason);
}

/** The JSON body for POST /api/chat. Exported for tests. */
export function buildChatBody(messages: ChatMessage[], options: ChatOptions) {
  const modelOptions: { temperature?: number; num_predict?: number; num_ctx?: number } = {};
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.maxResponseTokens !== undefined) modelOptions.num_predict = options.maxResponseTokens;
  if (options.contextTokens !== undefined) modelOptions.num_ctx = options.contextTokens;
  return {
    model: options.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: false,
    ...keepAlive(options.keepAliveMinutes),
    options: modelOptions,
  };
}

/** Ollama's keep_alive field, such as "30m", or nothing to use its default. */
function keepAlive(minutes: number | undefined): { keep_alive?: string } {
  return minutes === undefined ? {} : { keep_alive: `${minutes}m` };
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
