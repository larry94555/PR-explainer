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
    });
    expect(createClient).toHaveBeenCalledWith(SETTINGS);
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
    expect(vi.mocked(client.chatStream).mock.calls[0]![1].maxResponseTokens).toBe(300);
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
      expect(contextTokens).toHaveBeenCalledWith({ ...SETTINGS, showPrompt: true }, undefined);
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
});
