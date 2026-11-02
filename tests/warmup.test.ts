import type { LlmClient } from '../src/llm/types';
import { createWarmup, isModelLoaded } from '../src/llm/warmup';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };
const PR = { pr: 'larry94555/PR-explainer#35' };

function setup(
  options: {
    loaded?: () => Promise<string[]>;
    load?: () => Promise<void>;
    settings?: Partial<Settings>;
  } = {},
) {
  const client: LlmClient = {
    listModels: vi.fn(),
    modelContext: vi.fn(),
    chat: vi.fn(),
    chatStream: vi.fn(),
    loadedModels: vi.fn(options.loaded ?? (async () => [])),
    loadModel: vi.fn(options.load ?? (async () => {})),
  };
  const createClient = vi.fn(() => client);
  const log = vi.fn();
  const warmup = createWarmup({
    getSettings: async () => ({ ...SETTINGS, ...options.settings }),
    createClient,
    log,
  });
  return { warmup, client, createClient, log };
}

describe('isModelLoaded', () => {
  it('matches the exact name, and a name with no tag to its :latest', () => {
    expect(isModelLoaded(['qwen2.5-coder:7b'], 'qwen2.5-coder:7b')).toBe(true);
    expect(isModelLoaded(['llama3.2:latest'], 'llama3.2')).toBe(true);
    expect(isModelLoaded(['qwen2.5-coder:3b'], 'qwen2.5-coder:7b')).toBe(false);
    expect(isModelLoaded(['llama3.2:3b'], 'llama3.2')).toBe(false);
    expect(isModelLoaded([], 'llama3.2')).toBe(false);
  });
});

describe('warm-up (PR 8.3)', () => {
  it('loads the model with the Keep model loaded time when it is not loaded', async () => {
    const { warmup, client, createClient, log } = setup({ settings: { keepAliveMinutes: 45 } });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'loaded' });
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ llmUrl: SETTINGS.llmUrl }));
    expect(client.loadModel).toHaveBeenCalledWith('qwen2.5-coder:7b', { keepAliveMinutes: 45 });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[PR Explainer\] warm-up: loaded qwen2\.5-coder:7b in \d+\.\d s$/),
    );
  });

  it('is skipped when /api/ps lists the model', async () => {
    const { warmup, client, log } = setup({ loaded: async () => ['qwen2.5-coder:7b'] });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'already-loaded' });
    expect(client.loadModel).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[PR Explainer] warm-up: qwen2.5-coder:7b is already loaded');
  });

  it('runs once per tab and PR', async () => {
    const { warmup, client } = setup();
    await warmup.warmUp(1, PR);
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'repeat' });
    expect(client.loadedModels).toHaveBeenCalledTimes(1);
    expect(client.loadModel).toHaveBeenCalledTimes(1);

    // Another tab, or another PR in the same tab, checks again.
    await warmup.warmUp(2, PR);
    await warmup.warmUp(1, { pr: 'larry94555/PR-explainer#34' });
    expect(client.loadedModels).toHaveBeenCalledTimes(3);
  });

  it('runs again in a tab that was closed and its id reused', async () => {
    const { warmup, client } = setup();
    await warmup.warmUp(1, PR);
    warmup.forgetTab(1);
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'loaded' });
    expect(client.loadModel).toHaveBeenCalledTimes(2);
  });

  it('counts a second request from the tab while the first is loading as a repeat', async () => {
    let finish!: () => void;
    const { warmup, client } = setup({ load: () => new Promise((r) => (finish = r)) });
    const first = warmup.warmUp(1, PR);
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'repeat' });
    await vi.waitFor(() => expect(client.loadModel).toHaveBeenCalled());
    finish();
    await expect(first).resolves.toEqual({ outcome: 'loaded' });
  });

  it('shares one load between tabs that open PRs at the same time', async () => {
    let finish!: () => void;
    const { warmup, client } = setup({ load: () => new Promise((r) => (finish = r)) });
    const first = warmup.warmUp(1, PR);
    const second = warmup.warmUp(2, PR);
    await vi.waitFor(() => expect(client.loadModel).toHaveBeenCalled());
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { outcome: 'loaded' },
      { outcome: 'loaded' },
    ]);
    expect(client.loadModel).toHaveBeenCalledTimes(1);
  });

  it('never throws when Ollama cannot be reached or cannot load the model', async () => {
    const down = setup({
      loaded: async () => {
        throw new Error('Could not connect to http://localhost:11434.');
      },
    });
    await expect(down.warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'failed' });
    expect(down.log).toHaveBeenCalledWith(
      '[PR Explainer] warm-up: could not load qwen2.5-coder:7b ' +
        '(Could not connect to http://localhost:11434.)',
    );

    const missing = setup({
      load: async () => {
        throw new Error('Model "qwen2.5-coder:7b" is not installed.');
      },
    });
    await expect(missing.warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'failed' });
    // A failed warm-up is not tried again for the same PR: the click loads it.
    await expect(missing.warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'repeat' });
  });

  it('never throws when the settings cannot be read', async () => {
    const warmup = createWarmup({
      getSettings: async () => {
        throw new Error('storage unavailable');
      },
      createClient: vi.fn(),
      log: vi.fn(),
    });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'failed' });
  });

  it('does nothing when no model is picked, and tries again once one is', async () => {
    let model = '';
    const client = setup().client;
    const warmup = createWarmup({
      getSettings: async () => ({ ...SETTINGS, model }),
      createClient: () => client,
      log: vi.fn(),
    });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'no-model' });
    expect(client.loadedModels).not.toHaveBeenCalled();
    model = 'qwen2.5-coder:7b';
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'loaded' });
  });

  it('does nothing when Keep model loaded is 0, since the model would unload at once', async () => {
    const { warmup, client } = setup({ settings: { keepAliveMinutes: 0 } });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'off' });
    expect(client.loadedModels).not.toHaveBeenCalled();
  });

  it('checks every time when it does not know the tab', async () => {
    const { warmup, client } = setup();
    await warmup.warmUp(undefined, PR);
    await warmup.warmUp(undefined, PR);
    expect(client.loadedModels).toHaveBeenCalledTimes(2);
  });
});
