import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHandlerDeps } from '../src/clickHandler';
import type { StorageChange } from '../src/enabledState';
import type { ExplainResult } from '../src/explain/explainHandler';
import type { HunkResult } from '../src/explain/hunkHandler';
import { MAX_HUNK_LINES } from '../src/explain/hunkPrompt';
import type { DiffHunk } from '../src/diffDom';
import {
  AHEAD_DONE_SHOWN_MS,
  AHEAD_HUNK_MAX_LINES,
  AHEAD_IDLE_MS,
  AHEAD_MAX_PER_PAGE,
  AHEAD_MAX_PER_PR,
  AHEAD_RETRY_MS,
  AHEAD_SETTING_KEY,
  aheadModeOf,
  createExplainAhead,
  trackAheadSetting,
  visibleAddedLines,
  worthExplaining,
  type AheadEvent,
  type AheadLine,
  type AheadPage,
  type AheadProgress,
  type ExplainAheadDeps,
  type HunkRequest,
  hunkRequest,
  orderWholePr,
  requestsAtOnceOf,
  samePrHead,
} from '../src/explainAhead';
import type { ExplainStream, PortStream } from '../src/messaging/client';
import { AHEAD_MODES, storageKey } from '../src/settings';

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

describe('Explain ahead on battery (PR 11.3)', () => {
  it('sends nothing while paused, and starts again on restart once plugged in', async () => {
    let paused = true;
    const env = setup({ isPaused: () => paused });
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS * 5);
    expect(env.explain).not.toHaveBeenCalled();

    // The content script restarts it when the laptop is plugged in.
    paused = false;
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.texts()).toEqual(['context of a']);
  });

  it('lets a running line finish when unplugged, then sends nothing new', async () => {
    let paused = false;
    const env = setup({ isPaused: () => paused });
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.texts()).toEqual(['context of a']);

    paused = true;
    expect(env.streams[0]!.stopped).toBe(false);
    await finishCurrent(env);
    vi.advanceTimersByTime(AHEAD_IDLE_MS * 5);
    expect(env.texts()).toEqual(['context of a']);
    expect(env.events).toContainEqual(expect.objectContaining({ type: 'finished', key: 'a' }));
  });

  it('never pauses with Keep going (isPaused always false)', () => {
    const env = setup({ isPaused: () => false });
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.texts()).toEqual(['context of a']);
  });
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
    expect(env.events).toContainEqual({ type: 'limit', count: AHEAD_MAX_PER_PAGE, wholePr: false });

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

describe('one request per hunk (PR 10.5)', () => {
  /** Lines `numbers` of one hunk of src/a.ts, which the page shows as `id`. */
  const hunkLines = (id: string, numbers: number[]): AheadLine[] => {
    const hunk: DiffHunk = {
      header: `@@ ${id} @@`,
      index: 0,
      lines: [
        { filePath: 'src/a.ts', lineNumber: 1, side: 'context', text: 'start' },
        ...numbers.map((n) => ({
          filePath: 'src/a.ts',
          lineNumber: n,
          side: 'added' as const,
          text: `line ${n}`,
        })),
      ],
    };
    return numbers.map((n) => ({
      key: `src/a.ts:added:${n}`,
      text: `line ${n}`,
      request: () => ({ text: `context of ${n}`, subject: { filePath: 'src/a.ts', startLine: n } }),
      hunk: { id, read: () => hunk },
    }));
  };

  function hunkSetup(lines: AheadLine[], overrides: Partial<ExplainAheadDeps> = {}) {
    const sent: { request: HunkRequest; finish(result: HunkResult): void; stopped: boolean }[] = [];
    const explainHunk = vi.fn((request: HunkRequest): PortStream<HunkResult> => {
      let settle!: (result: HunkResult) => void;
      let fail!: (error: unknown) => void;
      const result = new Promise<HunkResult>((res, rej) => {
        settle = res;
        fail = rej;
      });
      result.catch(() => {});
      const entry = { request, finish: settle, stopped: false };
      sent.push(entry);
      return {
        result,
        stop: () => {
          entry.stopped = true;
          fail(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
        },
      };
    });
    const env = setup({ explainHunk, lines: () => lines, ...overrides });
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    return { ...env, sent, explainHunk };
  }

  const answered = (
    request: HunkRequest,
    statuses: ('done' | 'cached' | 'missing')[],
  ): HunkResult => ({
    status: 'hunk',
    lines: request.lines.map((l, i) => ({ label: l.label, status: statuses[i] ?? 'done' })),
  });

  it('keeps the same limit as the service worker', () => {
    expect(AHEAD_HUNK_MAX_LINES).toBe(MAX_HUNK_LINES);
  });

  it('sends the lines of one hunk together, then the next hunk', async () => {
    const env = hunkSetup([...hunkLines('h1', [2, 3, 5]), ...hunkLines('h2', [9, 10])]);
    expect(env.sent).toHaveLength(1);
    const first = env.sent[0]!.request;
    expect(first.label).toBe('src/a.ts: lines 2, 3, 5');
    expect(first.lines.map((l) => [l.label, l.line, l.code])).toEqual([
      ['src/a.ts:added:2', 2, '+line 2'],
      ['src/a.ts:added:3', 3, '+line 3'],
      ['src/a.ts:added:5', 5, '+line 5'],
    ]);
    expect(first.lines[0]!.request.text).toBe('context of 2');
    expect(first.text).toBe(
      ['File: src/a.ts (TypeScript)', '@@ h1 @@', ' start', '+line 2', '+line 3', '+line 5'].join(
        '\n',
      ),
    );
    expect(env.ahead.running()).toBe('src/a.ts: lines 2, 3, 5');
    expect(env.explain).not.toHaveBeenCalled();
    env.sent[0]!.finish(answered(first, ['done', 'done', 'done']));
    await settle();
    expect(env.sent[1]!.request.label).toBe('src/a.ts: lines 9, 10');
    expect(env.events.find((e) => e.type === 'finished')).toMatchObject({
      key: 'src/a.ts: lines 2, 3, 5',
      status: 'done',
      cached: false,
    });
  });

  it(`sends at most ${AHEAD_HUNK_MAX_LINES} lines at a time, and a lone line on its own`, async () => {
    const big = hunkLines(
      'h1',
      Array.from({ length: 17 }, (_, i) => i + 2),
    );
    const env = hunkSetup([...big, ...hunkLines('h2', [40])]);
    expect(env.sent[0]!.request.lines).toHaveLength(AHEAD_HUNK_MAX_LINES);
    env.sent[0]!.finish(answered(env.sent[0]!.request, []));
    await settle();
    expect(env.sent[1]!.request.lines.map((l) => l.line)).toEqual([17, 18]);
    env.sent[1]!.finish(answered(env.sent[1]!.request, []));
    await settle();
    // One line left in its hunk: the usual single-line request.
    expect(env.texts()).toEqual(['context of 40']);
  });

  it('counts each line toward the page limit, and lines from the cache do not', async () => {
    const env = hunkSetup(hunkLines('h1', [2, 3, 4, 5]), { maxPerPage: 3 });
    expect(env.sent[0]!.request.lines.map((l) => l.line)).toEqual([2, 3, 4]);
    env.sent[0]!.finish(answered(env.sent[0]!.request, ['cached', 'cached', 'done']));
    await settle();
    // Two came from the cache, so there is room for the fourth line.
    expect(env.texts()).toEqual(['context of 5']);
  });

  it('asks again after a scroll for the lines the answer left out', async () => {
    const lines = hunkLines('h1', [2, 3]);
    const env = hunkSetup(lines);
    env.sent[0]!.finish(answered(env.sent[0]!.request, ['done', 'missing']));
    await settle();
    expect(env.sent).toHaveLength(1);
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.texts()).toEqual(['context of 3']);
  });

  it('puts every line of a stopped hunk back, and a failed hunk ends the pass', async () => {
    const env = hunkSetup(hunkLines('h1', [2, 3]));
    env.ahead.cancel();
    expect(env.sent[0]!.stopped).toBe(true);
    expect(env.events.at(-1)).toEqual({ type: 'cancelled', key: 'src/a.ts: lines 2, 3' });
    env.ahead.restart();
    vi.advanceTimersByTime(AHEAD_IDLE_MS);
    expect(env.sent[1]!.request.lines).toHaveLength(2);
    env.sent[1]!.finish({ status: 'failed', message: 'down', fix: 'start it' });
    await settle();
    expect(env.sent).toHaveLength(2);
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('builds the hunks of a saved GitHub diff from the page', () => {
    document.body.innerHTML = readFileSync(
      resolve(import.meta.dirname, 'fixtures', 'github-diff-new-split.html'),
      'utf8',
    );
    const lines = visibleAddedLines(document, () => true);
    const groups = new Map<string, AheadLine[]>();
    for (const l of lines) groups.set(l.hunk!.id, [...(groups.get(l.hunk!.id) ?? []), l]);
    expect([...groups.values()].map((g) => g.map((l) => l.key.replace(/.*:/, '')))).toEqual([
      ['48', '50'],
      ['59', '60', '61', '62', '63'],
    ]);
    const request = hunkRequest([...groups.values()][1]!)!;
    expect(request.label).toBe('tests/manifest.test.ts: lines 59, 60, 61, 62, 63');
    expect(request.text.split('\n')[0]).toBe('File: tests/manifest.test.ts (TypeScript)');
    expect(request.text).toMatch(/^@@ /m);
    // Each line carries exactly the request a click on it sends.
    request.lines.forEach((l, i) => {
      const own = [...groups.values()][1]![i]!.request()!;
      expect(l.request).toEqual(own);
      expect(request.text).toContain(l.code);
    });
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

  it('is Off until read, then follows each save, reading an old on or off (PR 10.6)', async () => {
    let listener: (changes: Record<string, StorageChange>, area: string) => void = () => {};
    const seen: string[] = [];
    const setting = trackAheadSetting(
      { get: async () => ({ [AHEAD_SETTING_KEY]: true }) },
      { addListener: (l) => void (listener = l) },
      (mode) => seen.push(mode),
    );
    expect(setting.current()).toBe('off');
    await settle();
    // Saved as on before PR 10.6.
    expect(setting.current()).toBe('screen');
    listener({ [AHEAD_SETTING_KEY]: { newValue: 'pr' } }, 'sync');
    expect(setting.current()).toBe('pr');
    listener({ [AHEAD_SETTING_KEY]: { newValue: false } }, 'sync');
    expect(setting.current()).toBe('off');
    expect(seen).toEqual(['screen', 'pr', 'off']);
  });

  it('reads the same values the settings page saves', () => {
    expect(AHEAD_MODES.map(aheadModeOf)).toEqual([...AHEAD_MODES]);
    expect([true, false, 'fast', undefined].map(aheadModeOf)).toEqual([
      'screen',
      'off',
      'off',
      'off',
    ]);
  });
});

describe('Whole PR (PR 10.6)', () => {
  /** A changed line `n` of `file`, as built from the PR's diff, `order` in the PR. */
  const prLine = (file: string, n: number, order: number): AheadLine => ({
    key: `${file}:added:${n}`,
    text: `line ${n}`,
    filePath: file,
    order,
    request: () => ({
      text: `context of ${file}:${n}`,
      subject: { filePath: file, startLine: n },
    }),
  });
  /** Five files of two lines each, in the PR's order. */
  const FILES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
  const PR_LINES = FILES.flatMap((file, i) => [prLine(file, 1, i * 2), prLine(file, 2, i * 2 + 1)]);
  /** The page's own copy of a line on screen (no order, as visibleAddedLines gives it). */
  const shown = (file: string, n: number): AheadLine => ({
    key: `${file}:added:${n}`,
    text: `line ${n}`,
    filePath: file,
    request: () => null,
  });

  function prSetup(overrides: Partial<ExplainAheadDeps> = {}) {
    let screen: AheadLine[] = [shown('c.ts', 2)];
    let prLines: AheadLine[] | null = PR_LINES;
    let key: AheadPage | undefined = { pr: 'o/r#1', head: 'abc' };
    const env = setup({
      wholePr: () => true,
      prLines: async () => prLines,
      lines: () => screen,
      pageKey: () => key,
      ...overrides,
    });
    return {
      ...env,
      setScreen: (lines: AheadLine[]) => (screen = lines),
      setPrLines: (lines: AheadLine[] | null) => (prLines = lines),
      setKey: (value: AheadPage | undefined) => (key = value),
      /** Waits out the idle time and the PR diff read. */
      async idle() {
        vi.advanceTimersByTime(AHEAD_IDLE_MS);
        await settle();
      },
    };
  }

  it('orders the lines on screen first, then their files and the files next to them, then the rest', () => {
    const ordered = orderWholePr(PR_LINES, [shown('c.ts', 2)]);
    expect(ordered.map((l) => [l.key, l.priority])).toEqual([
      ['c.ts:added:2', 'on-screen'],
      // The rest of the file on screen, and the files just above and below it.
      ['b.ts:added:1', 'near-screen'],
      ['b.ts:added:2', 'near-screen'],
      ['c.ts:added:1', 'near-screen'],
      ['d.ts:added:1', 'near-screen'],
      ['d.ts:added:2', 'near-screen'],
      // The rest in the PR's order.
      ['a.ts:added:1', 'rest'],
      ['a.ts:added:2', 'rest'],
      ['e.ts:added:1', 'rest'],
      ['e.ts:added:2', 'rest'],
    ]);
    // Nothing on screen: the PR's order.
    expect(orderWholePr(PR_LINES, []).map((l) => l.key)).toEqual(PR_LINES.map((l) => l.key));
    expect(new Set(orderWholePr(PR_LINES, []).map((l) => l.priority))).toEqual(new Set(['rest']));
  });

  it('counts a file on screen with no changed line in view as on screen', () => {
    // A file header or removed lines in view: its file and the files next to it come first.
    const ordered = orderWholePr(PR_LINES, [{ ...shown('e.ts', 99), key: 'e.ts:removed:99' }]);
    expect(ordered.slice(0, 4).map((l) => [l.key, l.priority])).toEqual([
      ['d.ts:added:1', 'near-screen'],
      ['d.ts:added:2', 'near-screen'],
      ['e.ts:added:1', 'near-screen'],
      ['e.ts:added:2', 'near-screen'],
    ]);
  });

  it('queues every changed line of the PR, telling the queue its priority and place', async () => {
    const env = prSetup();
    env.ahead.restart();
    await env.idle();
    expect(env.texts()).toEqual(['context of c.ts:2']);
    expect(env.streams[0]!.options.job).toEqual({
      label: 'c.ts:added:2',
      priority: 'on-screen',
      order: 5,
    });
    expect(env.ahead.queued()).toHaveLength(PR_LINES.length - 1);
    for (let i = 0; i < PR_LINES.length; i++) await finishCurrent(env);
    expect(env.texts()).toHaveLength(PR_LINES.length);
    expect(env.streams[1]!.options.job).toEqual({
      label: 'b.ts:added:1',
      priority: 'near-screen',
      order: 2,
    });
    expect(env.streams.at(-1)!.options.job).toEqual({
      label: 'e.ts:added:2',
      priority: 'rest',
      order: 9,
    });
    expect(env.ahead.running()).toBeUndefined();
  });

  it('sends a hunk of the PR as one request, with its priority and place', async () => {
    const hunk: DiffHunk = {
      header: '@@ -1 +1,3 @@',
      index: 0,
      lines: [1, 2, 3].map((n) => ({
        filePath: 'f.ts',
        lineNumber: n,
        side: 'added' as const,
        text: `line ${n}`,
      })),
    };
    const lines = [1, 2, 3].map((n, order) => ({
      ...prLine('f.ts', n, order),
      hunk: { id: 'patch:0', read: () => hunk },
    }));
    const explainHunk = vi.fn<NonNullable<ExplainAheadDeps['explainHunk']>>(() => ({
      result: new Promise<HunkResult>(() => {}),
      stop: () => {},
    }));
    const env = prSetup({ prLines: async () => lines, explainHunk });
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    expect(explainHunk).toHaveBeenCalledTimes(1);
    const [request, options] = explainHunk.mock.calls[0]!;
    expect(request.label).toBe('f.ts: lines 1, 2, 3');
    expect(options).toEqual({ debugId: 'ahead-1', job: { priority: 'rest', order: 0 } });
  });

  it('counts only the lines a hunk answered toward the limit (review on #65)', async () => {
    const hunk: DiffHunk = {
      header: '@@ -1 +1,2 @@',
      index: 0,
      lines: [1, 2].map((n) => ({
        filePath: 'f.ts',
        lineNumber: n,
        side: 'added' as const,
        text: `line ${n}`,
      })),
    };
    const lines = [1, 2].map((n, order) => ({
      ...prLine('f.ts', n, order),
      hunk: { id: 'patch:0', read: () => hunk },
    }));
    let answer!: (result: HunkResult) => void;
    const explainHunk = vi.fn<NonNullable<ExplainAheadDeps['explainHunk']>>(() => ({
      result: new Promise<HunkResult>((resolve) => (answer = resolve)),
      stop: () => {},
    }));
    const env = prSetup({ prLines: async () => lines, explainHunk, maxPerPr: 2 });
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    expect(explainHunk).toHaveBeenCalledTimes(1);
    // The model's answer left out line 2.
    answer({
      status: 'hunk',
      lines: [
        { label: 'f.ts:added:1', status: 'done' },
        { label: 'f.ts:added:2', status: 'missing' },
      ],
    });
    await settle();
    expect(env.events).not.toContainEqual(expect.objectContaining({ type: 'limit' }));
    // After a scroll, line 2 is asked again, on its own, within the limit.
    env.ahead.restart();
    await env.idle();
    expect(env.texts()).toEqual(['context of f.ts:2']);
    await finishCurrent(env);
    // Now both lines count, and the limit is reached on the next pass.
    env.ahead.restart();
    await env.idle();
    expect(env.explain).toHaveBeenCalledTimes(1);
  });

  it('moves the code you scroll to to the front', async () => {
    const env = prSetup();
    env.ahead.restart();
    await env.idle();
    expect(env.ahead.running()).toBe('c.ts:added:2');
    // Scroll to the last file while the first line is explained.
    env.setScreen([shown('e.ts', 1), shown('e.ts', 2)]);
    env.ahead.restart();
    await env.idle();
    // The line already running keeps going.
    expect(env.streams[0]!.stopped).toBe(false);
    expect(env.ahead.queued().slice(0, 4)).toEqual([
      'e.ts:added:1',
      'e.ts:added:2',
      'd.ts:added:1',
      'd.ts:added:2',
    ]);
    await finishCurrent(env);
    expect(env.texts().at(-1)).toBe('context of e.ts:1');
    expect(env.streams.at(-1)!.options.job?.priority).toBe('on-screen');
  });

  it(`stops at ${AHEAD_MAX_PER_PR} lines the model answered for one PR`, async () => {
    const many = Array.from({ length: AHEAD_MAX_PER_PR + 20 }, (_, i) =>
      prLine('big.ts', i + 1, i),
    );
    const env = prSetup({ prLines: async () => many });
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    for (let i = 0; i < AHEAD_MAX_PER_PR; i++) await finishCurrent(env);
    expect(env.explain).toHaveBeenCalledTimes(AHEAD_MAX_PER_PR);
    expect(env.events).toContainEqual({ type: 'limit', count: AHEAD_MAX_PER_PR, wholePr: true });
    expect(env.ahead.queued()).toEqual([]);
  });

  it('keeps the limit and the lines done across page changes of the same PR and head', async () => {
    const env = prSetup({ maxPerPr: 3 });
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    await finishCurrent(env);
    await finishCurrent(env);
    // Off to the Conversation tab and back.
    env.ahead.pageChanged();
    env.ahead.restart();
    await env.idle();
    // The line stopped by the page change is asked again; the two done are
    // not, and only one more fits.
    expect(env.texts()).toEqual([
      'context of a.ts:1',
      'context of a.ts:2',
      'context of b.ts:1',
      'context of b.ts:1',
    ]);
    await finishCurrent(env);
    expect(env.explain).toHaveBeenCalledTimes(4);
    expect(env.events).toContainEqual({ type: 'limit', count: 3, wholePr: true });
  });

  it('starts over when the PR gets a new commit', async () => {
    const env = prSetup({ maxPerPr: 2 });
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    await finishCurrent(env);
    await finishCurrent(env);
    expect(env.explain).toHaveBeenCalledTimes(2);
    // The push changes the code, so the requests (and cache keys) are new.
    env.setPrLines(
      PR_LINES.map((l) => ({ ...l, request: () => ({ ...l.request()!, text: `new ${l.key}` }) })),
    );
    env.setKey({ pr: 'o/r#1', head: 'def' });
    env.ahead.pageChanged();
    env.ahead.restart();
    await env.idle();
    // The same names, but new code: asked again, with a new limit.
    expect(env.texts().at(-1)).toBe('new a.ts:added:1');
    await finishCurrent(env);
    await finishCurrent(env);
    expect(env.explain).toHaveBeenCalledTimes(4);
    expect(env.events.filter((e) => e.type === 'limit')).toHaveLength(2);
  });

  it('starts over on every page change off a PR', async () => {
    const env = prSetup({ maxPerPr: 1 });
    env.setKey(undefined);
    env.ahead.pageChanged();
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    await finishCurrent(env);
    env.ahead.pageChanged();
    env.ahead.restart();
    await env.idle();
    // Asked again (and answered from the cache, so it does not count), then the next.
    expect(env.texts()).toEqual(['context of a.ts:1', 'context of a.ts:1', 'context of a.ts:2']);
  });

  it('keeps the lines done through a page that does not say its head, such as the Conversation tab', async () => {
    const env = prSetup({ maxPerPr: 2 });
    env.setScreen([]);
    env.ahead.restart();
    await env.idle();
    await finishCurrent(env);
    await finishCurrent(env);
    env.setKey({ pr: 'o/r#1', head: null });
    env.ahead.pageChanged();
    env.setKey({ pr: 'o/r#1', head: 'abc' });
    env.ahead.pageChanged();
    env.ahead.restart();
    await env.idle();
    expect(env.explain).toHaveBeenCalledTimes(2);
    // Another PR starts over.
    env.setKey({ pr: 'o/r#2', head: 'abc' });
    env.ahead.pageChanged();
    env.ahead.restart();
    await env.idle();
    // Asked again from the start (the fake's cache answers the first two at
    // once), and the next line is sent.
    expect(env.texts().slice(2)).toEqual([
      'context of a.ts:1',
      'context of a.ts:2',
      'context of b.ts:1',
    ]);
  });

  it('tells whether a page change keeps the lines done', () => {
    const at = (pr: string, head: string | null): AheadPage => ({ pr, head });
    expect(samePrHead(at('o/r#1', 'a'), at('o/r#1', 'a'))).toBe(true);
    expect(samePrHead(at('o/r#1', 'a'), at('o/r#1', null))).toBe(true);
    expect(samePrHead(at('o/r#1', null), at('o/r#1', 'b'))).toBe(true);
    expect(samePrHead(at('o/r#1', 'a'), at('o/r#1', 'b'))).toBe(false);
    expect(samePrHead(at('o/r#1', 'a'), at('o/r#2', 'a'))).toBe(false);
    expect(samePrHead(undefined, at('o/r#1', 'a'))).toBe(false);
    expect(samePrHead(at('o/r#1', 'a'), undefined)).toBe(false);
  });

  it('pauses while busy (a hidden tab, a click or chat answer) and carries on after', async () => {
    const env = prSetup();
    env.setBusy(true);
    env.ahead.restart();
    await env.idle();
    vi.advanceTimersByTime(AHEAD_RETRY_MS * 10);
    expect(env.explain).not.toHaveBeenCalled();
    env.setBusy(false);
    vi.advanceTimersByTime(AHEAD_RETRY_MS);
    expect(env.texts()).toEqual(['context of c.ts:2']);
  });

  it('sends nothing while click-to-explain is off', async () => {
    const env = prSetup();
    env.setEnabled(false);
    env.ahead.restart();
    await env.idle();
    expect(env.explain).not.toHaveBeenCalled();
  });

  it('sends nothing after leaving the PR, even when its diff arrives late', async () => {
    let answer!: (lines: AheadLine[]) => void;
    const env = prSetup({ prLines: () => new Promise((resolve) => (answer = resolve)) });
    env.ahead.restart();
    await env.idle();
    env.ahead.cancel();
    answer(PR_LINES);
    await settle();
    vi.advanceTimersByTime(AHEAD_IDLE_MS * 5);
    expect(env.explain).not.toHaveBeenCalled();
    expect(env.ahead.queued()).toEqual([]);
  });

  it('stops when the setting is turned off', async () => {
    const env = prSetup();
    env.ahead.restart();
    await env.idle();
    env.setOn(false);
    env.ahead.cancel();
    expect(env.streams[0]!.stopped).toBe(true);
    expect(env.ahead.queued()).toEqual([]);
  });

  it('explains the lines on screen when the PR diff cannot be read', async () => {
    const env = prSetup();
    env.setPrLines(null);
    env.setScreen([line('x'), line('y')]);
    env.ahead.restart();
    await env.idle();
    expect(env.texts()).toEqual(['context of x']);
    expect(env.ahead.queued()).toEqual(['y']);
  });

  it('leaves the PR diff alone with Lines on screen', async () => {
    const prLines = vi.fn(async () => PR_LINES);
    const env = prSetup({ wholePr: () => false, prLines });
    env.setScreen([line('x')]);
    env.ahead.restart();
    await env.idle();
    expect(prLines).not.toHaveBeenCalled();
    expect(env.texts()).toEqual(['context of x']);
    expect(env.streams[0]!.options.job).toEqual({ label: 'x' });
  });

  it('sends up to Requests at once together, and stops them all when cancelled', async () => {
    let atOnce = 2;
    const env = prSetup({ concurrency: () => atOnce });
    env.ahead.restart();
    await env.idle();
    expect(env.texts()).toEqual(['context of c.ts:2', 'context of b.ts:1']);
    expect(env.ahead.runningAll()).toEqual(['c.ts:added:2', 'b.ts:added:1']);
    await finishCurrent(env);
    // One finished, so the next starts: still two running.
    expect(env.ahead.runningAll()).toHaveLength(2);
    atOnce = 1;
    await finishCurrent(env);
    expect(env.ahead.runningAll()).toHaveLength(1);
    env.ahead.cancel();
    expect(env.streams.filter((s) => s.stopped)).toHaveLength(1);
    expect(env.ahead.runningAll()).toEqual([]);
  });

  it('keeps Requests at once to 1 to 4', async () => {
    const env = prSetup({ concurrency: () => 10 });
    env.ahead.restart();
    await env.idle();
    expect(env.ahead.runningAll()).toHaveLength(4);
  });

  it('reads Requests at once as the settings page saves it', () => {
    expect([1, 2, 4, 0, 5, 1.5, '2', undefined].map(requestsAtOnceOf)).toEqual([
      1, 2, 4, 1, 1, 1, 1, 1,
    ]);
  });

  describe('progress for the toolbar badge (PR 10.7)', () => {
    function progressSetup(overrides: Partial<ExplainAheadDeps> = {}) {
      const progress: (AheadProgress | null)[] = [];
      const env = prSetup({ onProgress: (p) => progress.push(p), ...overrides });
      return { ...env, progress };
    }

    it('counts the PR lines done, from the model or the cache, as they finish', async () => {
      const env = progressSetup();
      env.setScreen([]);
      env.ahead.restart();
      // Nothing to show until the PR's lines are known.
      expect(env.progress).toEqual([null]);
      await env.idle();
      expect(env.progress.at(-1)).toEqual({ done: 0, total: 10 });
      await finishCurrent(env);
      expect(env.progress.at(-1)).toEqual({ done: 1, total: 10 });
      await finishCurrent(env, CACHED);
      expect(env.progress.at(-1)).toEqual({ done: 2, total: 10 });
      // Only changes are told.
      expect(env.progress).toEqual([null, ...[0, 1, 2].map((done) => ({ done, total: 10 }))]);
    });

    it('leaves out blank and closing lines from the total', async () => {
      const env = progressSetup();
      env.setPrLines([...PR_LINES, { ...prLine('e.ts', 3, 10), text: '  });' }]);
      env.ahead.restart();
      await env.idle();
      expect(env.progress.at(-1)).toEqual({ done: 0, total: 10 });
    });

    it('shows the PR done once, then clears it', async () => {
      const env = progressSetup();
      env.ahead.restart();
      await env.idle();
      for (let i = 0; i < PR_LINES.length; i++) await finishCurrent(env);
      expect(env.progress.at(-1)).toEqual({ done: 10, total: 10 });
      vi.advanceTimersByTime(AHEAD_DONE_SHOWN_MS - 1);
      expect(env.progress.at(-1)).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(env.progress.at(-1)).toBeNull();
      // A scroll over the finished PR does not show the tick again.
      const told = env.progress.length;
      env.ahead.restart();
      await env.idle();
      expect(env.progress).toHaveLength(told);
    });

    it('says when it stopped at the per-PR limit', async () => {
      const env = progressSetup({ maxPerPr: 2 });
      env.setScreen([]);
      env.ahead.restart();
      await env.idle();
      await finishCurrent(env);
      await finishCurrent(env);
      expect(env.progress.at(-1)).toEqual({ done: 2, total: 10, limited: 2 });
    });

    it('shows the progress again after a scroll', async () => {
      const env = progressSetup();
      env.ahead.restart();
      await env.idle();
      await finishCurrent(env);
      env.ahead.cancel();
      expect(env.progress.at(-1)).toBeNull();
      env.ahead.restart();
      expect(env.progress.at(-1)).toEqual({ done: 1, total: 10 });
    });

    it('clears when turned off, click-to-explain is off, or the page changes', async () => {
      const env = progressSetup();
      env.ahead.restart();
      await env.idle();
      env.setOn(false);
      env.ahead.cancel();
      expect(env.progress.at(-1)).toBeNull();
      env.setOn(true);
      env.ahead.restart();
      await env.idle();
      expect(env.progress.at(-1)).toEqual({ done: 0, total: 10 });
      env.setEnabled(false);
      env.ahead.restart();
      expect(env.progress.at(-1)).toBeNull();
      env.setEnabled(true);
      env.ahead.restart();
      await env.idle();
      env.setKey({ pr: 'o/r#2', head: 'x' });
      env.ahead.pageChanged();
      expect(env.progress.at(-1)).toBeNull();
    });

    it('shows nothing with Lines on screen or when the PR diff cannot be read', async () => {
      const screenOnly = progressSetup({ wholePr: () => false });
      screenOnly.ahead.restart();
      await screenOnly.idle();
      expect(screenOnly.progress).toEqual([null]);
      const unreadable = progressSetup();
      unreadable.setPrLines(null);
      unreadable.ahead.restart();
      await unreadable.idle();
      expect(unreadable.progress).toEqual([null]);
    });
  });

  describe('skipping generated and vendored files (PR 11.4)', () => {
    /** Skips b.ts and d.ts, as a lockfile and a bundle would be. */
    const skipBD = async () => (file: string) => file === 'b.ts' || file === 'd.ts';

    it('queues no line of a skipped file, and tells the queue only the rest', async () => {
      const env = prSetup({ skipFile: skipBD });
      env.setScreen([]);
      env.ahead.restart();
      await env.idle();
      const all = [env.ahead.running(), ...env.ahead.queued()];
      expect(all).toEqual([
        'a.ts:added:1',
        'a.ts:added:2',
        'c.ts:added:1',
        'c.ts:added:2',
        'e.ts:added:1',
        'e.ts:added:2',
      ]);
      for (let i = 0; i < all.length; i++) await finishCurrent(env);
      expect(env.explain).toHaveBeenCalledTimes(6);
      expect(env.texts().some((t) => /[bd]\.ts/.test(t))).toBe(false);
      expect(env.events).toContainEqual({ type: 'skipped', files: ['b.ts', 'd.ts'] });
    });

    it('leaves a skipped file on screen alone too, with Lines on screen', async () => {
      const env = setup({
        skipFile: skipBD,
        lines: () =>
          [shown('b.ts', 1), shown('c.ts', 1)].map((l) => ({
            ...l,
            request: () => ({
              text: `screen ${l.key}`,
              subject: { filePath: l.filePath!, startLine: 1 },
            }),
          })),
      });
      env.ahead.restart();
      vi.advanceTimersByTime(AHEAD_IDLE_MS);
      await settle();
      expect(env.texts()).toEqual(['screen c.ts:added:1']);
      expect(env.ahead.queued()).toEqual([]);
    });

    it('counts only the files it explains, and says how many it skipped', async () => {
      const progress: (AheadProgress | null)[] = [];
      const env = prSetup({ skipFile: skipBD, onProgress: (p) => progress.push(p) });
      env.setScreen([]);
      env.ahead.restart();
      await env.idle();
      expect(progress.at(-1)).toEqual({ done: 0, total: 6, skipped: 2 });
      for (let i = 0; i < 6; i++) await finishCurrent(env);
      expect(progress.at(-1)).toEqual({ done: 6, total: 6, skipped: 2 });
    });

    it('says so when every file is skipped, and sends nothing (review on #73)', async () => {
      const progress: (AheadProgress | null)[] = [];
      const env = prSetup({
        skipFile: async () => () => true,
        onProgress: (p) => progress.push(p),
        doneShownMs: 5_000,
      });
      env.ahead.restart();
      await env.idle();
      expect(env.explain).not.toHaveBeenCalled();
      expect(env.ahead.queued()).toEqual([]);
      expect(progress.at(-1)).toEqual({ done: 0, total: 0, skipped: 5 });
      vi.advanceTimersByTime(5_000);
      expect(progress.at(-1)).toBeNull();
    });

    it('queues the rest when the check throws for a file (review on #73)', async () => {
      const env = prSetup({
        skipFile: async () => (file: string) => {
          if (file === 'b.ts') throw new SyntaxError('Invalid regular expression');
          return file === 'd.ts';
        },
      });
      env.setScreen([]);
      env.ahead.restart();
      await env.idle();
      const all = [env.ahead.running(), ...env.ahead.queued()];
      expect(all).toHaveLength(8);
      expect(all.some((key) => key?.startsWith('d.ts'))).toBe(false);
      expect(all.filter((key) => key?.startsWith('b.ts'))).toHaveLength(2);
    });

    it('skips nothing when the files to skip cannot be worked out', async () => {
      const env = prSetup({ skipFile: async () => Promise.reject(new Error('offline')) });
      env.setScreen([]);
      env.ahead.restart();
      await env.idle();
      expect(env.ahead.queued()).toHaveLength(PR_LINES.length - 1);
    });

    it('asks again at each wait, so a changed setting is used after the next scroll', async () => {
      let skipped = new Set(['b.ts']);
      const env = prSetup({ skipFile: async () => (file: string) => skipped.has(file) });
      env.setScreen([]);
      env.ahead.restart();
      await env.idle();
      expect(env.ahead.queued().some((key) => key.startsWith('b.ts'))).toBe(false);
      skipped = new Set();
      env.ahead.restart();
      await env.idle();
      expect(env.ahead.queued().filter((key) => key.startsWith('b.ts'))).toHaveLength(2);
    });

    it('ignores an answer for a wait a scroll has replaced', async () => {
      let answer!: (skip: (file: string) => boolean) => void;
      const skipFile = vi
        .fn<NonNullable<ExplainAheadDeps['skipFile']>>()
        .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
        .mockImplementation(skipBD);
      const env = prSetup({ skipFile });
      env.setScreen([]);
      env.ahead.restart();
      vi.advanceTimersByTime(AHEAD_IDLE_MS);
      env.ahead.cancel();
      answer(() => false);
      await settle();
      expect(env.explain).not.toHaveBeenCalled();
    });
  });
});
