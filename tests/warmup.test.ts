import { createLoadedWindowMemory, type LoadedWindowMemory } from '../src/llm/loadedWindow';
import type { LlmClient, RunningModel } from '../src/llm/types';
import type { RoundTripLog } from '../src/net/roundTrips';
import { createWarmup, isModelLoaded } from '../src/llm/warmup';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };
const PR = { pr: 'larry94555/PR-explainer#35' };

function setup(
  options: {
    /** What /api/ps lists: model names, or models with their windows. */
    loaded?: () => Promise<(string | RunningModel)[]>;
    load?: () => Promise<void>;
    settings?: Partial<Settings>;
    contextTokens?: () => Promise<number>;
    loadedWindow?: LoadedWindowMemory;
  } = {},
) {
  const client: LlmClient = {
    listModels: vi.fn(),
    modelContext: vi.fn(),
    chat: vi.fn(),
    chatStream: vi.fn(),
    loadedModels: vi.fn(),
    loadedContextTokens: vi.fn(async () => undefined),
    runningModels: vi.fn(async () =>
      (await (options.loaded ?? (async () => []))()).map((m) =>
        typeof m === 'string' ? { name: m } : m,
      ),
    ),
    loadModel: vi.fn(options.load ?? (async () => {})),
  };
  const createClient = vi.fn(() => client);
  const log = vi.fn();
  const warmup = createWarmup({
    getSettings: async () => ({ ...SETTINGS, ...options.settings }),
    createClient,
    log,
    ...(options.contextTokens && { contextTokens: options.contextTokens }),
    ...(options.loadedWindow && { loadedWindow: options.loadedWindow }),
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
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ llmUrl: SETTINGS.llmUrl }),
      { roundTrips: expect.objectContaining({ cause: 'warmup' }) },
    );
    expect(client.loadModel).toHaveBeenCalledWith('qwen2.5-coder:7b', { keepAliveMinutes: 45 });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[PR Explainer\] warm-up: loaded qwen2\.5-coder:7b in \d+\.\d s$/),
    );
  });

  it('loads it with the window the first explanation will ask for (PR 8.5)', async () => {
    const auto = setup({ contextTokens: async () => 8192 });
    await auto.warmup.warmUp(1, PR);
    expect(auto.client.loadModel).toHaveBeenCalledWith('qwen2.5-coder:7b', {
      keepAliveMinutes: 30,
      contextTokens: 2048,
    });
    // A model whose own window is smaller is loaded with that.
    const small = setup({ contextTokens: async () => 1024 });
    await small.warmup.warmUp(1, PR);
    expect(vi.mocked(small.client.loadModel).mock.calls[0]![1]).toMatchObject({
      contextTokens: 1024,
    });
    // A Context size the user set is used as it is.
    const set = setup({ contextTokens: async () => 8192, settings: { contextTokens: 6000 } });
    await set.warmup.warmUp(1, PR);
    expect(vi.mocked(set.client.loadModel).mock.calls[0]![1]).toMatchObject({
      contextTokens: 6000,
    });
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
    expect(client.runningModels).toHaveBeenCalledTimes(1);
    expect(client.loadModel).toHaveBeenCalledTimes(1);

    // Another tab, or another PR in the same tab, checks again.
    await warmup.warmUp(2, PR);
    await warmup.warmUp(1, { pr: 'larry94555/PR-explainer#34' });
    expect(client.runningModels).toHaveBeenCalledTimes(3);
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
    expect(client.runningModels).not.toHaveBeenCalled();
    model = 'qwen2.5-coder:7b';
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'loaded' });
  });

  it('does nothing when Keep model loaded is 0, since the model would unload at once', async () => {
    const { warmup, client } = setup({ settings: { keepAliveMinutes: 0 } });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'off' });
    expect(client.runningModels).not.toHaveBeenCalled();
  });

  it('checks every time when it does not know the tab', async () => {
    const { warmup, client } = setup();
    await warmup.warmUp(undefined, PR);
    await warmup.warmUp(undefined, PR);
    expect(client.runningModels).toHaveBeenCalledTimes(2);
  });
});

describe('warm-up round trips (PR 9.2)', () => {
  it('lists the log of a warm-up only while it is still running', async () => {
    let finish!: () => void;
    const { warmup, createClient } = setup({
      load: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    const running = warmup.warmUp(1, PR);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(warmup.inFlight()).toHaveLength(1);
    expect(warmup.inFlight()[0]!.cause).toBe('warmup');
    // The client records into that same log.
    expect((vi.mocked(createClient).mock.calls[0] as unknown[])[1]).toEqual({
      roundTrips: warmup.inFlight()[0],
    });
    finish();
    await running;
    expect(warmup.inFlight()).toEqual([]);
  });
});

describe('warm-up and the remembered window (PR 9.7)', () => {
  const at = { llmUrl: SETTINGS.llmUrl, model: SETTINGS.model };

  it('remembers the window it loaded the model with', async () => {
    const loadedWindow = createLoadedWindowMemory();
    const { warmup } = setup({ contextTokens: async () => 8192, loadedWindow });
    await warmup.warmUp(1, PR);
    expect(loadedWindow.known(at)).toBe(2048);
  });

  it('remembers the window /api/ps reports when the model is already loaded', async () => {
    const loadedWindow = createLoadedWindowMemory();
    const { warmup } = setup({
      loaded: async () => [{ name: 'qwen2.5-coder:7b', contextTokens: 4096 }],
      loadedWindow,
    });
    await expect(warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'already-loaded' });
    expect(loadedWindow.known(at)).toBe(4096);
  });

  it('forgets when /api/ps does not say, or the warm-up fails', async () => {
    const loadedWindow = createLoadedWindowMemory();
    loadedWindow.remember(at, 8192);
    const old = setup({ loaded: async () => ['qwen2.5-coder:7b'], loadedWindow });
    await old.warmup.warmUp(1, PR);
    expect(loadedWindow.known(at)).toBeUndefined();

    loadedWindow.remember(at, 8192);
    const down = setup({
      load: async () => {
        throw new Error('out of memory');
      },
      loadedWindow,
    });
    await expect(down.warmup.warmUp(1, PR)).resolves.toEqual({ outcome: 'failed' });
    expect(loadedWindow.known(at)).toBeUndefined();
  });

  it("puts its round trips in the page's debug group when given one", async () => {
    // The fake client sends nothing, so check the log the client was made with.
    const named = setup();
    await named.warmup.warmUp(1, { ...PR, debugId: 'page-1' });
    const logOf = (createClient: typeof named.createClient) =>
      (vi.mocked(createClient).mock.calls[0] as unknown[])[1] as { roundTrips: RoundTripLog };
    expect(logOf(named.createClient).roundTrips.group).toBe('page-1');
    const unnamed = setup();
    await unnamed.warmup.warmUp(1, PR);
    expect(logOf(unnamed.createClient).roundTrips.group).not.toBe('page-1');
  });
});
