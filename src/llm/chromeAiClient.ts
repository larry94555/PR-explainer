// Chrome's built-in model (PR 11.13): Gemini Nano through the Prompt API
// (the `LanguageModel` global), behind the same LlmClient interface as
// Ollama, so explanations and chat use it without knowing which one answers.
// It runs inside Chrome, on this computer, so the extension makes no new
// network requests for it.
//
// It is a fallback to try, not a replacement: it is smaller than a coding
// model, and only machines with enough memory and disk can download it.
// Chrome may not give the Prompt API to a service worker; there, the same
// client runs in an offscreen document (src/llm/offscreenAi.ts).
//
// Each request gets a fresh session, so one answer never sees another's
// prompt, and the session is destroyed when the answer ends or is stopped.
// The Prompt API has no limit on the answer's length, so the stream is cut
// once it reaches about `maxResponseTokens` (estimated as the prompt budget
// is, src/explain/tokenBudget.ts) and reports `doneReason: "length"`, as
// Ollama does.

import { estimateTokens } from '../explain/tokenBudget';
import {
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatReply,
  type ChatStreamEnd,
  type LlmClient,
  type ModelContext,
  type ModelInfo,
} from './types';

/** The name the built-in model goes by: in answers, the cache key and ratings. */
export const CHROME_BUILT_IN_MODEL = 'Chrome built-in';

/**
 * Whether this Chrome can use the built-in model: the Prompt API's own
 * answer, or `unsupported` when this Chrome has no Prompt API at all.
 */
export type BuiltInAvailability =
  'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

const KNOWN: readonly string[] = ['available', 'downloadable', 'downloading', 'unavailable'];

/** Prompts and answers are in English; Chrome asks to be told. */
export const PROMPT_LANGUAGES = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
} as const;

/** The part of a Prompt API session this client uses. */
export interface PromptSessionLike {
  promptStreaming(
    input: string,
    options?: { signal?: AbortSignal },
  ): ReadableStream<string> | AsyncIterable<string>;
  /** The session's context window, in tokens (`inputQuota` in older Chrome). */
  readonly contextWindow?: number;
  readonly inputQuota?: number;
  destroy(): void;
}

export interface PromptCreateOptions {
  temperature?: number;
  topK?: number;
  initialPrompts?: ChatMessage[];
  signal?: AbortSignal;
  /** Download progress: `downloadprogress` events with `loaded` from 0 to 1. */
  monitor?: (monitor: EventTarget) => void;
  expectedInputs?: typeof PROMPT_LANGUAGES.expectedInputs;
  expectedOutputs?: typeof PROMPT_LANGUAGES.expectedOutputs;
}

/** The part of the Prompt API's `LanguageModel` this client uses. */
export interface PromptApiLike {
  availability(options?: object): Promise<string>;
  /** Extensions only: the sampling limits. */
  params?(): Promise<{ defaultTopK: number; maxTemperature: number } | null>;
  create(options?: PromptCreateOptions): Promise<PromptSessionLike>;
}

/** The Prompt API in this context, or undefined when this Chrome has none here. */
export function promptApi(scope: object = globalThis): PromptApiLike | undefined {
  const api = (scope as { LanguageModel?: PromptApiLike }).LanguageModel;
  return api && typeof api.create === 'function' ? api : undefined;
}

/** What the Prompt API says, or `unsupported` without one. Never throws. */
export async function builtInAvailability(
  api: PromptApiLike | undefined,
): Promise<BuiltInAvailability> {
  if (!api) return 'unsupported';
  try {
    const found = await api.availability(PROMPT_LANGUAGES);
    return KNOWN.includes(found) ? (found as BuiltInAvailability) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** One sentence on why the built-in model cannot answer yet, for each state but available. */
export function availabilityText(state: BuiltInAvailability): string {
  switch (state) {
    case 'available':
      return "Chrome's built-in model is ready on this computer.";
    case 'downloadable':
      return "Chrome's built-in model is not downloaded yet.";
    case 'downloading':
      return 'Chrome is still downloading its built-in model.';
    case 'unavailable':
      return (
        'Chrome says its built-in model cannot run on this computer: it needs enough memory ' +
        'and free disk space, and an administrator may have turned it off.'
      );
    case 'unsupported':
      return 'This version of Chrome has no built-in model for extensions (it needs Chrome 138 or later).';
  }
}

/**
 * Downloads the model: creating a session starts it. Chrome allows that only
 * just after the user pressed something, so the settings page's Download
 * button calls this directly. `onProgress` gets 0 to 1.
 */
export async function downloadBuiltIn(
  api: PromptApiLike,
  onProgress: (loaded: number) => void,
): Promise<void> {
  const session = await api.create({
    ...PROMPT_LANGUAGES,
    monitor: (monitor) =>
      monitor.addEventListener('downloadprogress', (event) => {
        const loaded = (event as Event & { loaded?: number }).loaded;
        if (typeof loaded === 'number') onProgress(loaded);
      }),
  });
  session.destroy();
}

/** Reads a stream's chunks, and cancels it when the reader stops early. */
async function* chunks(stream: ReadableStream<string> | AsyncIterable<string>) {
  if (!('getReader' in stream)) {
    yield* stream;
    return;
  }
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A Prompt API failure as an LlmError, so describeLlmError can explain it. */
export function toLlmError(error: unknown, signal?: AbortSignal): LlmError {
  if (error instanceof LlmError) return error;
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  const detail = error instanceof Error || error instanceof DOMException ? error.message : '';
  if (signal?.aborted || name === 'AbortError') {
    return new LlmError('aborted', 'The request was cancelled.', { cause: error });
  }
  // Chrome refuses to create a session when the model is not downloaded, or
  // its policy turned the model off.
  if (name === 'NotAllowedError') {
    return new LlmError('unavailable', availabilityText('unavailable'), { cause: error });
  }
  if (name === 'QuotaExceededError') {
    return new LlmError('built-in-error', "The prompt is too long for Chrome's built-in model.", {
      cause: error,
    });
  }
  return new LlmError('built-in-error', detail || 'It stopped without saying why.', {
    cause: error,
  });
}

export class ChromeAiClient implements LlmClient {
  /** `api` is read on each call: undefined means this Chrome has no Prompt API here. */
  constructor(private readonly api: () => PromptApiLike | undefined = () => promptApi()) {}

  availability(): Promise<BuiltInAvailability> {
    return builtInAvailability(this.api());
  }

  /** The Prompt API, once it is known to be ready; otherwise an `unavailable` LlmError. */
  private async ready(): Promise<PromptApiLike> {
    const api = this.api();
    const state = await builtInAvailability(api);
    if (!api || state !== 'available') throw new LlmError('unavailable', availabilityText(state));
    return api;
  }

  private async session(
    initialPrompts: ChatMessage[],
    options: Pick<ChatOptions, 'temperature' | 'signal'> = {},
  ): Promise<PromptSessionLike> {
    const api = await this.ready();
    // Temperature and topK go together or not at all.
    let sampling = {};
    if (options.temperature !== undefined) {
      const params = await api.params?.().catch(() => null);
      if (params) {
        sampling = {
          temperature: Math.min(options.temperature, params.maxTemperature),
          topK: params.defaultTopK,
        };
      }
    }
    try {
      return await api.create({
        ...PROMPT_LANGUAGES,
        ...sampling,
        ...(initialPrompts.length > 0 && { initialPrompts }),
        ...(options.signal && { signal: options.signal }),
      });
    } catch (error) {
      throw toLlmError(error, options.signal);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.availability()) === 'available' ? [{ name: CHROME_BUILT_IN_MODEL }] : [];
  }

  // Chrome loads and unloads the model itself, and says nothing about it.
  async loadedModels(): Promise<string[]> {
    return [];
  }

  async runningModels(): Promise<never[]> {
    return [];
  }

  async loadedContextTokens(): Promise<undefined> {
    return undefined;
  }

  /** Creates a session and ends it, which has Chrome load the model. */
  async loadModel(_model: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    (await this.session([], options)).destroy();
  }

  /**
   * The model's context window, from a session: the prompt budget (PR 6.2)
   * is worked out from it, so a prompt is cut to fit before it is sent.
   */
  async modelContext(
    _model: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelContext> {
    const session = await this.session([], options);
    const window = session.contextWindow ?? session.inputQuota;
    session.destroy();
    return {
      ...(window !== undefined && { maxTokens: window, configuredTokens: window }),
      capabilities: ['completion'],
    };
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

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string, ChatStreamEnd, undefined> {
    const { signal, maxResponseTokens } = options;
    if (signal?.aborted) throw toLlmError(signal.reason, signal);
    // Everything before the last message is the session's history; the last
    // one (the question) is the prompt.
    const last = messages.at(-1);
    const session = await this.session(messages.slice(0, -1), options);
    let written = '';
    let doneReason = 'stop';
    try {
      for await (const chunk of chunks(
        session.promptStreaming(last?.content ?? '', signal ? { signal } : {}),
      )) {
        if (!chunk) continue;
        written += chunk;
        yield chunk;
        if (maxResponseTokens && estimateTokens(written) >= maxResponseTokens) {
          doneReason = 'length';
          break;
        }
      }
    } catch (error) {
      throw toLlmError(error, signal);
    } finally {
      try {
        session.destroy();
      } catch {
        // Already gone.
      }
    }
    return { model: CHROME_BUILT_IN_MODEL, doneReason };
  }
}
