import { llmErrorKind } from '../src/llm/describeLlmError';
import {
  CHECK_DELAYS_MS,
  createOllamaStatus,
  OLLAMA_STATUS_KEY,
  stateOfErrorKind,
  stateOfResult,
  toOllamaStatus,
  type FoundState,
  type OllamaStatusDeps,
} from '../src/llm/ollamaStatus';
import { LlmError } from '../src/llm/types';
import * as banner from '../src/statusBanner';

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
  };
}

/** A fake Ollama: each check answers what `answer` holds now. */
function setup(overrides: Partial<OllamaStatusDeps> = {}) {
  let answer: FoundState = 'up';
  let tabOpen = true;
  const storage = fakeStorage();
  const check = vi.fn(async () =>
    answer === 'model-missing' ? { state: answer, model: 'qwen' } : { state: answer },
  );
  const onChange = vi.fn();
  const onRecover = vi.fn();
  const status = createOllamaStatus({
    check,
    prTabOpen: async () => tabOpen,
    model: async () => 'qwen',
    storage,
    onChange,
    onRecover,
    ...overrides,
  });
  return {
    status,
    storage,
    check,
    onChange,
    onRecover,
    ollama: (next: FoundState) => (answer = next),
    setTabOpen: (open: boolean) => (tabOpen = open),
    states: () => onChange.mock.calls.map(([s]) => s.state),
  };
}

/** Runs the timers up to `ms` from now, letting the checks they start settle. */
async function wait(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('what a request says about Ollama', () => {
  it('reads down and model missing from a failure, and up from an answer the model wrote', () => {
    expect(stateOfErrorKind('connection')).toBe('down');
    expect(stateOfErrorKind('model-not-found')).toBe('model-missing');
    expect(stateOfErrorKind('aborted')).toBeUndefined();
    expect(stateOfErrorKind('origin-blocked')).toBeUndefined();
    expect(stateOfErrorKind(undefined)).toBeUndefined();
    expect(stateOfResult({ status: 'failed', kind: 'connection' })).toBe('down');
    expect(stateOfResult({ status: 'failed', kind: 'model-not-found' })).toBe('model-missing');
    expect(stateOfResult({ status: 'failed' })).toBeUndefined();
    expect(stateOfResult({ status: 'done' })).toBe('up');
    // A cached answer says nothing: the model was not asked.
    expect(stateOfResult({ status: 'done', cached: { savedAt: 1 } })).toBeUndefined();
    expect(stateOfResult({ status: 'hunk', lines: [{ status: 'cached' }] })).toBeUndefined();
    expect(stateOfResult({ status: 'hunk', lines: [{ status: 'missing' }] })).toBe('up');
  });

  it('gives the kind of an LlmError, and nothing for another error', () => {
    expect(llmErrorKind(new LlmError('connection', 'x'))).toBe('connection');
    expect(llmErrorKind(new Error('x'))).toBeUndefined();
  });

  it('reads a stored status only when it is one', () => {
    expect(toOllamaStatus({ state: 'down' })).toEqual({ state: 'down' });
    expect(toOllamaStatus({ state: 'model-missing', model: 'qwen' })).toEqual({
      state: 'model-missing',
      model: 'qwen',
    });
    expect(toOllamaStatus({ state: 'unknown' })).toBeUndefined();
    expect(toOllamaStatus('down')).toBeUndefined();
  });
});

describe('the Ollama status (PR 11.6)', () => {
  it('moves between up, down and model missing from request results', async () => {
    const env = setup();
    env.status.report('up');
    env.status.report('down');
    expect(env.status.current()).toEqual({ state: 'down' });
    env.status.report('model-missing');
    await wait(0);
    expect(env.status.current()).toEqual({ state: 'model-missing', model: 'qwen' });
    env.status.report('up');
    expect(env.states()).toEqual(['up', 'down', 'model-missing', 'up']);
    // Kept in chrome.storage.local, which every tab follows.
    expect(env.storage.data[OLLAMA_STATUS_KEY]).toEqual({ state: 'up' });
  });

  it('tells each change once, not once per failed request', () => {
    const env = setup();
    env.status.report('down');
    env.status.report('down');
    env.status.report('down');
    expect(env.states()).toEqual(['down']);
    expect(env.storage.set).toHaveBeenCalledTimes(1);
  });

  it('checks again after 2, 4 and 8 seconds, then every 30, while down', async () => {
    const env = setup();
    env.ollama('down');
    env.status.report('down');
    const times: number[] = [];
    const start = Date.now();
    env.check.mockImplementation(async () => {
      times.push(Date.now() - start);
      return { state: 'down' };
    });
    await wait(2_000 + 4_000 + 8_000 + 30_000 + 30_000);
    expect(CHECK_DELAYS_MS).toEqual([2_000, 4_000, 8_000, 30_000]);
    expect(times).toEqual([2_000, 6_000, 14_000, 44_000, 74_000]);
  });

  it('stops checking once Ollama is back, warms the model up and says so once', async () => {
    const env = setup();
    env.ollama('down');
    env.status.report('down');
    await wait(2_000);
    expect(env.check).toHaveBeenCalledTimes(1);
    env.ollama('up');
    await wait(4_000);
    expect(env.status.current()).toEqual({ state: 'up' });
    expect(env.onRecover).toHaveBeenCalledTimes(1);
    expect(env.states()).toEqual(['down', 'up']);
    await wait(120_000);
    expect(env.check).toHaveBeenCalledTimes(2);
  });

  it('warms up when a request, not a check, finds Ollama back', () => {
    const env = setup();
    env.status.report('model-missing');
    env.status.report('up');
    expect(env.onRecover).not.toHaveBeenCalled();
    env.status.report('down');
    env.status.report('up');
    expect(env.onRecover).toHaveBeenCalledTimes(1);
  });

  it('does not warm up the first time Ollama is found up', async () => {
    const env = setup();
    await env.status.ensure();
    expect(env.status.current()).toEqual({ state: 'up' });
    expect(env.onRecover).not.toHaveBeenCalled();
  });

  it('makes no checks while no PR tab is open, and starts again when a PR page asks', async () => {
    const env = setup();
    env.ollama('down');
    env.setTabOpen(false);
    env.status.report('down');
    await wait(2_000);
    await wait(120_000);
    expect(env.check).not.toHaveBeenCalled();

    // A PR's diffs open: the page asks, which checks at once and starts the schedule again.
    env.setTabOpen(true);
    await env.status.ensure();
    expect(env.check).toHaveBeenCalledTimes(1);
    await wait(2_000);
    expect(env.check).toHaveBeenCalledTimes(2);
  });

  it('answers a page from what it knows when Ollama is up, without a check', async () => {
    const env = setup();
    env.status.report('up');
    await expect(env.status.ensure()).resolves.toEqual({ state: 'up' });
    expect(env.check).not.toHaveBeenCalled();
  });

  it('checks at once on Try again, and starts the back-off again from 2 seconds', async () => {
    const env = setup();
    env.ollama('down');
    env.status.report('down');
    await wait(2_000 + 4_000 + 8_000);
    expect(env.check).toHaveBeenCalledTimes(3);
    await expect(env.status.check()).resolves.toEqual({ state: 'down' });
    expect(env.check).toHaveBeenCalledTimes(4);
    await wait(2_000);
    expect(env.check).toHaveBeenCalledTimes(5);
  });

  it('shares one check between two asks at once', async () => {
    const env = setup();
    env.ollama('down');
    await Promise.all([env.status.check(), env.status.ensure()]);
    expect(env.check).toHaveBeenCalledTimes(1);
  });

  it('finds a missing model with a check, and names it', async () => {
    const env = setup();
    env.ollama('model-missing');
    await expect(env.status.ensure()).resolves.toEqual({ state: 'model-missing', model: 'qwen' });
    env.ollama('up');
    await wait(2_000);
    expect(env.status.current()).toEqual({ state: 'up' });
    expect(env.onRecover).toHaveBeenCalledTimes(1);
  });

  it('keeps checking after a check that could not be made', async () => {
    const env = setup();
    env.status.report('down');
    env.check.mockRejectedValueOnce(new Error('settings unreadable'));
    await wait(2_000);
    expect(env.status.current()).toEqual({ state: 'down' });
    await wait(4_000);
    expect(env.check).toHaveBeenCalledTimes(2);
  });

  it('carries on checking after Chrome restarts the worker while Ollama is down', async () => {
    const storage = fakeStorage({ [OLLAMA_STATUS_KEY]: { state: 'down' } });
    const env = setup({ storage });
    await env.status.ready;
    expect(env.status.current()).toEqual({ state: 'down' });
    expect(env.states()).toEqual(['down']);
    env.ollama('up');
    await wait(2_000);
    expect(env.status.current()).toEqual({ state: 'up' });
    expect(env.onRecover).toHaveBeenCalledTimes(1);
  });

  it('lets what it heard since starting win over what was stored', async () => {
    const storage = fakeStorage({ [OLLAMA_STATUS_KEY]: { state: 'down' } });
    const env = setup({ storage });
    env.status.report('up');
    await env.status.ready;
    expect(env.status.current()).toEqual({ state: 'up' });
  });

  it('uses the same storage key as the banner in the content script', () => {
    expect(banner.OLLAMA_STATUS_KEY).toBe(OLLAMA_STATUS_KEY);
  });
});
