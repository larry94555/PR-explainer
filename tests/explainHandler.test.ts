import { createExplainHandler, toFileContext, toPrInfo } from '../src/explain/explainHandler';
import { EXPLAIN_SYSTEM_PROMPT } from '../src/explain/explainPrompt';
import { SAMPLE_CONTEXT, SAMPLE_FILE_CONTEXT } from '../src/explain/sampleContext';
import {
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatStreamEnd,
  type LlmClient,
} from '../src/llm/types';
import { createContextSizer, createModelLookup } from '../src/llm/contextSize';
import { createLlmClient } from '../src/llm/createClient';
import { createLoadedWindowMemory } from '../src/llm/loadedWindow';
import { createRoundTripLog } from '../src/net/roundTrips';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };

/** A chatStream that yields `pieces`, or throws `error` after them. */
function streamOf(pieces: string[], error?: Error, model = 'qwen2.5-coder:7b') {
  return async function* (): AsyncGenerator<string, ChatStreamEnd, undefined> {
    for (const piece of pieces) yield piece;
    if (error) throw error;
    return { model, doneReason: 'stop' };
  };
}

function setup(chatStream: LlmClient['chatStream'], settings: Settings = SETTINGS) {
  const client: LlmClient = {
    listModels: vi.fn(),
    loadedModels: vi.fn(),
    loadedContextTokens: vi.fn(async () => undefined),
    runningModels: vi.fn(async () => []),
    loadModel: vi.fn(),
    modelContext: vi.fn(),
    chat: vi.fn(),
    chatStream: vi.fn(chatStream),
  };
  const createClient = vi.fn(() => client);
  const handler = createExplainHandler({
    getSettings: async () => settings,
    createClient,
    platform: 'windows',
  });
  return { handler, client, createClient };
}

describe('explain handler', () => {
  it('streams the prompt with the saved settings, passes each piece on, and parses the reply', async () => {
    const pieces = ['## What it does\nA.', "\n## Why it's needed\nB.", '\n## Concerns\nC.'];
    const { handler, client, createClient } = setup(streamOf(pieces));
    const chunks: string[] = [];
    const signal = new AbortController().signal;

    const result = await handler(
      { context: SAMPLE_CONTEXT },
      { onChunk: (text) => chunks.push(text), signal },
    );

    expect(result).toEqual({
      status: 'done',
      explanation: { what: 'A.', why: 'B.', concerns: 'C.' },
      model: 'qwen2.5-coder:7b',
      trace: expect.any(Object),
    });
    // With a log for its round trips (PR 9.2).
    expect(createClient).toHaveBeenCalledWith(SETTINGS, { roundTrips: expect.any(Object) });
    expect(chunks).toEqual(pieces);
    const [messages, options] = vi.mocked(client.chatStream).mock.calls[0] as [
      ChatMessage[],
      ChatOptions,
    ];
    expect(messages[0]!.content).toBe(EXPLAIN_SYSTEM_PROMPT);
    expect(messages[1]!.content).toContain(SAMPLE_CONTEXT);
    expect(options).toEqual({
      model: 'qwen2.5-coder:7b',
      temperature: SETTINGS.temperature,
      maxResponseTokens: SETTINGS.maxResponseTokens,
      // Automatic context size with no sizer: at most Ollama's usual default
      // (PR 6.2), and only as much as this small prompt needs (PR 8.5).
      contextTokens: 2048,
      // Keeps the model loaded between clicks (PR 8.3).
      keepAliveMinutes: SETTINGS.keepAliveMinutes,
      signal,
    });
  });

  it('adds the PR title and description to the prompt (PR 6.1)', async () => {
    const { handler, client } = setup(streamOf(['## What it does\nA.']));
    await handler({
      context: SAMPLE_CONTEXT,
      prInfo: { title: 'Add retries', description: 'Retry failed calls to the LLM.' },
    });
    const [messages] = vi.mocked(client.chatStream).mock.calls[0] as [ChatMessage[], ChatOptions];
    expect(messages[1]!.content).toContain('Pull request title: Add retries');
    expect(messages[1]!.content).toContain('Retry failed calls to the LLM.');
    expect(messages[1]!.content).toContain(SAMPLE_CONTEXT);
  });

  it('ignores PR info that is not a title and a description', async () => {
    const { handler, client } = setup(streamOf(['## What it does\nA.']));
    await handler({
      context: SAMPLE_CONTEXT,
      prInfo: { title: 7, description: null } as unknown as { title: string; description: string },
    });
    const [messages] = vi.mocked(client.chatStream).mock.calls[0] as [ChatMessage[], ChatOptions];
    expect(messages[1]!.content).not.toContain('Pull request title');
    expect(toPrInfo('text')).toBeUndefined();
    expect(toPrInfo({ title: 'T', description: 'D', extra: 1 })).toEqual({
      title: 'T',
      description: 'D',
    });
  });

  it('adds the block from the full file to the prompt (PR 6.3)', async () => {
    const { handler, client } = setup(streamOf(['## What it does\nA.']));
    await handler({ context: SAMPLE_CONTEXT, fileContext: SAMPLE_FILE_CONTEXT });
    const [messages] = vi.mocked(client.chatStream).mock.calls[0] as [ChatMessage[], ChatOptions];
    expect(messages[1]!.content).toContain('The lines around the code in the full file');
    expect(messages[1]!.content).toContain(
      "\nconst LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);",
    );
  });

  it('ignores file context that is not in the right shape', async () => {
    const { handler, client } = setup(streamOf(['## What it does\nA.']));
    await handler({
      context: SAMPLE_CONTEXT,
      fileContext: {
        ...SAMPLE_FILE_CONTEXT,
        lines: [1, 2],
      } as unknown as typeof SAMPLE_FILE_CONTEXT,
    });
    const [messages] = vi.mocked(client.chatStream).mock.calls[0] as [ChatMessage[], ChatOptions];
    expect(messages[1]!.content).not.toContain('full file');
    expect(toFileContext(SAMPLE_FILE_CONTEXT)).toEqual(SAMPLE_FILE_CONTEXT);
    expect(toFileContext({ ...SAMPLE_FILE_CONTEXT, extra: 1 })).toEqual(SAMPLE_FILE_CONTEXT);
    for (const bad of [
      'text',
      { ...SAMPLE_FILE_CONTEXT, kind: 'file' },
      { ...SAMPLE_FILE_CONTEXT, startLine: 0 },
      { ...SAMPLE_FILE_CONTEXT, focusEnd: 1.5 },
      { ...SAMPLE_FILE_CONTEXT, focusStart: 50, focusEnd: 40 },
      { ...SAMPLE_FILE_CONTEXT, lines: [] },
      { ...SAMPLE_FILE_CONTEXT, lines: Array(2001).fill('x') },
    ]) {
      expect(toFileContext(bad)).toBeUndefined();
    }
  });

  it("passes on the server's timings with the answer (PR 8.1)", async () => {
    const timings = { totalMs: 9_000, loadMs: 20, answerTokens: 200, answerMs: 8_000 };
    const { handler } = setup(async function* () {
      yield '## What it does\nA.';
      return { model: 'qwen2.5-coder:7b', timings };
    });
    const result = await handler({ context: SAMPLE_CONTEXT });
    expect(result).toMatchObject({ status: 'done', timings });
  });

  it('marks an answer that hit the answer limit as cut off (PR 8.4)', async () => {
    const { handler, client } = setup(async function* () {
      yield "## What it does\nA.\n## Why it's needed\nBecause the";
      return { model: 'qwen2.5-coder:7b', doneReason: 'length' };
    });
    const result = await handler({ context: SAMPLE_CONTEXT });
    expect(result).toMatchObject({
      status: 'done',
      explanation: { what: 'A.', why: 'Because the …', cutOff: true },
    });
    expect(vi.mocked(client.chatStream).mock.calls[0]![1].maxResponseTokens).toBe(120);
  });

  it('works without onChunk', async () => {
    const { handler } = setup(streamOf(['## What it does\nA.'], undefined, 'llama3'));
    await expect(handler({ context: SAMPLE_CONTEXT })).resolves.toMatchObject({
      status: 'done',
      model: 'llama3',
    });
  });

  it('returns a friendly message when the stream breaks midway', async () => {
    const chunks: string[] = [];
    const { handler } = setup(
      streamOf(['## What'], new LlmError('connection', 'stream ended early')),
    );
    const result = await handler(
      { context: SAMPLE_CONTEXT },
      { onChunk: (text) => chunks.push(text) },
    );
    expect(chunks).toEqual(['## What']);
    expect(result).toMatchObject({ status: 'failed', message: expect.stringContaining('Ollama') });
  });

  it('returns a friendly message and fix when the LLM call fails', async () => {
    const { handler } = setup(streamOf([], new LlmError('origin-blocked', 'HTTP 403')));

    const result = await handler({ context: SAMPLE_CONTEXT });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.message).toBe('Ollama blocked the request from this extension.');
    expect(result.fix).toContain('setx OLLAMA_ORIGINS'); // the Windows command
  });

  it('names the model in the fix when it is not installed', async () => {
    const { handler } = setup(streamOf([], new LlmError('model-not-found', 'model not found')));
    const result = await handler({ context: SAMPLE_CONTEXT });
    expect(result).toMatchObject({
      status: 'failed',
      fix: expect.stringContaining('ollama pull qwen2.5-coder:7b'),
    });
  });

  it('rejects an empty context without calling the model', async () => {
    const { handler, client } = setup(streamOf([]));
    await expect(handler({ context: '  ' })).rejects.toThrow('non-empty context');
    expect(client.chatStream).not.toHaveBeenCalled();
  });

  describe('tasks for the click trace (PR 9.1)', () => {
    /** A clock that moves 10 ms each time it is read, so every task has a length. */
    const ticking = () => {
      let time = 0;
      return () => (time += 10);
    };
    const keys = (result: { trace?: { tasks: { key: string }[] } }) =>
      result.trace!.tasks.map((t) => t.key);

    it('returns its tasks in order, timed from the request, with the first piece of the reply marked', async () => {
      const { client } = setup(streamOf(['## What it does\nA.', ' More.']));
      const handler = createExplainHandler({
        getSettings: async () => SETTINGS,
        createClient: () => client,
        platform: 'other',
        now: ticking(),
      });
      const result = await handler({ context: SAMPLE_CONTEXT });
      expect(keys(result)).toEqual(['settings', 'fit-prompt', 'loaded-window', 'model', 'parse']);
      const tasks = result.trace!.tasks;
      expect(tasks.every((t) => t.source === 'worker')).toBe(true);
      expect(tasks.every((t) => t.durationMs > 0 && !t.status)).toBe(true);
      // Each starts after the one before it ended.
      for (let i = 1; i < tasks.length; i++) {
        expect(tasks[i]!.startMs).toBeGreaterThanOrEqual(
          tasks[i - 1]!.startMs + tasks[i - 1]!.durationMs,
        );
      }
      const model = tasks.find((t) => t.key === 'model')!;
      expect(model.label).toBe('Wait for the model');
      expect(model.firstChunkMs).toBeGreaterThan(0);
      expect(model.firstChunkMs).toBeLessThan(model.durationMs);
      const last = tasks.at(-1)!;
      expect(result.trace!.totalMs).toBeGreaterThanOrEqual(last.startMs + last.durationMs);
    });

    it('includes the context-size lookup only when it asked the server', async () => {
      const { client } = setup(streamOf(['## What it does\nA.']));
      let known = false;
      const handler = createExplainHandler({
        getSettings: async () => SETTINGS,
        createClient: () => client,
        platform: 'other',
        contextTokens: async (_settings, _signal, onLookup) => {
          if (!known) onLookup?.();
          known = true;
          return 4096;
        },
      });
      expect(keys(await handler({ context: SAMPLE_CONTEXT }))).toContain('context-size');
      expect(keys(await handler({ context: SAMPLE_CONTEXT }))).not.toContain('context-size');
    });

    it('leaves out the loaded-window check when Context size is set', async () => {
      const { handler } = setup(streamOf(['## What it does\nA.']), {
        ...SETTINGS,
        contextTokens: 8192,
      });
      expect(keys(await handler({ context: SAMPLE_CONTEXT }))).toEqual([
        'settings',
        'fit-prompt',
        'model',
        'parse',
      ]);
    });

    it('marks the model task failed when the model fails', async () => {
      const { handler } = setup(streamOf([], new LlmError('connection', 'fetch failed')));
      const result = await handler({ context: SAMPLE_CONTEXT });
      expect(result.status).toBe('failed');
      expect(result.trace!.tasks.at(-1)).toMatchObject({ key: 'model', status: 'failed' });
    });

    it('marks building the prompt failed when the code is too long', async () => {
      const { handler } = setup(streamOf([]), { ...SETTINGS, contextTokens: 600 });
      const result = await handler({ context: 'x '.repeat(5000) });
      expect(result.status).toBe('failed');
      expect(result.trace!.tasks.at(-1)).toMatchObject({ key: 'fit-prompt', status: 'failed' });
    });
  });

  describe('context budget (PR 6.2)', () => {
    const DONE = ['## What it does\nA.'];
    const longContext = [
      'File: src/big.ts (TypeScript)',
      'Clicked line: added, line 41 of the new file',
      '+const target = 1;',
      '',
      'Surrounding diff (the clicked line starts with >):',
      ...Array.from(
        { length: 40 },
        (_, i) => ` const value${i} = compute(${i}); // nearby line ${i}`,
      ),
      '>+const target = 1;',
      ...Array.from(
        { length: 40 },
        (_, i) => ` const after${i} = compute(${i}); // later line ${i}`,
      ),
    ].join('\n');

    it('fits the prompt to the context size from the sizer, but runs only as big a window as it needs (PR 8.5)', async () => {
      const { client } = setup(streamOf(DONE));
      const contextTokens = vi.fn(async () => 8192);
      const handler = createExplainHandler({
        getSettings: async () => ({ ...SETTINGS, showPrompt: true }),
        createClient: () => client,
        platform: 'other',
        contextTokens,
      });
      const result = await handler({ context: SAMPLE_CONTEXT });
      expect(contextTokens).toHaveBeenCalledWith(
        { ...SETTINGS, showPrompt: true },
        undefined,
        expect.any(Function),
        expect.any(Object),
      );
      expect(vi.mocked(client.chatStream).mock.calls[0]![1].contextTokens).toBe(2048);
      expect(result.status === 'done' && result.prompt).toMatchObject({
        budget: 8192 - SETTINGS.maxResponseTokens - 32,
        contextTokens: 2048,
      });
    });

    it('keeps the window the model is loaded with when the prompt fits, so it is not reloaded (PR 8.5)', async () => {
      const { client } = setup(streamOf(DONE));
      vi.mocked(client.loadedContextTokens).mockResolvedValue(4096);
      const handler = createExplainHandler({
        getSettings: async () => SETTINGS,
        createClient: () => client,
        platform: 'other',
        contextTokens: async () => 8192,
      });
      await handler({ context: SAMPLE_CONTEXT });
      expect(client.loadedContextTokens).toHaveBeenCalledWith(SETTINGS.model, {
        signal: undefined,
      });
      expect(vi.mocked(client.chatStream).mock.calls[0]![1].contextTokens).toBe(4096);
    });

    it('goes ahead with the smallest window when the loaded window cannot be read', async () => {
      const { handler, client } = setup(streamOf(DONE));
      vi.mocked(client.loadedContextTokens).mockRejectedValue(new Error('down'));
      await handler({ context: SAMPLE_CONTEXT });
      expect(vi.mocked(client.chatStream).mock.calls[0]![1].contextTokens).toBe(2048);
    });

    describe('the remembered window (PR 9.7)', () => {
      function withMemory(chatStream: LlmClient['chatStream'], settings: () => Settings) {
        const { client } = setup(chatStream);
        vi.mocked(client.loadedContextTokens).mockResolvedValue(4096);
        const loadedWindow = createLoadedWindowMemory();
        const handler = createExplainHandler({
          getSettings: async () => settings(),
          createClient: () => client,
          platform: 'other',
          contextTokens: async () => 8192,
          loadedWindow,
        });
        return { handler, client, loadedWindow };
      }
      const traceKeys = (result: Awaited<ReturnType<ReturnType<typeof createExplainHandler>>>) =>
        result.trace!.tasks.map((t) => t.key);

      it('asks /api/ps once, then uses the window the last request ran with', async () => {
        const { handler, client, loadedWindow } = withMemory(streamOf(DONE), () => SETTINGS);
        const first = await handler({ context: SAMPLE_CONTEXT });
        expect(traceKeys(first)).toContain('loaded-window');
        expect(loadedWindow.known(SETTINGS)).toBe(4096);

        const second = await handler({ context: SAMPLE_CONTEXT });
        expect(client.loadedContextTokens).toHaveBeenCalledTimes(1);
        expect(traceKeys(second)).not.toContain('loaded-window');
        expect(vi.mocked(client.chatStream).mock.calls[1]![1].contextTokens).toBe(4096);
      });

      it('uses a window a chat question or warm-up left, without asking', async () => {
        const { handler, client, loadedWindow } = withMemory(streamOf(DONE), () => SETTINGS);
        loadedWindow.start(SETTINGS, 8192).done();
        await handler({ context: SAMPLE_CONTEXT });
        expect(client.loadedContextTokens).not.toHaveBeenCalled();
        expect(vi.mocked(client.chatStream).mock.calls[0]![1].contextTokens).toBe(8192);
      });

      it('asks again after the model or the server changes', async () => {
        let settings = SETTINGS;
        const { handler, client } = withMemory(streamOf(DONE), () => settings);
        await handler({ context: SAMPLE_CONTEXT });
        settings = { ...SETTINGS, model: 'deepseek-r1:7b' };
        await handler({ context: SAMPLE_CONTEXT });
        expect(client.loadedContextTokens).toHaveBeenCalledTimes(2);
        expect(vi.mocked(client.loadedContextTokens).mock.calls[1]![0]).toBe('deepseek-r1:7b');
        settings = { ...settings, llmUrl: 'http://127.0.0.1:11434' };
        await handler({ context: SAMPLE_CONTEXT });
        expect(client.loadedContextTokens).toHaveBeenCalledTimes(3);
        // Back to a model and server it now knows: no question.
        await handler({ context: SAMPLE_CONTEXT });
        expect(client.loadedContextTokens).toHaveBeenCalledTimes(3);
      });

      it('asks again after a failed or stopped request', async () => {
        const { handler, client, loadedWindow } = withMemory(streamOf(DONE), () => SETTINGS);
        await handler({ context: SAMPLE_CONTEXT });
        vi.mocked(client.chatStream).mockImplementationOnce(
          streamOf([], new LlmError('connection', 'down')),
        );
        const failed = await handler({ context: SAMPLE_CONTEXT });
        expect(failed.status).toBe('failed');
        expect(loadedWindow.known(SETTINGS)).toBeUndefined();
        await handler({ context: SAMPLE_CONTEXT });
        expect(client.loadedContextTokens).toHaveBeenCalledTimes(2);
      });

      it('lets the newer of two overlapping explanations decide, whichever ends first', async () => {
        // The first request's reply waits until released; the second answers at once.
        let release!: () => void;
        const slow = new Promise<void>((resolve) => (release = resolve));
        let calls = 0;
        const { handler, client, loadedWindow } = withMemory(
          async function* () {
            if (++calls === 1) await slow;
            yield '## What it does\nA.';
            return { model: SETTINGS.model, doneReason: 'stop' } as ChatStreamEnd;
          },
          () => SETTINGS,
        );
        // Known to be 4096 from /api/ps for the first; the second is sent with a set size.
        const first = handler({ context: SAMPLE_CONTEXT });
        await vi.waitFor(() => expect(client.chatStream).toHaveBeenCalledTimes(1));
        loadedWindow.start(SETTINGS, 8192).done();
        release();
        await first;
        expect(loadedWindow.known(SETTINGS)).toBe(8192);
      });

      it('keeps a newer window when an older explanation then fails', async () => {
        let fail!: (error: Error) => void;
        const failing = new Promise<never>((_, reject) => (fail = reject));
        const { handler, client, loadedWindow } = withMemory(
          async function* () {
            yield await failing;
            return { model: SETTINGS.model, doneReason: 'stop' } as ChatStreamEnd;
          },
          () => SETTINGS,
        );
        const first = handler({ context: SAMPLE_CONTEXT });
        await vi.waitFor(() => expect(client.chatStream).toHaveBeenCalledTimes(1));
        loadedWindow.start(SETTINGS, 8192).done();
        fail(new LlmError('connection', 'down'));
        expect((await first).status).toBe('failed');
        expect(loadedWindow.known(SETTINGS)).toBe(8192);
      });

      it('does not touch what it knows for a cached answer', async () => {
        const store = new Map<string, unknown>();
        const { client } = setup(streamOf(DONE));
        const loadedWindow = createLoadedWindowMemory();
        loadedWindow.start(SETTINGS, 4096).done();
        const handler = createExplainHandler({
          getSettings: async () => SETTINGS,
          createClient: () => client,
          platform: 'other',
          loadedWindow,
          cache: {
            get: async (key) => (store.get(key) as never) ?? null,
            set: async (key, value) => void store.set(key, value),
          },
        });
        await handler({ context: SAMPLE_CONTEXT, pr: 'o/r#1' });
        loadedWindow.forget();
        const hit = await handler({ context: SAMPLE_CONTEXT, pr: 'o/r#1' });
        expect(hit.status === 'done' && hit.cached).toBeTruthy();
        expect(client.loadedContextTokens).not.toHaveBeenCalled();
        expect(loadedWindow.known(SETTINGS)).toBeUndefined();
      });
    });

    it('sends a Context size the user set as it is, without asking what is loaded', async () => {
      const { handler, client } = setup(streamOf(DONE), { ...SETTINGS, contextTokens: 8192 });
      await handler({ context: SAMPLE_CONTEXT });
      expect(client.loadedContextTokens).not.toHaveBeenCalled();
      expect(vi.mocked(client.chatStream).mock.calls[0]![1].contextTokens).toBe(8192);
    });

    it('trims the lines around the code to fit a 1024-token context', async () => {
      const { handler, client } = setup(streamOf(DONE), { ...SETTINGS, contextTokens: 1024 });
      const result = await handler({ context: longContext });
      expect(result.status).toBe('done');
      const [messages, options] = vi.mocked(client.chatStream).mock.calls[0]!;
      expect(options.contextTokens).toBe(1024);
      expect(messages[1]!.content).toContain('>+const target = 1;');
      expect(messages[1]!.content).toMatch(/earlier lines left out/);
      expect(messages[1]!.content).not.toContain('nearby line 0\n');
    });

    it('says the code is too long, with a fix, instead of calling the model', async () => {
      const { handler, client } = setup(streamOf(DONE), {
        ...SETTINGS,
        contextTokens: 1024,
        maxResponseTokens: 1000,
      });
      const result = await handler({ context: SAMPLE_CONTEXT });
      expect(result).toMatchObject({
        status: 'failed',
        message: expect.stringContaining("too long for the model's context"),
        fix: expect.stringContaining('**Context size**'),
      });
      expect(client.chatStream).not.toHaveBeenCalled();
    });

    it('returns the prompt as sent when Show prompt is on, and not otherwise', async () => {
      const on = setup(streamOf(DONE), { ...SETTINGS, contextTokens: 1024, showPrompt: true });
      const result = await on.handler({ context: longContext });
      expect(result).toMatchObject({
        status: 'done',
        prompt: {
          contextTokens: 1024,
          budget: 1024 - SETTINGS.maxResponseTokens - 32,
          trimmed: ['lines around the code'],
        },
      });
      if (result.status !== 'done') return;
      const sent = vi.mocked(on.client.chatStream).mock.calls[0]![0];
      expect(result.prompt!.text).toBe(
        `[system]\n${sent[0]!.content}\n\n[user]\n${sent[1]!.content}`,
      );
      expect(result.prompt!.tokens).toBeLessThanOrEqual(result.prompt!.budget);

      const off = setup(streamOf(DONE));
      expect(await off.handler({ context: SAMPLE_CONTEXT })).not.toHaveProperty('prompt');
    });
  });

  describe('round trips (PR 9.2)', () => {
    const REPLY = "## What it does\nA.\n## Why it's needed\nB.\n## Concerns\nC.";
    /** A fake Ollama: /api/show, /api/ps, and a streamed /api/chat. */
    const ollama = (chat: () => Response) =>
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/show')) {
          return new Response(JSON.stringify({ model_info: { 'qwen2.context_length': 32768 } }));
        }
        if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
        return chat();
      });
    const streamedReply = () =>
      new Response(
        JSON.stringify({ message: { content: REPLY } }) +
          '\n' +
          JSON.stringify({ done: true, done_reason: 'stop' }) +
          '\n',
      );
    const handlerWith = (fetch: ReturnType<typeof ollama>, extra = {}) =>
      createExplainHandler({
        getSettings: async () => SETTINGS,
        createClient: (settings, options) => createLlmClient(settings, { fetch, ...options }),
        platform: 'other',
        contextTokens: createContextSizer((settings, options) =>
          createLlmClient(settings, { fetch, ...options }),
        ),
        ...extra,
      });

    it("returns every round trip to Ollama with the result, with the explanation's prompt and reply", async () => {
      const result = await handlerWith(ollama(streamedReply))({ context: SAMPLE_CONTEXT });
      expect(result.status).toBe('done');
      const trips = result.trace!.roundTrips!;
      expect(trips.map((t) => [t.endpoint, t.purpose, t.cause, t.status])).toEqual([
        ['localhost:11434/api/show', 'model details', 'click', 'done'],
        ['localhost:11434/api/ps', 'loaded window', 'click', 'done'],
        ['localhost:11434/api/chat', 'explanation', 'click', 'done'],
      ]);
      const chat = trips[2]!;
      expect(chat.messages![0]).toEqual({ role: 'system', content: EXPLAIN_SYSTEM_PROMPT });
      expect(chat.messages![1]!.content).toContain(SAMPLE_CONTEXT);
      expect(chat.reply).toBe(REPLY);
    });

    it('returns the failed round trip with a failed answer', async () => {
      const fetch = ollama(() => {
        throw new TypeError('Failed to fetch');
      });
      const result = await handlerWith(fetch)({ context: SAMPLE_CONTEXT });
      expect(result.status).toBe('failed');
      expect(result.trace!.roundTrips!.at(-1)).toMatchObject({
        purpose: 'explanation',
        status: 'failed',
        error: 'Failed to fetch',
      });
    });

    it("hands each round trip to the debug log as it ends, in the click's group (PR 9.3)", async () => {
      const ended: [string, string, string][] = [];
      const result = await handlerWith(ollama(streamedReply), {
        onRoundTrip: (
          trip: { purpose: string; status: string },
          log: { group: string; cause: string },
        ) => {
          if (trip.status !== 'running') ended.push([log.group, log.cause, trip.purpose]);
        },
      })({ context: SAMPLE_CONTEXT, debugId: 'click-7' });
      expect(result.status).toBe('done');
      expect(ended).toEqual([
        ['click-7', 'click', 'model details'],
        ['click-7', 'click', 'loaded window'],
        ['click-7', 'click', 'explanation'],
      ]);
    });

    it('marks the round trips of Explain on hover, and lists a warm-up still loading the model', async () => {
      const warmup = createRoundTripLog('warmup');
      await warmup.record(
        'http://localhost:11434/api/ps',
        { method: 'GET' },
        async () => new Response('{}'),
      );
      const result = await handlerWith(ollama(streamedReply), {
        warmupRoundTrips: () => [warmup],
      })({ context: SAMPLE_CONTEXT, cause: 'hover' });
      const trips = result.trace!.roundTrips!;
      expect(trips[0]).toMatchObject({ cause: 'warmup', purpose: 'is the model loaded' });
      expect(trips.slice(1).every((t) => t.cause === 'hover')).toBe(true);
    });
  });

  describe('thinking (PR 9.5)', () => {
    const ANSWER = ['## What it does\nA.', "\n## Why it's needed\nB.", '\n## Concerns\nC.'];
    const REASONING = { ...SETTINGS, model: 'deepseek-r1:7b' };

    function thinkingSetup(
      capabilities: string[] | undefined,
      settings: Settings = REASONING,
      end: Partial<ChatStreamEnd> = {},
      thinkValues?: (boolean | string)[],
    ) {
      const client: LlmClient = {
        listModels: vi.fn(),
        loadedModels: vi.fn(),
        loadedContextTokens: vi.fn(async () => undefined),
        runningModels: vi.fn(async () => []),
        loadModel: vi.fn(),
        modelContext: vi.fn(async () => ({
          maxTokens: 131072,
          ...(capabilities && { capabilities }),
          ...(thinkValues && { thinkValues }),
        })),
        chat: vi.fn(),
        chatStream: vi.fn(async function* () {
          for (const piece of ANSWER) yield piece;
          return { model: settings.model, doneReason: 'stop', ...end };
        }),
      };
      const { contextTokens, thinking } = createModelLookup(() => client);
      const handler = createExplainHandler({
        getSettings: async () => settings,
        createClient: () => client,
        platform: 'windows',
        contextTokens,
        thinking,
      });
      const options = () =>
        (vi.mocked(client.chatStream).mock.calls[0] as [unknown, ChatOptions])[1];
      return { handler, client, options };
    }

    it('turns thinking off for a reasoning model, with no extra round trip', async () => {
      const { handler, client, options } = thinkingSetup(['completion', 'thinking']);
      const result = await handler({ context: SAMPLE_CONTEXT });
      expect(options().think).toBe(false);
      // The capabilities came with the context size.
      expect(client.modelContext).toHaveBeenCalledTimes(1);
      expect(result.trace?.tasks.map((t) => t.key)).not.toContain('can-think');
    });

    it('lets it think with the setting on, and keeps the thinking out of the answer', async () => {
      const { handler, options } = thinkingSetup(
        ['completion', 'thinking'],
        { ...REASONING, letModelThink: true },
        { thinking: 'The user wants three sections.' },
      );
      const result = await handler({ context: SAMPLE_CONTEXT });
      expect(options().think).toBe(true);
      expect(result).toMatchObject({
        status: 'done',
        explanation: { what: 'A.', why: 'B.', concerns: 'C.' },
        thinking: 'The user wants three sections.',
      });
    });

    it('sends no think for a model that cannot think, or when Ollama does not say', async () => {
      for (const capabilities of [['completion'], undefined]) {
        const { handler, options } = thinkingSetup(capabilities, {
          ...REASONING,
          letModelThink: true,
        });
        await handler({ context: SAMPLE_CONTEXT });
        expect(options()).not.toHaveProperty('think');
      }
    });

    it('sends only the think values the model takes (PR 9.5 review)', async () => {
      // A model that says it takes true and false.
      const toggle = thinkingSetup(['thinking'], REASONING, {}, [true, false]);
      await toggle.handler({ context: SAMPLE_CONTEXT });
      expect(toggle.options().think).toBe(false);
      // A model such as gpt-oss that only takes levels: its lowest level when
      // thinking is off, and its own default when it is on.
      const levels = ['low', 'medium', 'high'];
      const off = thinkingSetup(['thinking'], REASONING, {}, levels);
      await off.handler({ context: SAMPLE_CONTEXT });
      expect(off.options().think).toBe('low');
      const on = thinkingSetup(['thinking'], { ...REASONING, letModelThink: true }, {}, levels);
      await on.handler({ context: SAMPLE_CONTEXT });
      expect(on.options()).not.toHaveProperty('think');
    });

    it('checks the model once, as its own task, when Context size is set', async () => {
      const { handler, client, options } = thinkingSetup(['thinking'], {
        ...REASONING,
        contextTokens: 4096,
      });
      const first = await handler({ context: SAMPLE_CONTEXT });
      expect(options().think).toBe(false);
      expect(first.trace?.tasks.map((t) => t.key)).toContain('can-think');
      const second = await handler({ context: SAMPLE_CONTEXT });
      expect(second.trace?.tasks.map((t) => t.key)).not.toContain('can-think');
      expect(client.modelContext).toHaveBeenCalledTimes(1);
    });

    it('never sends think without a capability check', async () => {
      const { handler, client } = setup(streamOf(ANSWER), REASONING);
      await handler({ context: SAMPLE_CONTEXT });
      const [, options] = vi.mocked(client.chatStream).mock.calls[0] as [unknown, ChatOptions];
      expect(options).not.toHaveProperty('think');
    });
  });
});
