// PR 9.4: the debug window shows every round trip, live.
import {
  createDebugWindow,
  formatMs,
  RECONNECT_MS,
  splitThinking,
  TICK_MS,
  WINDOW_LIMIT,
  type DebugPort,
  type DebugWindowDeps,
} from '../src/debug/debugWindow';
import { DEBUG_SETTING_KEY, trackDebugSetting } from '../src/debug/debugSetting';
import type {
  DebugEntry,
  DebugLogPortMessage,
  DebugRunningEntry,
  DebugTraceEntry,
} from '../src/debug/types';
import { DEBUG_LOG_LIMIT } from '../src/debug/debugLog';
import { storageKey } from '../src/settings';
import type { RoundTrip } from '../src/trace/types';

const T0 = new Date(2026, 10, 3, 14, 2, 7, 315).getTime();

function trip(overrides: Partial<RoundTrip> = {}): RoundTrip {
  return {
    target: 'ollama',
    method: 'POST',
    endpoint: 'localhost:11434/api/chat',
    purpose: 'explanation',
    cause: 'click',
    startMs: 0,
    durationMs: 1_200,
    status: 'done',
    httpStatus: 200,
    bytesSent: 900,
    bytesReceived: 3_000,
    ...overrides,
  };
}

let nextId = 1;
function entry(
  group: string,
  at: number,
  overrides: Partial<RoundTrip> = {},
  extra: Partial<DebugEntry> = {},
): DebugEntry {
  return {
    id: nextId++,
    kind: 'round-trip',
    group,
    cause: 'click',
    at,
    trip: trip(overrides),
    ...extra,
  } as DebugEntry;
}

function runningEntry(id: string, at: number, reply = ''): DebugRunningEntry {
  return {
    kind: 'round-trip',
    group: id.split(':')[0]!,
    cause: 'click',
    at,
    trip: trip({ id, status: 'running', durationMs: 0, reply, httpStatus: 200 }),
  };
}

function traceEntry(group: string, at: number): DebugTraceEntry {
  return {
    id: nextId++,
    kind: 'trace',
    group,
    cause: 'click',
    at,
    where: 'src/app.ts:12',
    tasks: [
      {
        key: 'pr-description',
        label: 'Read the PR description',
        source: 'page',
        startMs: 0,
        durationMs: 40,
      },
      {
        key: 'model',
        label: 'Wait for the model',
        source: 'model',
        startMs: 60,
        durationMs: 1_200,
      },
    ],
  };
}

function setup(overrides: Partial<DebugWindowDeps> = {}) {
  let time = T0 + 60_000;
  const ports: {
    port: DebugPort;
    send(m: DebugLogPortMessage): void;
    drop(): void;
  }[] = [];
  const deps: DebugWindowDeps = {
    connect: () => {
      let onMessage: (m: unknown) => void = () => {};
      let onDisconnect = () => {};
      const port: DebugPort = {
        onMessage: { addListener: (l) => void (onMessage = l) },
        onDisconnect: { addListener: (l) => void (onDisconnect = l) },
        disconnect: vi.fn(),
      };
      ports.push({ port, send: (m) => onMessage(m), drop: () => onDisconnect() });
      return port;
    },
    clear: vi.fn(async () => ({ cleared: true })),
    copy: vi.fn(async () => {}),
    now: () => time,
    ...overrides,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const win = createDebugWindow(root, deps);
  const port = () => ports.at(-1)!;
  const q = <E extends Element = HTMLElement>(selector: string) => root.querySelector<E>(selector)!;
  const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const button = (text: RegExp) =>
    all('.controls button').find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement;
  return {
    root,
    win,
    deps,
    ports,
    port,
    q,
    all,
    button,
    advance: (ms: number) => void (time += ms),
    groupTitles: () => all('.group-title').map((h) => h.textContent),
    rowTexts: () => all('.row-button').map((b) => b.getAttribute('aria-label')),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  nextId = 1;
});
afterEach(() => vi.useRealTimers());

describe('debug window (PR 9.4)', () => {
  it('groups round trips under their cause, newest first, with the file, total time and count', () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [
        entry(
          'warm',
          T0,
          { purpose: 'load the model', cause: 'warmup', durationMs: 3_000 },
          { cause: 'warmup' },
        ),
        entry('c1', T0 + 5_000, {
          purpose: 'model details',
          endpoint: 'localhost:11434/api/show',
          durationMs: 20,
        }),
        entry('c1', T0 + 5_100, { durationMs: 1_200 }),
        traceEntry('c1', T0 + 4_900),
        entry('chat', T0 + 9_000, { purpose: 'chat answer', cause: 'chat' }, { cause: 'chat' }),
      ],
      running: [],
    });
    expect(w.groupTitles()).toEqual([
      expect.stringMatching(/^Chat question.*1 round trip$/),
      'Clicksrc/app.ts:1214:02:12.215 · 1.4 s · 2 round trips',
      expect.stringMatching(/^Warm-up.*3\.0 s · 1 round trip$/),
    ]);
    // Newest first within the click too.
    expect(w.all('section')[1]!.querySelectorAll('.purpose')[0]!.textContent).toBe('explanation');
    expect(w.rowTexts()[1]).toBe(
      '14:02:12.415, Ollama localhost:11434/api/chat, explanation, 1.2 s, 200',
    );
    expect(w.q('.summary').textContent).toBe('4 round trips in 3 groups');
    expect(w.q('.empty').hidden).toBe(true);
  });

  it('says how to fill it when the log is empty', () => {
    const w = setup();
    w.port().send({ type: 'snapshot', entries: [], running: [] });
    expect(w.q('.empty').hidden).toBe(false);
    expect(w.q('.empty').textContent).toMatch(/click a line/);
  });

  it('adds a new entry live, and a running row shows its reply growing and its time ticking', () => {
    const w = setup();
    w.port().send({ type: 'snapshot', entries: [], running: [] });
    w.port().send({ type: 'running', entry: runningEntry('c1:1', T0 + 60_000) });
    const row = w.q('.row');
    expect(row.dataset.status).toBe('running');
    w.q<HTMLButtonElement>('.row-button').click();
    expect(w.q('.answer .content').textContent).toBe('(nothing yet)');
    w.advance(1_500);
    vi.advanceTimersByTime(TICK_MS);
    expect(w.q('.duration').textContent).toBe('1.5 s');
    expect(w.q('.group-title .meta').textContent).toMatch(/1\.5 s so far/);
    w.port().send({ type: 'running', entry: runningEntry('c1:1', T0 + 60_000, 'It retries') });
    expect(w.q('.answer .content').textContent).toBe('It retries');
    // The finished entry takes the running row's place, still open.
    w.port().send({
      type: 'entry',
      entry: entry('c1', T0 + 60_000, {
        id: 'c1:1',
        reply: 'It retries the call.',
        durationMs: 1_700,
      }),
    });
    expect(w.all('.row')).toEqual([row]);
    expect(row.dataset.status).toBe('done');
    expect(w.q('.duration').textContent).toBe('1.7 s');
    expect(w.q('.answer .content').textContent).toBe('It retries the call.');
    // A late update of a round trip that ended is dropped.
    w.port().send({ type: 'running', entry: runningEntry('c1:1', T0 + 60_000, 'It') });
    expect(w.all('.row')).toHaveLength(1);
    expect(row.dataset.status).toBe('done');
  });

  it('opens a row to show the prompt by role, the reply with thinking apart, the timings and the waterfall', () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [
        traceEntry('c1', T0),
        entry('c1', T0 + 60, {
          messages: [
            { role: 'system', content: 'You explain code.' },
            { role: 'user', content: 'Explain: retry(fn)' },
          ],
          reply: '<think>The user wants a short answer.</think>\n**What it does** Retries.',
          timings: {
            loadMs: 3,
            promptTokens: 410,
            promptMs: 220,
            answerTokens: 60,
            answerMs: 900,
            totalMs: 1_150,
          },
        }),
      ],
      running: [],
    });
    const button = w.q<HTMLButtonElement>('.row-button');
    const detail = w.q('.detail');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(detail.hidden).toBe(true);
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(detail.id);
    expect(detail.hidden).toBe(false);
    const messages = w
      .all('.message')
      .map((m) => [m.dataset.role, m.querySelector('.content')!.textContent]);
    expect(messages).toEqual([
      ['system', 'You explain code.'],
      ['user', 'Explain: retry(fn)'],
    ]);
    expect(w.q('.thinking .content').textContent).toBe('The user wants a short answer.');
    expect(w.q('.answer .content').textContent).toBe('**What it does** Retries.');
    const facts = w
      .all('.section dl dt')
      .map((dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`);
    expect(facts).toEqual([
      'Load: 3 ms',
      'Read prompt: 220 ms, 410 tokens',
      'Write answer: 900 ms, 60 tokens',
      'Total: 1.1 s',
    ]);
    expect(w.all('.task').map((t) => t.querySelector('.task-label')!.textContent)).toEqual([
      'Read the PR description',
      'Wait for the model',
    ]);
    expect(w.all('.task .bar')[1]!.style.left).toBe(`${(60 / 1260) * 100}%`);
    button.click();
    expect(detail.hidden).toBe(true);
  });

  it('says whether the model was asked to think, and shows a reply with no thinking (PR 9.5)', () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [
        entry('c1', T0, { think: false, reply: '**What it does** Retries.' }),
        entry('c2', T0 + 1_000, { think: true, thinking: 'Short.', reply: 'Retries.' }),
      ],
      running: [],
    });
    const factsOf = (button: HTMLButtonElement) => {
      button.click();
      const detail = document.getElementById(button.getAttribute('aria-controls')!)!;
      return [...detail.querySelectorAll('dl.facts dt')].map(
        (dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`,
      );
    };
    // Newest first.
    const [on, off] = w.all('.row-button') as HTMLButtonElement[];
    expect(factsOf(off!)).toContain('Thinking: off ("think": false)');
    expect(factsOf(on!)).toContain('Thinking: on ("think": true)');
    const offDetail = document.getElementById(off!.getAttribute('aria-controls')!)!;
    expect(offDetail.querySelector('.thinking')).toBeNull();
    expect(offDetail.querySelector('.answer .content')!.textContent).toBe(
      '**What it does** Retries.',
    );
  });

  it('shows a GitHub round trip that failed, with its error', () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [
        entry('c1', T0, {
          target: 'github',
          method: 'GET',
          endpoint: 'github.com/o/r/blob/abc/src/app.ts',
          purpose: 'file at head',
          status: 'failed',
          httpStatus: 404,
          error: 'HTTP 404',
        }),
      ],
      running: [],
    });
    expect(w.q('.row').dataset.status).toBe('failed');
    expect(w.q('.trip-status').textContent).toBe('failed (404)');
    w.q<HTMLButtonElement>('.row-button').click();
    expect(w.q('.detail').textContent).toContain('ErrorHTTP 404');
    expect(w.q('.detail .messages')).toBeNull();
  });

  it('holds updates while paused and catches up on Resume', () => {
    const w = setup();
    w.port().send({ type: 'snapshot', entries: [entry('c1', T0)], running: [] });
    const pause = w.button(/Pause/);
    pause.click();
    expect(w.win.paused).toBe(true);
    expect(pause.getAttribute('aria-pressed')).toBe('true');
    expect(w.q('.status').textContent).toMatch(/Paused/);
    w.port().send({ type: 'entry', entry: entry('c2', T0 + 1_000) });
    w.port().send({ type: 'entry', entry: entry('c3', T0 + 2_000) });
    expect(w.all('.group')).toHaveLength(1);
    expect(pause.textContent).toBe('Resume (2 new)');
    pause.click();
    expect(w.win.paused).toBe(false);
    expect(pause.textContent).toBe('Pause');
    expect(w.all('.group')).toHaveLength(3);
  });

  it('Clear empties the window and the debug log', async () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [entry('c1', T0)],
      running: [runningEntry('c2:1', T0)],
    });
    w.button(/Clear/).click();
    await vi.waitFor(() => expect(w.deps.clear).toHaveBeenCalled());
    expect(w.all('.row')).toEqual([]);
    expect(w.q('.empty').hidden).toBe(false);
    await vi.waitFor(() => expect(w.q('.status').textContent).toMatch(/Cleared/));
    // Another window's Clear empties this one too.
    w.port().send({ type: 'entry', entry: entry('c3', T0) });
    w.port().send({ type: 'cleared' });
    expect(w.all('.row')).toEqual([]);
  });

  it('filters GitHub and Ollama round trips', () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [
        entry('c1', T0, { target: 'github', purpose: 'file at head' }),
        entry('c1', T0 + 10, { purpose: 'explanation' }),
        entry('warm', T0 - 5_000, { purpose: 'load the model' }, { cause: 'warmup' }),
      ],
      running: [],
    });
    const box = (name: string) => w.q<HTMLInputElement>(`input[name=${name}]`);
    expect(box('github').closest('label')!.textContent).toBe(' GitHub');
    box('ollama').click();
    expect(w.all('.purpose').map((p) => p.textContent)).toEqual(['file at head']);
    // A group with nothing left to show is hidden.
    expect(w.all('.group')).toHaveLength(1);
    box('ollama').click();
    box('github').click();
    expect(w.all('.purpose').map((p) => p.textContent)).toEqual(['explanation', 'load the model']);
  });

  it('copies what is shown as JSON', async () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [
        traceEntry('c1', T0),
        entry('c1', T0, { target: 'github', purpose: 'file at head' }),
        entry('c1', T0 + 10, { messages: [{ role: 'user', content: 'Explain "x"\n' }] }),
      ],
      running: [runningEntry('c2:1', T0 + 59_000, 'So far')],
    });
    w.q<HTMLInputElement>('input[name=github]').click();
    w.button(/Copy as JSON/).click();
    await vi.waitFor(() => expect(w.deps.copy).toHaveBeenCalled());
    const data = JSON.parse(vi.mocked(w.deps.copy).mock.calls[0]![0]);
    expect(data.groups.map((g: { group: string }) => g.group)).toEqual(['c2', 'c1']);
    expect(data.groups[0].roundTrips[0]).toMatchObject({
      status: 'running',
      reply: 'So far',
      durationMs: 1_000,
    });
    expect(data.groups[1]).toMatchObject({ where: 'src/app.ts:12', cause: 'click' });
    expect(data.groups[1].roundTrips).toHaveLength(1);
    expect(data.groups[1].roundTrips[0].messages[0].content).toBe('Explain "x"\n');
    expect(data.groups[1].tasks).toHaveLength(2);
    await vi.waitFor(() =>
      expect(w.q('.status').textContent).toBe('Copied 2 round trips in 2 groups as JSON.'),
    );
  });

  it('says so when copying fails', async () => {
    const w = setup({ copy: async () => Promise.reject(new Error('Document is not focused.')) });
    w.button(/Copy as JSON/).click();
    await vi.waitFor(() =>
      expect(w.q('.status').textContent).toBe('Could not copy: Document is not focused.'),
    );
  });

  it('keeps only the newest entries, as the log does, without dropping running rows', async () => {
    expect(WINDOW_LIMIT).toBe(DEBUG_LOG_LIMIT);
    const w = setup();
    w.port().send({ type: 'snapshot', entries: [], running: [runningEntry('live:1', T0)] });
    // Open the first row, so its open state has to be forgotten too.
    w.port().send({ type: 'entry', entry: entry('c0', T0) });
    w.q<HTMLButtonElement>('section[data-group=c0] .row-button').click();
    for (let i = 1; i <= WINDOW_LIMIT + 49; i++) {
      w.port().send({ type: 'entry', entry: entry(`c${i}`, T0 + i) });
    }
    expect(w.all('.group')).toHaveLength(WINDOW_LIMIT + 1);
    expect(w.q('section[data-group=c0]')).toBeNull();
    expect(w.q('section[data-group=c49]')).toBeNull();
    expect(w.q('section[data-group=c50]')).not.toBeNull();
    expect(w.q('section[data-group=live]')).not.toBeNull();
    w.button(/Copy as JSON/).click();
    await vi.waitFor(() => expect(w.deps.copy).toHaveBeenCalled());
    const data = JSON.parse(vi.mocked(w.deps.copy).mock.calls[0]![0]);
    expect(data.groups).toHaveLength(WINDOW_LIMIT + 1);
    expect(data.groups.some((g: { group: string }) => g.group === 'c0')).toBe(false);
  });

  it('works with the keyboard and a screen reader', () => {
    const w = setup();
    w.port().send({ type: 'snapshot', entries: [entry('c1', T0)], running: [] });
    for (const button of w.all('button')) expect(button.getAttribute('type')).toBe('button');
    expect(w.q('[role=toolbar]').getAttribute('aria-label')).toBe('Debug window controls');
    expect(w.q('.status').getAttribute('role')).toBe('status');
    expect(w.q('.status').getAttribute('aria-live')).toBe('polite');
    const section = w.q('section');
    expect(document.getElementById(section.getAttribute('aria-labelledby')!)!.tagName).toBe('H2');
    // Focus stays on a row while new round trips arrive above it.
    const rowButton = w.q<HTMLButtonElement>('.row-button');
    rowButton.focus();
    w.port().send({ type: 'entry', entry: entry('c2', T0 + 1_000) });
    w.port().send({ type: 'entry', entry: entry('c1', T0 + 500) });
    expect(document.activeElement).toBe(rowButton);
    expect(w.all('.row-button')).toHaveLength(3);
  });

  it('connects again when the service worker goes away, and starts from its log', () => {
    const w = setup();
    w.port().send({
      type: 'snapshot',
      entries: [entry('c1', T0)],
      running: [runningEntry('c2:1', T0)],
    });
    w.port().drop();
    expect(w.ports).toHaveLength(1);
    vi.advanceTimersByTime(RECONNECT_MS);
    expect(w.ports).toHaveLength(2);
    // The running round trip was lost with the old service worker.
    w.port().send({ type: 'snapshot', entries: [entry('c1', T0)], running: [] });
    expect(w.all('.row')).toHaveLength(1);
  });

  it('ignores anything that is not a debug log message, and stops on destroy', () => {
    const w = setup();
    w.port().send({ type: 'nonsense' } as never);
    expect(w.all('.row')).toEqual([]);
    w.win.destroy();
    expect(w.port().port.disconnect).toHaveBeenCalled();
    w.port().send({ type: 'entry', entry: entry('c1', T0) });
    expect(w.all('.row')).toEqual([]);
  });
});

describe('debug window helpers (PR 9.4)', () => {
  it.each([
    [0, '0 ms'],
    [849.6, '850 ms'],
    [2_340, '2.3 s'],
    [65_000, '1 min 05 s'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatMs(ms)).toBe(text);
  });

  it('splits thinking from the answer', () => {
    expect(splitThinking({ reply: '<think>hmm</think>\n\nAnswer.' })).toEqual({
      thinking: 'hmm',
      answer: 'Answer.',
    });
    // Still thinking.
    expect(splitThinking({ reply: '<think>hm' })).toEqual({ thinking: 'hm', answer: '' });
    // Thinking in its own field.
    expect(splitThinking({ reply: 'Answer.', thinking: 'hmm' })).toEqual({
      thinking: 'hmm',
      answer: 'Answer.',
    });
    expect(splitThinking({})).toEqual({ thinking: '', answer: '' });
  });
});

describe('Debug window setting in the content script (PR 9.4)', () => {
  it('uses the same key as the settings page', () => {
    expect(DEBUG_SETTING_KEY).toBe(storageKey('debugWindow'));
  });

  it('is off until read, then follows each save', async () => {
    let listener: (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => void = () => {};
    const setting = trackDebugSetting(
      { get: async () => ({ [DEBUG_SETTING_KEY]: true }) },
      { addListener: (l) => void (listener = l) },
    );
    expect(setting.current()).toBe(false);
    await vi.waitFor(() => expect(setting.current()).toBe(true));
    listener({ [DEBUG_SETTING_KEY]: { newValue: false } }, 'sync');
    expect(setting.current()).toBe(false);
    listener({ [DEBUG_SETTING_KEY]: { newValue: true } }, 'local');
    expect(setting.current()).toBe(false);
  });
});
