import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { explainLineAt, lineRequest, type ClickHandlerDeps } from '../src/clickHandler';
import type { StorageChange } from '../src/enabledState';
import type { ExplainResult } from '../src/explain/explainHandler';
import type { ExplainStream } from '../src/messaging/client';
import { currentPopup, openPopup } from '../src/popup/popup';
import {
  createPrefetcher,
  hoveredLine,
  HOVER_SETTING_KEY,
  PREFETCH_DELAY_MS,
  toHoverEnabled,
  trackHoverSetting,
  type HoveredLine,
  type PrefetchDeps,
  type PrefetchEvent,
} from '../src/prefetch';
import { storageKey } from '../src/settings';

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'Adds one.', why: 'It is needed.', concerns: 'None found.' },
  model: 'qwen2.5-coder:3b',
};

/** One request to the service worker, settled by the test. */
interface FakeStream extends ExplainStream {
  text: string;
  options: { fresh: boolean; code?: unknown };
  stopped: boolean;
  chunk(text: string): void;
  finish(result?: ExplainResult): void;
}

function fakeExplain() {
  const streams: FakeStream[] = [];
  const explain = vi.fn<ClickHandlerDeps['explain']>((text, onChunk, options) => {
    let settle!: (result: ExplainResult) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<ExplainResult>((res, rej) => {
      settle = res;
      fail = rej;
    });
    result.catch(() => {});
    const stream: FakeStream = {
      text,
      options,
      stopped: false,
      result,
      stop: vi.fn(() => {
        if (stream.stopped) return;
        stream.stopped = true;
        fail(Object.assign(new Error('Stopped by the user'), { name: 'AbortError' }));
      }),
      chunk: (piece) => {
        if (!stream.stopped) onChunk(piece);
      },
      finish: (value = DONE) => settle(value),
    };
    streams.push(stream);
    return stream;
  });
  return { explain, streams };
}

/** Lines are named by strings here: hovering "a" means the pointer is on line a. */
const fakeLocate = (target: EventTarget | null): HoveredLine | null => {
  const name = target as unknown as string | null;
  if (!name || name === 'gutter') return null;
  return {
    key: name,
    request: () => ({
      text: `context of ${name}`,
      subject: { filePath: 'src/a.ts', startLine: 1 },
      code: { filePath: 'src/a.ts', startLine: 1, endLine: 1, text: name },
    }),
  };
};

function setup(overrides: Partial<PrefetchDeps> = {}) {
  const { explain, streams } = fakeExplain();
  const events: PrefetchEvent[] = [];
  let on = true;
  let time = 0;
  const prefetcher = createPrefetcher({
    explain,
    isOn: () => on,
    locate: fakeLocate,
    now: () => time,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  const hover = (line: string, buttons = 0) =>
    prefetcher.onMouseOver({ target: line, buttons } as unknown as MouseEvent);
  return {
    prefetcher,
    explain,
    streams,
    events,
    hover,
    setOn: (value: boolean) => (on = value),
    setTime: (ms: number) => (time = ms),
  };
}

const flush = () => new Promise<void>((done) => queueMicrotask(done)).then(() => Promise.resolve());
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('explain on hover', () => {
  it('starts once the pointer has rested on a line for 800 ms', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS - 1);
    expect(env.explain).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(env.explain).toHaveBeenCalledTimes(1);
    expect(env.streams[0]!.text).toBe('context of a');
    expect(env.streams[0]!.options).toEqual({
      fresh: false,
      code: { filePath: 'src/a.ts', startLine: 1, endLine: 1, text: 'a' },
    });
    expect(env.prefetcher.running()).toBe('a');
    expect(env.events).toEqual([{ type: 'started', key: 'a' }]);
  });

  it('does not restart the wait while the pointer moves within the same line', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(500);
    env.hover('a');
    vi.advanceTimersByTime(300);
    expect(env.explain).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when the pointer leaves the code (the gutter, the popup)', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(500);
    env.hover('gutter');
    vi.advanceTimersByTime(300);
    expect(env.streams.map((s) => s.text)).toEqual(['context of a']);
  });

  it('restarts the wait on another line, so passing over a line asks nothing', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(500);
    env.hover('b');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS - 1);
    expect(env.explain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(env.streams.map((s) => s.text)).toEqual(['context of b']);
  });

  it('cancels an unfinished prefetch when the pointer moves to another line', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.hover('b');
    expect(env.streams[0]!.stopped).toBe(true);
    expect(env.prefetcher.running()).toBeUndefined();
    expect(env.events).toContainEqual({ type: 'cancelled', key: 'a' });

    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.streams.map((s) => s.text)).toEqual(['context of a', 'context of b']);
  });

  it('runs one prefetch at a time when the pointer sweeps down many lines', () => {
    const env = setup();
    for (let i = 0; i < 20; i++) {
      env.hover(`line${i}`);
      vi.advanceTimersByTime(i % 3 === 0 ? PREFETCH_DELAY_MS : 100);
      expect(env.streams.filter((s) => !s.stopped).length).toBeLessThanOrEqual(1);
    }
    // Only the lines the pointer rested on were asked for.
    expect(env.explain).toHaveBeenCalledTimes(7);
  });

  it('lets a click join a running prefetch instead of starting a second request', async () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.streams[0]!.chunk('**What it does** Ad');
    env.setTime(2500);

    const got: string[] = [];
    const joined = env.prefetcher.explain('context of a', (c) => got.push(c), { fresh: false });
    expect(env.explain).toHaveBeenCalledTimes(1);
    expect(env.events).toContainEqual({ type: 'joined', key: 'a', elapsedMs: 2500 });
    // The text so far arrives once the caller is listening, then the rest.
    expect(got).toEqual([]);
    await flush();
    expect(got).toEqual(['**What it does** Ad']);
    env.streams[0]!.chunk('ds one.');
    expect(got).toEqual(['**What it does** Ad', 'ds one.']);

    env.streams[0]!.finish();
    await expect(joined.result).resolves.toBe(DONE);
  });

  it('keeps a joined prefetch running when the pointer moves, and stops it with the popup', async () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    const joined = env.prefetcher.explain('context of a', () => {}, { fresh: false });
    env.hover('b');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.streams[0]!.stopped).toBe(false);
    // Still one request: the click's answer comes first.
    expect(env.explain).toHaveBeenCalledTimes(1);

    joined.stop();
    expect(env.streams[0]!.stopped).toBe(true);
    await expect(joined.result).rejects.toThrow('Stopped by the user');
  });

  it('cancels the prefetch when a click asks about other code', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.prefetcher.explain('context of b', () => {}, { fresh: false });
    expect(env.streams[0]!.stopped).toBe(true);
    expect(env.streams[1]!.text).toBe('context of b');
  });

  it('does not join for Regenerate, which asks the model afresh', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.prefetcher.explain('context of a', () => {}, { fresh: true });
    expect(env.streams[0]!.stopped).toBe(true);
    expect(env.streams[1]!.options).toEqual({ fresh: true });
  });

  it('ends the wait when the user clicks before 800 ms', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(300);
    env.prefetcher.explain('context of a', () => {}, { fresh: false });
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).toHaveBeenCalledTimes(1);
    expect(env.streams[0]!.options).toEqual({ fresh: false });
  });

  it('leaves a finished prefetch to the cache and does not ask for that line again', async () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.setTime(4000);
    env.streams[0]!.finish();
    await settle();
    expect(env.prefetcher.running()).toBeUndefined();
    expect(env.events).toContainEqual({
      type: 'finished',
      key: 'a',
      elapsedMs: 4000,
      status: 'done',
    });

    env.hover('b');
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).toHaveBeenCalledTimes(1);

    // A click asks as usual; the service worker answers from its cache.
    env.prefetcher.explain('context of a', () => {}, { fresh: false });
    expect(env.explain).toHaveBeenCalledTimes(2);

    // After the page changes, the line may be asked for again.
    env.prefetcher.forget();
    env.hover('b');
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).toHaveBeenCalledTimes(3);
  });

  it('tries a failed prefetch again next time', async () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.streams[0]!.finish({ status: 'failed', message: 'Ollama is down.', fix: 'Start it.' });
    await settle();
    expect(env.events.at(-1)).toMatchObject({ type: 'finished', status: 'failed' });
    env.hover('b');
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the setting is off', () => {
    const env = setup();
    env.setOn(false);
    env.hover('a');
    vi.advanceTimersByTime(5000);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('does not start if the setting is turned off during the wait', () => {
    const env = setup();
    env.hover('a');
    env.setOn(false);
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('does nothing while the toolbar button has click-to-explain off', () => {
    const env = setup({ isEnabled: () => false });
    env.hover('a');
    vi.advanceTimersByTime(5000);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it("does nothing while a click's explanation is running or the chat is open", () => {
    let busy = true;
    const env = setup({ isBusy: () => busy });
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).not.toHaveBeenCalled();
    busy = false;
    env.hover('b');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(env.explain).toHaveBeenCalledTimes(1);
  });

  it('does nothing while a mouse button is held (dragging to select lines)', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(300);
    env.hover('b', 1);
    vi.advanceTimersByTime(5000);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('ends the wait on a mouse press', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(300);
    env.prefetcher.onMouseDown();
    vi.advanceTimersByTime(5000);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('cancel() ends the wait and stops an unjoined prefetch', () => {
    const env = setup();
    env.hover('a');
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    env.hover('b');
    vi.advanceTimersByTime(300);
    env.prefetcher.cancel();
    vi.advanceTimersByTime(5000);
    expect(env.streams.map((s) => s.stopped)).toEqual([true]);
  });
});

describe('the Explain on hover setting in the content script', () => {
  function fakeSync(initial: Record<string, unknown> = {}) {
    type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;
    const listeners: Listener[] = [];
    return {
      storage: { get: vi.fn(async (keys: string[]) => ({ ...pick(initial, keys) })) },
      events: { addListener: (l: Listener) => listeners.push(l) },
      fire: (changes: Record<string, StorageChange>, area = 'sync') =>
        listeners.forEach((l) => l(changes, area)),
    };
  }
  const pick = (data: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));

  it('uses the same storage key as the settings page', () => {
    expect(HOVER_SETTING_KEY).toBe(storageKey('explainOnHover'));
  });

  it('is off unless a boolean true is stored', () => {
    expect(toHoverEnabled(undefined)).toBe(false);
    expect(toHoverEnabled('yes')).toBe(false);
    expect(toHoverEnabled(true)).toBe(true);
  });

  it('is off until read, then follows what is saved', async () => {
    const sync = fakeSync({ [HOVER_SETTING_KEY]: true });
    const seen: boolean[] = [];
    const setting = trackHoverSetting(sync.storage, sync.events, (on) => seen.push(on));
    expect(setting.current()).toBe(false);
    await settle();
    expect(setting.current()).toBe(true);

    sync.fire({ [HOVER_SETTING_KEY]: { oldValue: true, newValue: false } });
    expect(setting.current()).toBe(false);
    // Other areas and keys are ignored.
    sync.fire({ [HOVER_SETTING_KEY]: { newValue: true } }, 'local');
    sync.fire({ 'settings.model': { newValue: 'x' } });
    expect(setting.current()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('lets a save made while reading win over the read', async () => {
    const sync = fakeSync({ [HOVER_SETTING_KEY]: false });
    const setting = trackHoverSetting(sync.storage, sync.events);
    sync.fire({ [HOVER_SETTING_KEY]: { newValue: true } });
    await settle();
    expect(setting.current()).toBe(true);
  });

  it('stays off when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sync = fakeSync();
    sync.storage.get.mockRejectedValueOnce(new Error('no storage'));
    const setting = trackHoverSetting(sync.storage, sync.events);
    await settle();
    expect(setting.current()).toBe(false);
    warn.mockRestore();
  });
});

describe('explain on hover on a real diff', () => {
  const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';
  const code = (id: string) =>
    document.querySelector(`td[data-line-anchor="${ANCHOR}${id}"] .diff-text-inner`)!;

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = readFileSync(
      resolve(import.meta.dirname, 'fixtures', 'github-diff-new.html'),
      'utf8',
    );
  });

  afterEach(() => {
    currentPopup()?.close();
    document.body.innerHTML = '';
  });

  it('names each line, and builds the request a click sends', () => {
    const line = hoveredLine(code('R44'))!;
    expect(line.key).toMatch(/:added:44$|:context:44$/);
    expect(line.request()).toEqual(lineRequest(code('R44'))!.request);
    expect(hoveredLine(code('R45'))!.key).not.toBe(line.key);
    expect(hoveredLine(document.body)).toBeNull();
  });

  it('a click on the hovered line joins its prefetch', async () => {
    vi.useFakeTimers();
    const { explain, streams } = fakeExplain();
    const prefetcher = createPrefetcher({ explain, isOn: () => true });
    document.addEventListener('mouseover', prefetcher.onMouseOver);
    code('R44').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    document.removeEventListener('mouseover', prefetcher.onMouseOver);
    expect(explain).toHaveBeenCalledTimes(1);
    streams[0]!.chunk('**What it does** Marks');

    explainLineAt({ explain: prefetcher.explain, openPopup }, code('R44'));
    expect(explain).toHaveBeenCalledTimes(1);
    await flush();
    expect(currentPopup()!.state).toBe('streaming');
    streams[0]!.finish();
    await settle();
    expect(currentPopup()!.state).toBe('done');
    expect(currentPopup()!.host.shadowRoot?.textContent ?? '').toContain('Adds one.');
  });
});
