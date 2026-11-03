import { createChatHandler, isChatMessages } from '../src/chat/chatHandler';
import { createLlmClient } from '../src/llm/createClient';
import { createLoadedWindowMemory } from '../src/llm/loadedWindow';
import type { RoundTrip } from '../src/trace/types';
import {
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatStreamEnd,
  type LlmClient,
  type ThinkingSupport,
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
    loadedContextTokens: vi.fn(async () => undefined),
    runningModels: vi.fn(async () => []),
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
      // Chat answers may be longer than the explanation limit (PR 8.4).
      maxResponseTokens: 1024,
      // Keeps the model loaded between questions (PR 8.3).
      keepAliveMinutes: SETTINGS.keepAliveMinutes,
      signal,
    });
  });

  it('sends a higher answer limit as it is (PR 8.4)', async () => {
    const { chatStream } = setup(['A.']);
    const handler = createChatHandler({
      getSettings: async () => ({ ...SETTINGS, maxResponseTokens: 4000 }),
      createClient: () => ({
        listModels: vi.fn(),
        loadedModels: vi.fn(),
        loadedContextTokens: vi.fn(async () => undefined),
        runningModels: vi.fn(async () => []),
        loadModel: vi.fn(),
        modelContext: vi.fn(),
        chat: vi.fn(),
        chatStream,
      }),
      platform: 'windows',
    });
    await handler({ messages: MESSAGES });
    expect(chatStream.mock.calls[0]![1].maxResponseTokens).toBe(4000);
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
      loadedContextTokens: vi.fn(async () => undefined),
      runningModels: vi.fn(async () => []),
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

  it('records its round trips for the debug log, as a chat group (PR 9.3)', async () => {
    const ended: { trip: RoundTrip; cause: string; group: string }[] = [];
    const reply = JSON.stringify({ message: { content: 'Use fake timers.' } }) + '\n';
    const done = JSON.stringify({ done: true, model: SETTINGS.model, done_reason: 'stop' }) + '\n';
    const fetch = vi.fn(async () => new Response(reply + done));
    const handler = createChatHandler({
      getSettings: async () => SETTINGS,
      createClient: (settings, options) => createLlmClient(settings, { fetch, ...options }),
      platform: 'other',
      onRoundTrip: (trip, log) => {
        if (trip.status !== 'running') ended.push({ trip, cause: log.cause, group: log.group });
      },
    });
    const result = await handler({ messages: MESSAGES });
    expect(result).toMatchObject({ status: 'done', answer: 'Use fake timers.' });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      cause: 'chat',
      trip: {
        purpose: 'chat answer',
        cause: 'chat',
        messages: MESSAGES,
        reply: 'Use fake timers.',
      },
    });
  });

  describe('thinking (PR 9.5)', () => {
    async function ask(thinks: ThinkingSupport | null | undefined, letModelThink: boolean) {
      const { chatStream } = setup(['A.']);
      const handler = createChatHandler({
        getSettings: async () => ({ ...SETTINGS, letModelThink }),
        createClient: () => ({
          listModels: vi.fn(),
          loadedModels: vi.fn(),
          loadedContextTokens: vi.fn(async () => undefined),
          runningModels: vi.fn(async () => []),
          loadModel: vi.fn(),
          modelContext: vi.fn(),
          chat: vi.fn(),
          chatStream,
        }),
        platform: 'windows',
        thinking: async () => thinks,
      });
      const result = await handler({ messages: MESSAGES });
      return { result, options: chatStream.mock.calls[0]![1] };
    }

    it('follows the same setting as explanations', async () => {
      expect((await ask({}, false)).options.think).toBe(false);
      expect((await ask({}, true)).options.think).toBe(true);
      expect((await ask({ values: ['low', 'high'] }, false)).options.think).toBe('low');
      expect((await ask(null, true)).options).not.toHaveProperty('think');
      expect((await ask(undefined, false)).options).not.toHaveProperty('think');
    });

    it('answers with only the answer, never the thinking', async () => {
      expect((await ask({}, true)).result).toEqual({
        status: 'done',
        answer: 'A.',
        model: SETTINGS.model,
      });
    });
  });
});

describe('chat handler and the remembered window (PR 9.7)', () => {
  function withMemory(error?: Error, contextTokens?: number) {
    const client = {
      chatStream: vi.fn(async function* () {
        yield 'Answer.';
        if (error) throw error;
        return { model: SETTINGS.model, doneReason: 'stop' } as ChatStreamEnd;
      }),
    } as unknown as LlmClient;
    const loadedWindow = createLoadedWindowMemory();
    const handler = createChatHandler({
      getSettings: async () => SETTINGS,
      createClient: () => client,
      platform: 'windows',
      ...(contextTokens !== undefined && { contextTokens: async () => contextTokens }),
      loadedWindow,
    });
    return { handler, loadedWindow };
  }

  it('remembers the window a question ran with, so the next click need not ask', async () => {
    const { handler, loadedWindow } = withMemory(undefined, 8192);
    await handler({ messages: MESSAGES });
    expect(loadedWindow.known(SETTINGS)).toBe(8192);
  });

  it("forgets after a question sent with the server's own window, or a failed one", async () => {
    const plain = withMemory();
    plain.loadedWindow.remember(SETTINGS, 4096);
    await plain.handler({ messages: MESSAGES });
    expect(plain.loadedWindow.known(SETTINGS)).toBeUndefined();

    const failed = withMemory(new LlmError('connection', 'down'), 8192);
    failed.loadedWindow.remember(SETTINGS, 4096);
    const result = await failed.handler({ messages: MESSAGES });
    expect(result.status).toBe('failed');
    expect(failed.loadedWindow.known(SETTINGS)).toBeUndefined();
  });
});
