import {
  AUTO_CONTEXT_TOKENS,
  createContextSizer,
  createModelLookup,
  FALLBACK_CONTEXT_TOKENS,
  promptBudget,
  thinkOption,
} from '../src/llm/contextSize';
import type { LlmClient, ModelContext } from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };

function setup(modelContext: () => Promise<ModelContext>) {
  const client: LlmClient = {
    listModels: vi.fn(),
    loadedModels: vi.fn(),
    loadedContextTokens: vi.fn(async () => undefined),
    runningModels: vi.fn(async () => []),
    loadModel: vi.fn(),
    modelContext: vi.fn(modelContext),
    chat: vi.fn(),
    chatStream: vi.fn(),
  };
  return { sizer: createContextSizer(() => client), client };
}

describe('createContextSizer', () => {
  it('uses the Context size setting without asking the server', async () => {
    const { sizer, client } = setup(async () => ({ maxTokens: 32768 }));
    expect(await sizer({ ...SETTINGS, contextTokens: 2048 })).toBe(2048);
    expect(client.modelContext).not.toHaveBeenCalled();
  });

  it('on automatic, caps the model trained size', async () => {
    expect(await setup(async () => ({ maxTokens: 32768 })).sizer(SETTINGS)).toBe(
      AUTO_CONTEXT_TOKENS,
    );
    expect(await setup(async () => ({ maxTokens: 2048 })).sizer(SETTINGS)).toBe(2048);
  });

  it("on automatic, follows the model's own num_ctx, within its trained size", async () => {
    expect(
      await setup(async () => ({ maxTokens: 32768, configuredTokens: 8192 })).sizer(SETTINGS),
    ).toBe(8192);
    expect(
      await setup(async () => ({ maxTokens: 4096, configuredTokens: 8192 })).sizer(SETTINGS),
    ).toBe(4096);
  });

  it('asks once per server and model', async () => {
    const { sizer, client } = setup(async () => ({ maxTokens: 2048 }));
    await sizer(SETTINGS);
    await sizer(SETTINGS);
    expect(client.modelContext).toHaveBeenCalledTimes(1);
    await sizer({ ...SETTINGS, model: 'llama3.2:3b' });
    expect(client.modelContext).toHaveBeenCalledTimes(2);
  });

  it('falls back when the server cannot say, and asks again next time', async () => {
    const { sizer, client } = setup(async () => {
      throw new Error('offline');
    });
    expect(await sizer(SETTINGS)).toBe(FALLBACK_CONTEXT_TOKENS);
    await sizer(SETTINGS);
    expect(client.modelContext).toHaveBeenCalledTimes(2);
  });
});

describe('promptBudget', () => {
  it('leaves room for the answer and a small margin', () => {
    expect(promptBudget(4096, 1024)).toBe(4096 - 1024 - 32);
  });
});

describe('createModelLookup (PR 9.5)', () => {
  function lookup(modelContext: () => Promise<ModelContext>) {
    const client = {
      listModels: vi.fn(),
      loadedModels: vi.fn(),
      loadedContextTokens: vi.fn(async () => undefined),
      runningModels: vi.fn(async () => []),
      loadModel: vi.fn(),
      modelContext: vi.fn(modelContext),
      chat: vi.fn(),
      chatStream: vi.fn(),
    } satisfies LlmClient;
    return { ...createModelLookup(() => client), client };
  }
  const REASONING = async () => ({ maxTokens: 2048, capabilities: ['completion', 'thinking'] });

  it('reads the capabilities with the context size, from one /api/show call', async () => {
    const { contextTokens, thinking, client } = lookup(REASONING);
    expect(await contextTokens(SETTINGS)).toBe(2048);
    const onLookup = vi.fn();
    expect(await thinking(SETTINGS, undefined, onLookup)).toEqual({});
    expect(client.modelContext).toHaveBeenCalledTimes(1);
    // Already known, so no lookup is reported.
    expect(onLookup).not.toHaveBeenCalled();
  });

  it('looks the model up once even with a set Context size', async () => {
    const { contextTokens, thinking, client } = lookup(REASONING);
    const set = { ...SETTINGS, contextTokens: 8192 };
    expect(await contextTokens(set)).toBe(8192);
    expect(client.modelContext).not.toHaveBeenCalled();
    const onLookup = vi.fn();
    expect(await thinking(set, undefined, onLookup)).toEqual({});
    expect(await thinking(set)).toEqual({});
    expect(onLookup).toHaveBeenCalledTimes(1);
    expect(client.modelContext).toHaveBeenCalledTimes(1);
  });

  it('passes on the think values the server lists', async () => {
    const levels = lookup(async () => ({
      capabilities: ['thinking'],
      thinkValues: ['low', 'medium', 'high'],
    }));
    expect(await levels.thinking(SETTINGS)).toEqual({ values: ['low', 'medium', 'high'] });
  });

  it('says null for a model without thinking, and undefined when the server does not say', async () => {
    expect(
      await lookup(async () => ({ capabilities: ['completion'] })).thinking(SETTINGS),
    ).toBeNull();
    expect(await lookup(async () => ({ maxTokens: 2048 })).thinking(SETTINGS)).toBeUndefined();
  });

  it('says undefined when the lookup fails, and asks again next time', async () => {
    const { thinking, client } = lookup(async () => {
      throw new Error('offline');
    });
    expect(await thinking(SETTINGS)).toBeUndefined();
    expect(await thinking(SETTINGS)).toBeUndefined();
    expect(client.modelContext).toHaveBeenCalledTimes(2);
  });

  it('asks nothing without a model', async () => {
    const { thinking, client } = lookup(REASONING);
    expect(await thinking({ ...SETTINGS, model: '' })).toBeUndefined();
    expect(client.modelContext).not.toHaveBeenCalled();
  });
});

describe('thinkOption (PR 9.5)', () => {
  it('turns thinking off for a reasoning model unless the setting is on', () => {
    // An older Ollama that lists the capability but not the values.
    expect(thinkOption({}, false)).toBe(false);
    expect(thinkOption({}, true)).toBe(true);
    // A model that says it takes true and false.
    expect(thinkOption({ values: [false, true] }, false)).toBe(false);
    expect(thinkOption({ values: [true, false] }, true)).toBe(true);
  });

  it('sends the lowest level to a model that cannot turn thinking off, and its default when on', () => {
    // Such as gpt-oss, which ignores true and false.
    const levels = { values: ['high', 'low', 'medium'] };
    expect(thinkOption(levels, false)).toBe('low');
    expect(thinkOption(levels, true)).toBeUndefined();
    expect(thinkOption({ values: ['medium', 'max'] }, false)).toBe('medium');
    // A level Ollama does not name still beats sending something unsupported.
    expect(thinkOption({ values: ['brief'] }, false)).toBe('brief');
    // Thinking that can only be on: nothing to send.
    expect(thinkOption({ values: [true] }, false)).toBeUndefined();
    expect(thinkOption({ values: [true] }, true)).toBe(true);
  });

  it('sends nothing for other models or when it is not known', () => {
    expect(thinkOption(null, true)).toBeUndefined();
    expect(thinkOption(undefined, false)).toBeUndefined();
  });
});
