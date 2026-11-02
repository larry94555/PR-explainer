import { createExplainHandler, toPrInfo } from '../src/explain/explainHandler';
import { EXPLAIN_SYSTEM_PROMPT } from '../src/explain/explainPrompt';
import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';
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

function setup(chatStream: LlmClient['chatStream']) {
  const client: LlmClient = {
    listModels: vi.fn(),
    chat: vi.fn(),
    chatStream: vi.fn(chatStream),
  };
  const createClient = vi.fn(() => client);
  const handler = createExplainHandler({
    getSettings: async () => SETTINGS,
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
});
