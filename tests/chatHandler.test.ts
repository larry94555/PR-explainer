import { createChatHandler, isChatMessages } from '../src/chat/chatHandler';
import {
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatStreamEnd,
  type LlmClient,
} from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };
const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You help review a PR.' },
  { role: 'user', content: 'Explain this code.' },
  { role: 'assistant', content: '## What it does\nA.' },
  { role: 'user', content: 'How would I unit test this?' },
];

function setup(pieces: string[], error?: Error) {
  const chatStream = vi.fn<
    (messages: ChatMessage[], options: ChatOptions) => AsyncGenerator<string, ChatStreamEnd>
  >(async function* () {
    for (const piece of pieces) yield piece;
    if (error) throw error;
    return { model: SETTINGS.model, doneReason: 'stop' };
  });
  const client: LlmClient = {
    listModels: vi.fn(),
    loadedModels: vi.fn(),
    loadModel: vi.fn(),
    modelContext: vi.fn(),
    chat: vi.fn(),
    chatStream,
  };
  const handler = createChatHandler({
    getSettings: async () => SETTINGS,
    createClient: () => client,
    platform: 'windows',
  });
  return { handler, chatStream };
}

describe('chat handler', () => {
  it('streams the messages with the saved settings and returns the whole answer', async () => {
    const { handler, chatStream } = setup(['Use ', 'fake timers.']);
    const chunks: string[] = [];
    const signal = new AbortController().signal;
    const result = await handler(
      { messages: MESSAGES },
      { onChunk: (t) => chunks.push(t), signal },
    );
    expect(result).toEqual({ status: 'done', answer: 'Use fake timers.', model: SETTINGS.model });
    expect(chunks).toEqual(['Use ', 'fake timers.']);
    expect(chatStream).toHaveBeenCalledWith(MESSAGES, {
      model: SETTINGS.model,
      temperature: SETTINGS.temperature,
      maxResponseTokens: SETTINGS.maxResponseTokens,
      // Keeps the model loaded between questions (PR 8.3).
      keepAliveMinutes: SETTINGS.keepAliveMinutes,
      signal,
    });
  });

  it('returns a message and fix when the LLM fails', async () => {
    const { handler } = setup(['Use '], new LlmError('connection', 'fetch failed'));
    const result = await handler({ messages: MESSAGES });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toContain(SETTINGS.llmUrl);
  });

  it('rejects messages that do not end with a question, without calling the model', async () => {
    const { handler, chatStream } = setup([]);
    await expect(handler({ messages: MESSAGES.slice(0, 3) })).rejects.toThrow(
      /ends with a question/,
    );
    await expect(handler({ messages: [] })).rejects.toThrow();
    await expect(
      handler({ messages: [{ role: 'tool', content: 'x' }] as unknown as ChatMessage[] }),
    ).rejects.toThrow();
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('isChatMessages checks every message', () => {
    expect(isChatMessages(MESSAGES)).toBe(true);
    expect(isChatMessages('hello')).toBe(false);
    expect(isChatMessages([{ role: 'user', content: 3 }])).toBe(false);
    expect(isChatMessages([null])).toBe(false);
  });

  it('runs the model with the same context size as explanations (PR 6.2)', async () => {
    const { chatStream } = setup(['OK']);
    const client: LlmClient = {
      listModels: vi.fn(),
      loadedModels: vi.fn(),
      loadModel: vi.fn(),
      modelContext: vi.fn(),
      chat: vi.fn(),
      chatStream,
    };
    const handler = createChatHandler({
      getSettings: async () => SETTINGS,
      createClient: () => client,
      platform: 'other',
      contextTokens: async () => 2048,
    });
    await handler({ messages: MESSAGES });
    expect(chatStream.mock.calls[0]![1].contextTokens).toBe(2048);
  });
});
