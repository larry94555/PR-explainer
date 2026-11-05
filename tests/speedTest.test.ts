import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';
import { buildExplainPrompt } from '../src/explain/explainPrompt';
import {
  addMeasurement,
  compareMeasurements,
  loadMeasurements,
  MAX_MEASURED_MODELS,
  measurementFrom,
  measurementsFor,
  MEASUREMENTS_KEY,
  parseMeasurements,
  saveMeasurement,
  type Measurement,
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

describe('Measure results (PR 11.7)', () => {
  const m = (model: string, totalMs: number, at: number): Measurement => ({ model, totalMs, at });

  function fakeStorage(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial };
    return {
      data,
      get: vi.fn(async (keys: string[]) =>
        Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(data, items);
      }),
    };
  }

  it('makes a measurement from a finished result, with its speed and where it ran', () => {
    expect(
      measurementFrom(
        {
          model: 'a',
          status: 'done',
          totalMs: 1234,
          tokensPerSecond: 20,
          gpu: { kind: 'gpu', processor: '100% GPU', message: '', fix: '' },
        },
        99,
      ),
    ).toEqual({ model: 'a', totalMs: 1234, tokensPerSecond: 20, processor: '100% GPU', at: 99 });
    expect(measurementFrom({ model: 'a', status: 'done', totalMs: 5 }, 1)).toEqual(m('a', 5, 1));
    expect(measurementFrom({ model: 'a', status: 'failed', message: 'x' }, 1)).toBeUndefined();
    expect(measurementFrom({ model: 'a', status: 'stopped' }, 1)).toBeUndefined();
  });

  it('keeps the last two results of each model: before and after', () => {
    let list = addMeasurement([], m('a', 3000, 1));
    list = addMeasurement(list, m('b', 900, 2));
    list = addMeasurement(list, m('a', 2500, 3));
    list = addMeasurement(list, m('a', 2000, 4));
    expect(list).toEqual([m('b', 900, 2), m('a', 2500, 3), m('a', 2000, 4)]);
    expect(measurementsFor(list, 'a')).toEqual({
      previous: m('a', 2500, 3),
      latest: m('a', 2000, 4),
    });
    expect(measurementsFor(list, 'b')).toEqual({ latest: m('b', 900, 2) });
    expect(measurementsFor(list, 'c')).toEqual({});
  });

  it('treats a model with and without :latest as the same', () => {
    const list = addMeasurement([m('llama3', 3000, 1)], m('llama3:latest', 2000, 2));
    expect(measurementsFor(list, 'llama3').previous?.totalMs).toBe(3000);
  });

  it(`keeps the ${MAX_MEASURED_MODELS} models measured most recently`, () => {
    let list: Measurement[] = [];
    for (let i = 0; i <= MAX_MEASURED_MODELS; i++) list = addMeasurement(list, m(`m${i}`, 1000, i));
    expect(new Set(list.map((x) => x.model)).size).toBe(MAX_MEASURED_MODELS);
    expect(measurementsFor(list, 'm0')).toEqual({});
    expect(measurementsFor(list, `m${MAX_MEASURED_MODELS}`).latest).toBeDefined();
  });

  it('compares the latest with the one before', () => {
    expect(compareMeasurements(m('a', 4000, 1), m('a', 3000, 2))).toEqual({
      diffMs: -1000,
      share: -0.25,
      kind: 'faster',
      text: '1.0 s faster than before (25% less time).',
    });
    expect(compareMeasurements(m('a', 2000, 1), m('a', 3000, 2))).toMatchObject({
      kind: 'slower',
      text: '1.0 s slower than before (50% more time).',
    });
  });

  it('calls a change under 5% the same, as it is within run-to-run noise', () => {
    expect(compareMeasurements(m('a', 2000, 1), m('a', 2060, 2))).toMatchObject({
      kind: 'same',
      text: 'About the same as before (3% difference), which is within run-to-run noise.',
    });
  });

  it('saves to and loads from chrome.storage.local', async () => {
    const storage = fakeStorage();
    expect(await loadMeasurements(storage)).toEqual([]);
    await saveMeasurement(storage, m('a', 3000, 1));
    const list = await saveMeasurement(storage, m('a', 2000, 2));
    expect(list).toEqual([m('a', 3000, 1), m('a', 2000, 2)]);
    expect(storage.data[MEASUREMENTS_KEY]).toEqual(list);
    expect(await loadMeasurements(storage)).toEqual(list);
  });

  it('ignores stored values that are not measurements, and storage that fails', async () => {
    expect(parseMeasurements('nope')).toEqual([]);
    expect(
      parseMeasurements([m('a', 1, 1), { model: 'b' }, null, { model: 3, totalMs: 1, at: 1 }]),
    ).toEqual([m('a', 1, 1)]);
    const broken = { get: vi.fn(async () => Promise.reject(new Error('x'))), set: vi.fn() };
    expect(await loadMeasurements(broken)).toEqual([]);
  });
});
