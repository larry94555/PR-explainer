import {
  AUTO_CONTEXT_TOKENS,
  createContextSizer,
  FALLBACK_CONTEXT_TOKENS,
  promptBudget,
} from '../src/llm/contextSize';
import type { LlmClient, ModelContext } from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };

function setup(modelContext: () => Promise<ModelContext>) {
  const client: LlmClient = {
    listModels: vi.fn(),
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
