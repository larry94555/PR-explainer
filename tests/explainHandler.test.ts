import { createExplainHandler } from '../src/explain/explainHandler';
import { EXPLAIN_SYSTEM_PROMPT } from '../src/explain/explainPrompt';
import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';
import { LlmError, type ChatMessage, type ChatOptions, type LlmClient } from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };

function setup(chat: LlmClient['chat']) {
  const client: LlmClient = { listModels: vi.fn(), chat: vi.fn(chat) };
  const createClient = vi.fn(() => client);
  const handler = createExplainHandler({
    getSettings: async () => SETTINGS,
    createClient,
    platform: 'windows',
  });
  return { handler, client, createClient };
}

describe('explain handler', () => {
  it('sends the prompt with the saved settings and parses the reply', async () => {
    const { handler, client, createClient } = setup(async () => ({
      content: "## What it does\nA.\n## Why it's needed\nB.\n## Concerns\nC.",
      model: 'qwen2.5-coder:7b',
    }));

    const result = await handler({ context: SAMPLE_CONTEXT });

    expect(result).toEqual({
      status: 'done',
      explanation: { what: 'A.', why: 'B.', concerns: 'C.' },
      model: 'qwen2.5-coder:7b',
    });
    expect(createClient).toHaveBeenCalledWith(SETTINGS);
    const [messages, options] = vi.mocked(client.chat).mock.calls[0] as [
      ChatMessage[],
      ChatOptions,
    ];
    expect(messages[0]!.content).toBe(EXPLAIN_SYSTEM_PROMPT);
    expect(messages[1]!.content).toContain(SAMPLE_CONTEXT);
    expect(options).toEqual({
      model: 'qwen2.5-coder:7b',
      temperature: SETTINGS.temperature,
      maxResponseTokens: SETTINGS.maxResponseTokens,
    });
  });

  it('returns a friendly message and fix when the LLM call fails', async () => {
    const { handler } = setup(async () => {
      throw new LlmError('origin-blocked', 'HTTP 403');
    });

    const result = await handler({ context: SAMPLE_CONTEXT });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.message).toBe('Ollama blocked the request from this extension.');
    expect(result.fix).toContain('setx OLLAMA_ORIGINS'); // the Windows command
  });

  it('names the model in the fix when it is not installed', async () => {
    const { handler } = setup(async () => {
      throw new LlmError('model-not-found', 'model not found');
    });
    const result = await handler({ context: SAMPLE_CONTEXT });
    expect(result).toMatchObject({
      status: 'failed',
      fix: expect.stringContaining('ollama pull qwen2.5-coder:7b'),
    });
  });

  it('rejects an empty context without calling the model', async () => {
    const { handler, client } = setup(async () => ({ content: '', model: 'm' }));
    await expect(handler({ context: '  ' })).rejects.toThrow('non-empty context');
    expect(client.chat).not.toHaveBeenCalled();
  });
});
