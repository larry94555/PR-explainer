import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHandlerDeps } from '../src/clickHandler';
import type { StorageChange } from '../src/enabledState';
import type { ExplainResult } from '../src/explain/explainHandler';
import {
  AHEAD_IDLE_MS,
  AHEAD_MAX_PER_PAGE,
  AHEAD_RETRY_MS,
  AHEAD_SETTING_KEY,
  createExplainAhead,
  trackAheadSetting,
  visibleAddedLines,
  worthExplaining,
  type AheadEvent,
  type AheadLine,
  type ExplainAheadDeps,
} from '../src/explainAhead';
import type { ExplainStream } from '../src/messaging/client';
import { storageKey } from '../src/settings';

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'Adds one.', why: 'It is needed.', concerns: 'None found.' },
  model: 'qwen2.5-coder:1.5b',
};

const CACHED: ExplainResult = { ...DONE, cached: { elapsedMs: 4000, savedAt: 0 } };

/** One request to the fake service worker, settled by the test. */
interface FakeStream extends ExplainStream {
  text: string;
  options: Parameters<ClickHandlerDeps['explain']>[2];
  stopped: boolean;
  chunk(text: string): void;
  finish(result?: ExplainResult): void;
}

/**
 * A fake service worker: each request waits for the test to finish it,
 * except a text it has already answered, which comes from its cache at once.
 */
function fakeWorker() {
  const streams: FakeStream[] = [];
  const cache = new Set<string>();
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
      finish: (value = DONE) => {
        if (value.status === 'done') cache.add(text);
        settle(value);
      },
    };
    streams.push(stream);
    if (!options.fresh && cache.has(text)) settle(CACHED);
    return stream;
  });
  return { explain, streams, cache };
}

/** A line named `name`, with `code` as its text. */
const line = (name: string, code = `const ${name} = 1;`): AheadLine => ({
  key: name,
  text: code,
  request: () => ({
    text: `context of ${name}`,
    subject: { filePath: 'src/a.ts', startLine: 1 },
    code: { filePath: 'src/a.ts', startLine: 1, endLine: 1, text: code },
  }),
});

function setup(overrides: Partial<ExplainAheadDeps> = {}) {
  const worker = fakeWorker();
  const events: AheadEvent[] = [];
  let on = true;
  let enabled = true;
  let busy = false;
  let time = 0;
  let onScreen: AheadLine[] = ['a', 'b', 'c'].map((name) => line(name));
  let groups = 0;
  const ahead = createExplainAhead({
    explain: worker.explain,
    isOn: () => on,
    isEnabled: () => enabled,
    isBusy: () => busy,
    lines: () => onScreen,
    newGroupId: () => `ahead-${++groups}`,
    now: () => time,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return {
    ahead,
    ...worker,
    events,
    texts: () => worker.streams.map((s) => s.text),
    setOn: (value: boolean) => (on = value),
    setEnabled: (value: boolean) => (enabled = value),
    setBusy: (value: boolean) => (busy = value),
    setTime: (ms: number) => (time = ms),
    setLines: (lines: AheadLine[]) => (onScreen = lines),
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Finishes the running request and lets the next one start. */
async function finishCurrent(env: ReturnType<typeof setup>, result?: ExplainResult) {
  const running = env.streams.filter((s) => !s.stopped).at(-1)!;
  running.finish(result);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Explain ahead', () => {
  it('waits until the page has been still for 2 seconds', () => {
    const env = setup();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS - 1);
    expect(env.explain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(env.texts()).toEqual(['context of a']);
    expect(env.streams[0]!.options).toEqual({
      fresh: false,
      // Its round trips are marked as Explain ahead's, in one debug log group.
      cause: 'ahead',
      debugId: 'ahead-1',
      // Names the line in the service worker's queue (PR 10.3).
      job: { label: 'a' },
      code: { filePath: 'src/a.ts', startLine: 1, endLine: 1, text: 'const a = 1;' },
    });
  });

  it('explains the lines top to bottom, one at a time', async () => {
    const env = setup();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.ahead.running()).toBe('a');
    expect(env.ahead.queued()).toEqual(['b', 'c']);
    expect(env.explain).toHaveBeenCalledTimes(1);

    await finishCurrent(env);
    expect(env.texts()).toEqual(['context of a', 'context of b']);
    await finishCurrent(env);
    await finishCurrent(env);
    expect(env.texts()).toEqual(['context of a', 'context of b', 'context of c']);
    expect(env.ahead.running()).toBeUndefined();
    // Every request went to the same group, so the debug window shows one "ahead" group.
    expect(new Set(env.streams.map((s) => s.options.debugId))).toEqual(new Set(['ahead-1']));
  });

  it('skips blank lines and lines that only close a block', () => {
    const env = setup();
    env.setLines([
      line('blank', '   '),
      line('brace', '}'),
      line('call', '  });'),
      line('array', '];'),
      line('code', '  return total;'),
    ]);
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.ahead.running()).toBe('code');
    expect(env.ahead.queued()).toEqual([]);
  });

  it('knows which lines are worth explaining', () => {
    expect(worthExplaining('')).toBe(false);
    expect(worthExplaining('  ')).toBe(false);
    expect(worthExplaining('}')).toBe(false);
    expect(worthExplaining('  }),')).toBe(false);
    expect(worthExplaining(')];')).toBe(false);
    expect(worthExplaining('} else {')).toBe(true);
    expect(worthExplaining('x();')).toBe(true);
  });

  it('skips lines already in the cache, which do not count toward the limit', async () => {
    const env = setup();
    env.cache.add('context of a');
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    // a came back from the cache at once, so b is already asked.
    await settle();
    expect(env.events).toContainEqual({
      type: 'finished',
      key: 'a',
      elapsedMs: 0,
      status: 'done',
      cached: true,
    });
    expect(env.ahead.running()).toBe('b');
  });

  it(`asks the model about at most ${AHEAD_MAX_PER_PAGE} lines per page`, async () => {
    const env = setup();
    env.setLines(Array.from({ length: 40 }, (_, i) => line(`l${i}`)));
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    for (let i = 0; i < 35; i++) {
      if (env.ahead.running()) await finishCurrent(env);
    }
    expect(env.explain).toHaveBeenCalledTimes(AHEAD_MAX_PER_PAGE);
    expect(env.events).toContainEqual({ type: 'limit', count: AHEAD_MAX_PER_PAGE });

    // Scrolling does not get past the limit on the same page.
    env.setLines(Array.from({ length: 5 }, (_, i) => line(`more${i}`)));
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.explain).toHaveBeenCalledTimes(AHEAD_MAX_PER_PAGE);

    // A new page starts counting again, in a new debug log group.
    env.ahead.pageChanged();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.explain).toHaveBeenCalledTimes(AHEAD_MAX_PER_PAGE + 1);
    expect(env.streams.at(-1)!.options.debugId).toBe('ahead-2');
  });

  it('starts again from the lines on screen after a scroll', async () => {
    const env = setup();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.ahead.running()).toBe('a');

    // Scrolled down: b and c are gone, d and e are on screen.
    env.setLines([line('a'), line('d'), line('e')]);
    env.ahead.restart();
    expect(env.ahead.queued()).toEqual([]);
    // The line already being explained keeps going.
    expect(env.streams[0]!.stopped).toBe(false);
    await finishCurrent(env);
    expect(env.explain).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    // a is done, so d and e are next.
    expect(env.texts()).toEqual(['context of a', 'context of d']);
    expect(env.ahead.queued()).toEqual(['e']);
  });

  it('pauses while busy (a click or chat answer, a hover prefetch, a hidden tab)', async () => {
    const env = setup();
    env.setBusy(true);
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS + 10 * AHEAD_RETRY_MS);
    expect(env.explain).not.toHaveBeenCalled();

    env.setBusy(false);
    vi.advanceTimersByTime(AHEAD_RETRY_MS);
    expect(env.texts()).toEqual(['context of a']);

    // Busy again while a is explained: b waits until it is free.
    env.setBusy(true);
    await finishCurrent(env);
    vi.advanceTimersByTime(5 * AHEAD_RETRY_MS);
    expect(env.explain).toHaveBeenCalledTimes(1);
    env.setBusy(false);
    vi.advanceTimersByTime(AHEAD_RETRY_MS);
    expect(env.texts()).toEqual(['context of a', 'context of b']);
  });

  it('leaves a click to the service worker queue: the line keeps waiting for its answer', async () => {
    const env = setup();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    // A click elsewhere: its popup is loading. The queue (PR 10.3) pauses
    // this line's request in the service worker and runs it again after, so
    // nothing is stopped or asked again here.
    env.setBusy(true);
    vi.advanceTimersByTime(5 * AHEAD_RETRY_MS);
    expect(env.streams[0]!.stopped).toBe(false);
    expect(env.explain).toHaveBeenCalledTimes(1);

    await finishCurrent(env);
    env.setBusy(false);
    vi.advanceTimersByTime(AHEAD_RETRY_MS);
    expect(env.texts()).toEqual(['context of a', 'context of b']);
  });

  it('ends the pass when a line fails (Ollama may be down), until the next scroll', async () => {
    const env = setup();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    await finishCurrent(env, { status: 'failed', message: 'Ollama is down.', fix: 'Start it.' });
    vi.advanceTimersByTime(10 * AHEAD_RETRY_MS);
    expect(env.explain).toHaveBeenCalledTimes(1);

    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.texts()).toEqual(['context of a', 'context of a']);
  });

  it('does nothing while the setting is off', () => {
    const env = setup();
    env.setOn(false);
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS * 3);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('does nothing while click-to-explain is off with the toolbar button', () => {
    const env = setup();
    env.setEnabled(false);
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS * 3);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('stops at once when cancelled (setting or toolbar turned off, leaving the page)', () => {
    const env = setup();
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    env.ahead.cancel();
    expect(env.streams[0]!.stopped).toBe(true);
    expect(env.ahead.running()).toBeUndefined();
    expect(env.ahead.queued()).toEqual([]);
    vi.advanceTimersByTime(AHEAD_IDLE_MS * 3);
    expect(env.explain).toHaveBeenCalledTimes(1);
  });
});

describe('the lines on screen, from a saved GitHub diff', () => {
  const fixture = (name: string) =>
    readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');

  it.each(['github-diff-classic-split.html', 'github-diff-new-split.html'])(
    'reads only the added lines that are visible, in page order (%s)',
    (name) => {
      document.body.innerHTML = fixture(name);
      const all = visibleAddedLines(document, () => true);
      expect(all.map((l) => l.key)).toEqual([
        'tests/manifest.test.ts:added:48',
        'tests/manifest.test.ts:added:50',
        'tests/manifest.test.ts:added:59',
        'tests/manifest.test.ts:added:60',
        'tests/manifest.test.ts:added:61',
        'tests/manifest.test.ts:added:62',
        'tests/manifest.test.ts:added:63',
      ]);
      // Only the ones the test calls visible.
      const shown = visibleAddedLines(document, (cell) => /\b6[0-2]\b/.test(lineOf(cell)));
      expect(shown.map((l) => l.key)).toEqual([
        'tests/manifest.test.ts:added:60',
        'tests/manifest.test.ts:added:61',
        'tests/manifest.test.ts:added:62',
      ]);
    },
  );

  it('builds the request a click on the line would send', () => {
    document.body.innerHTML = fixture('github-diff-classic.html');
    const [first] = visibleAddedLines(document, () => true);
    expect(first!.key).toBe('docs/roadmap.md:added:44');
    const request = first!.request()!;
    expect(request.subject).toEqual({ filePath: 'docs/roadmap.md', startLine: 44 });
    expect(request.code).toMatchObject({ filePath: 'docs/roadmap.md', startLine: 44, endLine: 44 });
    expect(request.text).toContain('Friendly LLM error messages');
  });

  it('explains the fixture lines ahead with the real requests', () => {
    document.body.innerHTML = fixture('github-diff-new-split.html');
    const env = setup({ lines: () => visibleAddedLines(document, () => true) });
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.ahead.running()).toBe('tests/manifest.test.ts:added:48');
    expect(env.streams[0]!.options.code).toMatchObject({ startLine: 48, endLine: 48 });
  });
});

/** The line number in a diff cell's row, for choosing which cells are "visible". */
function lineOf(cell: Element): string {
  const anchor = cell.getAttribute('data-line-anchor');
  if (anchor) return anchor.replace(/.*R/, '');
  const numbers = cell.closest('tr')!.querySelectorAll('[data-line-number]');
  return numbers[numbers.length - 1]?.getAttribute('data-line-number') ?? '';
}

describe('the Explain ahead setting', () => {
  it('is read under the key the settings page saves', () => {
    expect(AHEAD_SETTING_KEY).toBe(storageKey('explainAhead'));
  });

  it('is off until read, then follows each save', async () => {
    let listener: (changes: Record<string, StorageChange>, area: string) => void = () => {};
    const seen: boolean[] = [];
    const setting = trackAheadSetting(
      { get: async () => ({ [AHEAD_SETTING_KEY]: true }) },
      { addListener: (l) => void (listener = l) },
      (on) => seen.push(on),
    );
    expect(setting.current()).toBe(false);
    await settle();
    expect(setting.current()).toBe(true);
    listener({ [AHEAD_SETTING_KEY]: { newValue: false } }, 'sync');
    expect(setting.current()).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});
