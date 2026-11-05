import { describe, expect, it, vi } from 'vitest';
import {
  availabilityText,
  builtInAvailability,
  ChromeAiClient,
  CHROME_BUILT_IN_MODEL,
  downloadBuiltIn,
  promptApi,
  toLlmError,
  type PromptApiLike,
  type PromptCreateOptions,
  type PromptSessionLike,
} from '../src/llm/chromeAiClient';
import { LlmError, type ChatMessage } from '../src/llm/types';

/** A ReadableStream of `pieces`, waiting for `gate` (if any) before each one. */
function streamOf(pieces: string[], gate?: () => Promise<void>, signal?: AbortSignal) {
  let i = 0;
  const cancelled = vi.fn();
  const stream = new ReadableStream<string>({
    async pull(controller) {
      await gate?.();
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      if (i < pieces.length) controller.enqueue(pieces[i++]!);
      else controller.close();
    },
    cancel: cancelled,
  });
  return { stream, cancelled };
}

interface FakeApi extends PromptApiLike {
  created: PromptCreateOptions[];
  sessions: { prompts: string[]; destroyed: boolean; cancelled: ReturnType<typeof vi.fn> }[];
}

function fakeApi(
  options: {
    state?: string;
    pieces?: string[];
    window?: number;
    gate?: () => Promise<void>;
    create?: () => Promise<never>;
    params?: { defaultTopK: number; maxTemperature: number } | null;
  } = {},
): FakeApi {
  const api: FakeApi = {
    created: [],
    sessions: [],
    availability: vi.fn(async () => options.state ?? 'available'),
    params: async () =>
      options.params === undefined ? { defaultTopK: 3, maxTemperature: 2 } : options.params,
    create: vi.fn(async (createOptions: PromptCreateOptions = {}) => {
      if (options.create) return options.create();
      api.created.push(createOptions);
      const record = { prompts: [] as string[], destroyed: false, cancelled: vi.fn() };
      api.sessions.push(record);
      const session: PromptSessionLike = {
        contextWindow: options.window,
        promptStreaming(input, promptOptions) {
          record.prompts.push(input);
          const { stream, cancelled } = streamOf(
            options.pieces ?? ['It adds ', 'two numbers.'],
            options.gate,
            promptOptions?.signal,
          );
          record.cancelled = cancelled;
          return stream;
        },
        destroy() {
          record.destroyed = true;
        },
      };
      return session;
    }),
  };
  return api;
}

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You explain code.' },
  { role: 'user', content: 'Explain a + b' },
];

async function collect(stream: AsyncGenerator<string, unknown>) {
  const pieces: string[] = [];
  let next = await stream.next();
  while (!next.done) {
    pieces.push(next.value);
    next = await stream.next();
  }
  return { pieces, end: next.value };
}

describe('Chrome built-in model availability (PR 11.13)', () => {
  it.each(['available', 'downloadable', 'downloading', 'unavailable'])(
    'passes on %s',
    async (state) => {
      const api = fakeApi({ state });
      await expect(builtInAvailability(api)).resolves.toBe(state);
      expect(api.availability).toHaveBeenCalledWith(
        expect.objectContaining({ expectedOutputs: [{ type: 'text', languages: ['en'] }] }),
      );
      await expect(new ChromeAiClient(() => api).availability()).resolves.toBe(state);
    },
  );

  it('is unsupported without a Prompt API, and unavailable when asking fails or says something new', async () => {
    await expect(builtInAvailability(undefined)).resolves.toBe('unsupported');
    await expect(builtInAvailability(fakeApi({ state: 'maybe' }))).resolves.toBe('unavailable');
    const failing = fakeApi();
    vi.mocked(failing.availability).mockRejectedValue(new Error('no'));
    await expect(builtInAvailability(failing)).resolves.toBe('unavailable');
  });

  it('finds the Prompt API as LanguageModel', () => {
    const api = fakeApi();
    expect(promptApi({ LanguageModel: api })).toBe(api);
    expect(promptApi({})).toBeUndefined();
    expect(promptApi({ LanguageModel: {} })).toBeUndefined();
  });

  it('says each state in words', () => {
    expect(availabilityText('downloadable')).toContain('not downloaded yet');
    expect(availabilityText('unsupported')).toContain('Chrome 138');
  });

  it('lists the built-in model only when it is ready', async () => {
    await expect(new ChromeAiClient(() => fakeApi()).listModels()).resolves.toEqual([
      { name: CHROME_BUILT_IN_MODEL },
    ]);
    await expect(
      new ChromeAiClient(() => fakeApi({ state: 'downloadable' })).listModels(),
    ).resolves.toEqual([]);
  });
});

describe('downloading the built-in model (PR 11.13)', () => {
  it('reports progress from 0 to 1 and ends the session', async () => {
    const api = fakeApi();
    vi.mocked(api.create).mockImplementation(async (options) => {
      const monitor = new EventTarget();
      options?.monitor?.(monitor);
      for (const loaded of [0, 0.5, 1]) {
        monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded }));
      }
      return { promptStreaming: () => streamOf([]).stream, destroy: destroyed };
    });
    const destroyed = vi.fn();
    const progress: number[] = [];
    await downloadBuiltIn(api, (loaded) => progress.push(loaded));
    expect(progress).toEqual([0, 0.5, 1]);
    expect(destroyed).toHaveBeenCalled();
  });
});

describe('ChromeAiClient answers (PR 11.13)', () => {
  it('answers whole, with the system prompt as the session history', async () => {
    const api = fakeApi();
    const reply = await new ChromeAiClient(() => api).chat(MESSAGES, {
      model: 'ignored',
      temperature: 0.2,
    });
    expect(reply).toEqual({ content: 'It adds two numbers.', model: CHROME_BUILT_IN_MODEL });
    expect(api.created[0]).toMatchObject({
      initialPrompts: [MESSAGES[0]],
      temperature: 0.2,
      topK: 3,
    });
    expect(api.sessions[0]!.prompts).toEqual(['Explain a + b']);
    expect(api.sessions[0]!.destroyed).toBe(true);
  });

  it('streams each piece as it is written', async () => {
    const api = fakeApi({ pieces: ['One', ' two', ' three'] });
    const { pieces, end } = await collect(
      new ChromeAiClient(() => api).chatStream(MESSAGES, { model: '' }),
    );
    expect(pieces).toEqual(['One', ' two', ' three']);
    expect(end).toEqual({ model: CHROME_BUILT_IN_MODEL, doneReason: 'stop' });
  });

  it('keeps temperature and topK together, and within the limit', async () => {
    const hot = fakeApi({ params: { defaultTopK: 8, maxTemperature: 1 } });
    await new ChromeAiClient(() => hot).chat(MESSAGES, { model: '', temperature: 2 });
    expect(hot.created[0]).toMatchObject({ temperature: 1, topK: 8 });
    const noParams = fakeApi({ params: null });
    await new ChromeAiClient(() => noParams).chat(MESSAGES, { model: '', temperature: 0.2 });
    expect(noParams.created[0]).not.toHaveProperty('temperature');
    expect(noParams.created[0]).not.toHaveProperty('topK');
  });

  it('stops at about maxResponseTokens and says it was cut off', async () => {
    const api = fakeApi({ pieces: ['one ', 'two ', 'three ', 'four ', 'five ', 'six '] });
    const { pieces, end } = await collect(
      new ChromeAiClient(() => api).chatStream(MESSAGES, { model: '', maxResponseTokens: 3 }),
    );
    expect(pieces).toEqual(['one ', 'two ', 'three ']);
    expect(end).toMatchObject({ doneReason: 'length' });
    expect(api.sessions[0]!.cancelled).toHaveBeenCalled();
    expect(api.sessions[0]!.destroyed).toBe(true);
  });

  it('stops when Stop is pressed, ending the session', async () => {
    const stop = new AbortController();
    let release!: () => void;
    let calls = 0;
    const api = fakeApi({
      pieces: ['First', ' second'],
      gate: () =>
        calls++ === 0 ? Promise.resolve() : new Promise<void>((resolve) => (release = resolve)),
    });
    const stream = new ChromeAiClient(() => api).chatStream(MESSAGES, {
      model: '',
      signal: stop.signal,
    });
    expect(await stream.next()).toEqual({ done: false, value: 'First' });
    const next = stream.next();
    stop.abort();
    release();
    await expect(next).rejects.toMatchObject({ kind: 'aborted' });
    expect(api.sessions[0]!.destroyed).toBe(true);
  });

  it('does not start when already stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    const api = fakeApi();
    await expect(
      new ChromeAiClient(() => api).chat(MESSAGES, { model: '', signal: stop.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(api.create).not.toHaveBeenCalled();
  });

  it.each([
    ['downloadable', 'not downloaded yet'],
    ['unavailable', 'cannot run'],
  ])('refuses with "unavailable" when it is %s', async (state, says) => {
    const api = fakeApi({ state });
    const error = await new ChromeAiClient(() => api)
      .chat(MESSAGES, { model: '' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as Error).message).toContain(says);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('refuses with "unavailable" in a Chrome without the Prompt API', async () => {
    await expect(
      new ChromeAiClient(() => undefined).chat(MESSAGES, { model: '' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reports the context window from a session, for the prompt budget', async () => {
    const api = fakeApi({ window: 6144 });
    await expect(new ChromeAiClient(() => api).modelContext('')).resolves.toEqual({
      maxTokens: 6144,
      configuredTokens: 6144,
      capabilities: ['completion'],
    });
    expect(api.sessions[0]!.destroyed).toBe(true);
  });

  it('reads inputQuota from an older Chrome', async () => {
    const api = fakeApi();
    vi.mocked(api.create).mockResolvedValue({
      inputQuota: 4096,
      promptStreaming: () => streamOf([]).stream,
      destroy: () => {},
    });
    await expect(new ChromeAiClient(() => api).modelContext('')).resolves.toMatchObject({
      maxTokens: 4096,
    });
  });

  it('loads the model by starting and ending a session', async () => {
    const api = fakeApi();
    await new ChromeAiClient(() => api).loadModel('');
    expect(api.sessions).toHaveLength(1);
    expect(api.sessions[0]!.destroyed).toBe(true);
    await expect(new ChromeAiClient(() => api).loadedModels()).resolves.toEqual([]);
  });
});

describe('Prompt API errors as LlmError kinds (PR 11.13)', () => {
  it.each([
    ['AbortError', 'aborted'],
    ['NotAllowedError', 'unavailable'],
    ['QuotaExceededError', 'built-in-error'],
    ['OperationError', 'built-in-error'],
  ])('%s becomes %s', (name, kind) => {
    expect(toLlmError(new DOMException('It failed.', name))).toMatchObject({ kind });
  });

  it('says a prompt was too long, and passes other messages on', () => {
    expect(toLlmError(new DOMException('x', 'QuotaExceededError')).message).toContain('too long');
    expect(toLlmError(new Error('The model crashed.')).message).toBe('The model crashed.');
  });

  it('is aborted whatever the error once the signal is', () => {
    const stop = new AbortController();
    stop.abort();
    expect(toLlmError(new Error('x'), stop.signal)).toMatchObject({ kind: 'aborted' });
  });

  it('maps a failed session the same way', async () => {
    const api = fakeApi({
      create: () => Promise.reject(new DOMException('Turned off by policy.', 'NotAllowedError')),
    });
    await expect(new ChromeAiClient(() => api).chat(MESSAGES, { model: '' })).rejects.toMatchObject(
      { kind: 'unavailable' },
    );
  });
});
