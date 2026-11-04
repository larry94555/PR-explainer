import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';
import { buildExplainPrompt } from '../src/explain/explainPrompt';
import {
  fastestUnderGoal,
  rankResults,
  runSpeedTest,
  speedTestModels,
  type SpeedResult,
  type SpeedTestOptions,
} from '../src/llm/speedTest';
import { LlmError, type ChatOptions, type LlmClient, type RunningModel } from '../src/llm/types';
import { LATENCY_GOAL_MS } from '../src/llm/latencyGoal';

// Each model answers after `ms` on a fake clock, with `tokens` answer tokens.
interface FakeModel {
  ms: number;
  tokens?: number;
  fail?: LlmError;
  running?: Omit<RunningModel, 'name'>;
}

function fakeClient(models: Record<string, FakeModel>, clock: { t: number }) {
  const client: LlmClient = {
    listModels: vi.fn(async () => Object.keys(models).map((name) => ({ name }))),
    loadedModels: vi.fn(async () => []),
    runningModels: vi.fn(async () =>
      Object.entries(models).flatMap(([name, m]) => (m.running ? [{ name, ...m.running }] : [])),
    ),
    loadedContextTokens: vi.fn(async () => undefined),
    loadModel: vi.fn(async () => {}),
    modelContext: vi.fn(async () => ({})),
    chat: vi.fn(async (_messages, options: ChatOptions) => {
      const m = models[options.model]!;
      if (m.fail) throw m.fail;
      clock.t += m.ms;
      return {
        content: 'ok',
        model: options.model,
        timings: { answerTokens: m.tokens ?? 100, answerMs: m.ms / 2 },
      };
    }),
    chatStream: vi.fn(),
  };
  return client;
}

function options(client: LlmClient, clock: { t: number }, extra: Partial<SpeedTestOptions> = {}) {
  return {
    client,
    models: ['a', 'b', 'c'],
    temperature: 0.2,
    maxResponseTokens: 300,
    keepAliveMinutes: 30,
    contextTokens: 0,
    now: () => clock.t,
    ...extra,
  } satisfies SpeedTestOptions;
}

const done = (model: string, totalMs: number): SpeedResult => ({ model, status: 'done', totalMs });

describe('speedTestModels (PR 8.6)', () => {
  it('times only the coding models', () => {
    const names = [
      'qwen2.5-coder:7b',
      'llama3.2:3b',
      'codellama:7b',
      'deepseek-coder-v2:16b',
      'starcoder2:3b',
      'devstral:24b',
      'nomic-embed-text:latest',
    ];
    expect(speedTestModels(names.map((name) => ({ name })))).toEqual([
      'qwen2.5-coder:7b',
      'codellama:7b',
      'deepseek-coder-v2:16b',
      'starcoder2:3b',
      'devstral:24b',
    ]);
  });

  it('times every chat model when none is a coding model, but never an embedding model', () => {
    const names = ['llama3.2:3b', 'mxbai-embed-large', 'phi4:14b'];
    expect(speedTestModels(names.map((name) => ({ name })))).toEqual(['llama3.2:3b', 'phi4:14b']);
    expect(speedTestModels([])).toEqual([]);
  });
});

describe('runSpeedTest (PR 8.6)', () => {
  it('times one sample explanation per model with the settings, after loading it', async () => {
    const clock = { t: 0 };
    const client = fakeClient(
      { a: { ms: 4000, tokens: 80 }, b: { ms: 12000 }, c: { ms: 2500 } },
      clock,
    );
    const results = await runSpeedTest(options(client, clock));

    expect(results).toEqual([
      { model: 'a', status: 'done', totalMs: 4000, tokensPerSecond: 40 },
      { model: 'b', status: 'done', totalMs: 12000, tokensPerSecond: 100 / 6 },
      { model: 'c', status: 'done', totalMs: 2500, tokensPerSecond: 80 },
    ]);
    expect(client.chat).toHaveBeenCalledWith(
      buildExplainPrompt(SAMPLE_CONTEXT),
      expect.objectContaining({
        model: 'a',
        temperature: 0.2,
        maxResponseTokens: 300,
        contextTokens: 2048,
      }),
    );
    // Loaded with the warm-up window first, so the time does not include loading.
    expect(client.loadModel).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ contextTokens: 2048 }),
    );
    const loads = vi.mocked(client.loadModel).mock.invocationCallOrder;
    const chats = vi.mocked(client.chat).mock.invocationCallOrder;
    expect(loads[0]).toBeLessThan(chats[0]!);
  });

  it('uses a set Context size for loading and asking, so the GPU fit matches explanations', async () => {
    const clock = { t: 0 };
    const client = fakeClient({ a: { ms: 1 } }, clock);
    await runSpeedTest(options(client, clock, { models: ['a'], contextTokens: 16384 }));
    expect(client.loadModel).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ contextTokens: 16384 }),
    );
    expect(client.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextTokens: 16384 }),
    );
  });

  it('tests the picked model last and keeps only it loaded', async () => {
    const clock = { t: 0 };
    const client = fakeClient({ a: { ms: 1 }, b: { ms: 1 }, c: { ms: 1 } }, clock);
    const results = await runSpeedTest(options(client, clock, { current: 'a' }));

    expect(results.map((r) => r.model)).toEqual(['b', 'c', 'a']);
    const keepAlive = vi
      .mocked(client.chat)
      .mock.calls.map(([, o]) => [o.model, o.keepAliveMinutes]);
    expect(keepAlive).toEqual([
      ['b', 0],
      ['c', 0],
      ['a', 30],
    ]);
  });

  it('reads where each model runs while it is loaded', async () => {
    const clock = { t: 0 };
    const client = fakeClient(
      {
        a: { ms: 1, running: { sizeBytes: 10, vramBytes: 10 } },
        b: { ms: 1, running: { sizeBytes: 10, vramBytes: 0 } },
        c: { ms: 1 },
      },
      clock,
    );
    const results = await runSpeedTest(options(client, clock));
    const gpu = results.map((r) => (r.status === 'done' ? r.gpu?.processor : undefined));
    expect(gpu).toEqual(['100% GPU', '100% CPU', undefined]);
  });

  it('still times a model when /api/ps fails', async () => {
    const clock = { t: 0 };
    const client = fakeClient({ a: { ms: 3000 } }, clock);
    vi.mocked(client.runningModels).mockRejectedValue(new LlmError('http', 'nope'));
    const results = await runSpeedTest(options(client, clock, { models: ['a'] }));
    expect(results).toEqual([
      expect.objectContaining({ model: 'a', status: 'done', totalMs: 3000 }),
    ]);
  });

  it('marks a model that fails and goes on to the next', async () => {
    const clock = { t: 0 };
    const client = fakeClient(
      {
        a: { ms: 1, fail: new LlmError('model-not-found', 'Model "a" is not installed.') },
        b: { ms: 5 },
      },
      clock,
    );
    const results = await runSpeedTest(options(client, clock, { models: ['a', 'b'] }));
    expect(results).toEqual([
      { model: 'a', status: 'failed', message: 'Model "a" is not installed.' },
      expect.objectContaining({ model: 'b', status: 'done' }),
    ]);
  });

  it('stops: the model being timed and the ones left are marked stopped', async () => {
    const clock = { t: 0 };
    const controller = new AbortController();
    const client = fakeClient({ a: { ms: 1 }, b: { ms: 1 }, c: { ms: 1 } }, clock);
    vi.mocked(client.chat).mockImplementation(async (_m, o) => {
      if (o.model === 'b') {
        controller.abort();
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      return { content: 'ok', model: o.model };
    });
    const results = await runSpeedTest(options(client, clock, { signal: controller.signal }));

    expect(results).toEqual([
      { model: 'a', status: 'done', totalMs: 0 },
      { model: 'b', status: 'stopped' },
      { model: 'c', status: 'stopped' },
    ]);
    // Nothing more is sent once stopped.
    expect(client.loadModel).toHaveBeenCalledTimes(2);
    expect(client.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('reports progress after each model, with the one coming next', async () => {
    const clock = { t: 0 };
    const client = fakeClient({ a: { ms: 1 }, b: { ms: 1 } }, clock);
    const onProgress = vi.fn();
    await runSpeedTest(options(client, clock, { models: ['a', 'b'], onProgress }));
    expect(onProgress.mock.calls.map(([r, next]) => [r.length, next])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, undefined],
    ]);
  });
});

describe('ranking (PR 8.6)', () => {
  const results: SpeedResult[] = [
    { model: 'broken', status: 'failed', message: 'x' },
    done('slow', 14000),
    done('fast', 3200),
    { model: 'later', status: 'stopped' },
    done('medium', 8000),
  ];

  it('puts the fastest first and failed or stopped models last', () => {
    expect(rankResults(results).map((r) => r.model)).toEqual([
      'fast',
      'medium',
      'slow',
      'broken',
      'later',
    ]);
  });

  it('picks the fastest model only when it answered in under 2 seconds (PR 9.9)', () => {
    expect(LATENCY_GOAL_MS).toBe(2000);
    expect(fastestUnderGoal([done('quick', 1900), done('slow', 14000)])).toBe('quick');
    expect(fastestUnderGoal(results)).toBeUndefined();
    expect(fastestUnderGoal([done('slow', 14000), done('slower', 20000)])).toBeUndefined();
    expect(fastestUnderGoal([done('edge', 2000)])).toBeUndefined();
    expect(fastestUnderGoal([done('just under', 1999)])).toBe('just under');
    expect(fastestUnderGoal([{ model: 'x', status: 'failed', message: 'x' }])).toBeUndefined();
    expect(fastestUnderGoal([])).toBeUndefined();
  });
});
