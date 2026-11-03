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
    const { contextTokens, canThink, client } = lookup(REASONING);
    expect(await contextTokens(SETTINGS)).toBe(2048);
    const onLookup = vi.fn();
    expect(await canThink(SETTINGS, undefined, onLookup)).toBe(true);
    expect(client.modelContext).toHaveBeenCalledTimes(1);
    // Already known, so no lookup is reported.
    expect(onLookup).not.toHaveBeenCalled();
  });

  it('looks the model up once even with a set Context size', async () => {
    const { contextTokens, canThink, client } = lookup(REASONING);
    const set = { ...SETTINGS, contextTokens: 8192 };
    expect(await contextTokens(set)).toBe(8192);
    expect(client.modelContext).not.toHaveBeenCalled();
    const onLookup = vi.fn();
    expect(await canThink(set, undefined, onLookup)).toBe(true);
    expect(await canThink(set)).toBe(true);
    expect(onLookup).toHaveBeenCalledTimes(1);
    expect(client.modelContext).toHaveBeenCalledTimes(1);
  });

  it('says false for a model without thinking, and undefined when the server does not say', async () => {
    expect(await lookup(async () => ({ capabilities: ['completion'] })).canThink(SETTINGS)).toBe(
      false,
    );
    expect(await lookup(async () => ({ maxTokens: 2048 })).canThink(SETTINGS)).toBeUndefined();
  });

  it('says undefined when the lookup fails, and asks again next time', async () => {
    const { canThink, client } = lookup(async () => {
      throw new Error('offline');
    });
    expect(await canThink(SETTINGS)).toBeUndefined();
    expect(await canThink(SETTINGS)).toBeUndefined();
    expect(client.modelContext).toHaveBeenCalledTimes(2);
  });

  it('asks nothing without a model', async () => {
    const { canThink, client } = lookup(REASONING);
    expect(await canThink({ ...SETTINGS, model: '' })).toBeUndefined();
    expect(client.modelContext).not.toHaveBeenCalled();
  });
});

describe('thinkOption (PR 9.5)', () => {
  it('turns thinking off for a reasoning model unless the setting is on', () => {
    expect(thinkOption(true, false)).toBe(false);
    expect(thinkOption(true, true)).toBe(true);
  });

  it('sends nothing for other models or when it is not known', () => {
    expect(thinkOption(false, true)).toBeUndefined();
    expect(thinkOption(undefined, false)).toBeUndefined();
  });
});
