import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createClickHandler,
  describeRequestError,
  isInteractive,
  listenForClicks,
  PRESS_CLICK_WAIT_MS,
  ratingOf,
  type ClickHandlerDeps,
  type ExplainTiming,
} from '../src/clickHandler';
import { locateLine } from '../src/diffDom';
import { createPrefetcher, hoveredLine } from '../src/prefetch';
import type { ExplainResult } from '../src/explain/explainHandler';
import { RequestError } from '../src/messaging/client';
import {
  currentPopup,
  openPopup,
  POPUP_ID,
  type Popup,
  type PopupAnchor,
  type TraceDetails,
} from '../src/popup/popup';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'Marks 2.4 as done.', why: 'It merged.', concerns: 'None found.' },
  model: 'qwen2.5-coder:7b',
};

/** A promise plus the functions that settle it, so a test decides when the model answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PopupHooks = Parameters<ClickHandlerDeps['openPopup']>[1];

/**
 * A popup that records what it was asked to show. Like the real one, it
 * ignores updates once stopped or closed. `pressStop` acts like its Stop button.
 */
function fakePopup(anchor: PopupAnchor, hooks: PopupHooks) {
  const calls: string[] = [];
  const traces: TraceDetails[] = [];
  let state: Popup['state'] = 'loading';
  const finished = () => state === 'closed' || state === 'stopped';
  const popup: Popup & {
    anchor: PopupAnchor;
    hooks: PopupHooks;
    calls: string[];
    traces: TraceDetails[];
    pressStop(): void;
    pressRegenerate(): void;
  } = {
    anchor,
    hooks,
    calls,
    host: document.createElement('div'),
    elapsedMs: 1234,
    pinned: false,
    get state() {
      return state;
    },
    showLoading: () => calls.push('loading'),
    showPrompt: (report) => calls.push(`prompt:${report.tokens}`),
    traces,
    showTrace: (trace) => {
      traces.push(trace);
      if (trace.timings) calls.push(`timings:${trace.timings.totalMs}`);
    },
    showPartial: (markdown) => {
      if (state !== 'loading' && state !== 'streaming') return;
      state = 'streaming';
      calls.push(`partial:${markdown}`);
    },
    showExplanation: (explanation, model, cached) => {
      if (finished()) return;
      state = 'done';
      calls.push(
        `done:${model}:${explanation.what}${cached ? ` (cached ${cached.elapsedMs})` : ''}`,
      );
    },
    showError: (message, fix) => {
      if (finished()) return;
      state = 'failed';
      calls.push(`failed:${message}|${fix}`);
    },
    close: () => {
      if (state === 'closed') return;
      state = 'closed';
      hooks.onClose();
    },
    pressStop: () => {
      state = 'stopped';
      hooks.onStop();
    },
    // Like the real Regenerate button: back to loading, then the hook.
    pressRegenerate: () => {
      state = 'loading';
      calls.push('loading');
      hooks.onRegenerate();
    },
  };
  return popup;
}

/** What a test's `explain` gets: the chunk callback, to stream text into the popup. */
type Answer = (onChunk: (text: string) => void, fresh: boolean) => Promise<ExplainResult>;

/** A GitHub round trip a click waited on (PR 9.3). */
const GITHUB_TRIP = {
  target: 'github' as const,
  method: 'GET',
  endpoint: 'github.com/o/r/blob/main/a.ts',
  purpose: 'file at head',
  cause: 'click' as const,
  startMs: 2,
  durationMs: 30,
  status: 'done' as const,
  bytesSent: 0,
  bytesReceived: 100,
};

function setup(answer: Answer = () => Promise.resolve(DONE), isEnabled?: () => boolean) {
  const contexts: string[] = [];
  const timings: ExplainTiming[] = [];
  // The click's tasks and reply (PR 9.1), kept apart so the timing checks stay short.
  const traced: Pick<ExplainTiming, 'tasks' | 'reply'>[] = [];
  // What each answer hands to the debug log (PR 9.3).
  const debugs: ExplainTiming['debug'][] = [];
  const popups: ReturnType<typeof fakePopup>[] = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const deps: ClickHandlerDeps = {
    isEnabled,
    explain: vi.fn(
      (context: string, onChunk: (text: string) => void, { fresh }: { fresh: boolean }) => {
        contexts.push(context);
        const stop = vi.fn();
        stops.push(stop);
        return { result: answer(onChunk, fresh), stop };
      },
    ),
    openPopup: (anchor, hooks) => {
      popups.at(-1)?.close();
      const popup = fakePopup(anchor, hooks);
      popups.push(popup);
      return popup;
    },
    onTiming: ({ tasks, reply, debug, ...timing }) => {
      timings.push(timing);
      traced.push({ tasks, reply });
      debugs.push(debug);
    },
  };
  const handler = createClickHandler(deps);
  const remove = listenForClicks(handler);
  return { deps, contexts, popups, stops, timings, traced, debugs, cleanup: remove };
}

function click(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...init }));
}

/** A pointer event from the mouse, as Chrome sends it (PR 11.1). */
function pointer(type: string, target: Element, init: PointerEventInit = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerType: 'mouse',
      isPrimary: true,
      // The main button is down from the press until the release.
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: 100,
      clientY: 200,
      ...init,
    }),
  );
}

/** Mouse down and up on `target` and the click that follows, like a real click. */
function pressAndClick(target: Element, init: MouseEventInit = {}): void {
  pointer('pointerdown', target, init);
  pointer('pointerup', target, init);
  click(target, init);
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const layouts = [
  {
    name: 'classic',
    file: 'github-diff-classic.html',
    code: (id: string) =>
      document.getElementById(`${ANCHOR}${id}`)!.closest('tr')!.querySelector('.blob-code-inner')!,
    headerRow: () => document.querySelector('td.blob-code-hunk')!.closest('tr')!,
  },
  {
    name: 'new (React)',
    file: 'github-diff-new.html',
    code: (id: string) =>
      document.querySelector(`td[data-line-anchor="${ANCHOR}${id}"] .diff-text-inner`)!,
    headerRow: () => document.querySelector('td.diff-hunk-cell')!.closest('tr')!,
  },
];

describe.each(layouts)('click handler on the $name layout', ({ file, code, headerRow }) => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  afterEach(() => {
    env?.cleanup();
    document.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('does nothing while click-to-explain is off, and works again once it is on', async () => {
    let enabled = false;
    env = setup(undefined, () => enabled);
    click(code('R44'));
    expect(env.deps.explain).not.toHaveBeenCalled();
    expect(env.popups).toHaveLength(0);

    enabled = true;
    click(code('R44'));
    await flush();
    expect(env.deps.explain).toHaveBeenCalledTimes(1);
    expect(env.popups[0]!.calls).toEqual([`done:${DONE.model}:${DONE.explanation.what}`]);
  });

  it('shows the prompt under the explanation when the result has one (PR 6.2)', async () => {
    const prompt = { text: 'p', tokens: 42, budget: 100, contextTokens: 2048, trimmed: [] };
    env = setup(() => Promise.resolve({ ...DONE, prompt }));
    click(code('R44'));
    await flush();
    expect(env.popups[0]!.calls).toEqual([
      `done:${DONE.model}:${DONE.explanation.what}`,
      'prompt:42',
    ]);
  });

  it('opens a popup next to the clicked row and shows the explanation', async () => {
    env = setup();
    const line = code('R44');
    click(line);
    expect(env.deps.explain).toHaveBeenCalledTimes(1);
    expect(env.contexts[0]).toContain('✅ Done ([#10]');
    expect(env.contexts[0]).toContain('@@ -41,7 +41,7 @@');
    expect(env.popups).toHaveLength(1);
    expect(env.popups[0]!.anchor).toBe(line.closest('tr'));
    await flush();
    expect(env.popups[0]!.calls).toEqual(['done:qwen2.5-coder:7b:Marks 2.4 as done.']);
    expect(env.timings).toEqual([{ elapsedMs: 1234, status: 'done', model: 'qwen2.5-coder:7b' }]);
  });

  it('shows where the time went and logs it, for an answer from the model (PR 8.1)', async () => {
    const timings = { totalMs: 900, answerTokens: 20, answerMs: 800 };
    env = setup(() => Promise.resolve({ ...DONE, timings }));
    click(code('R44'));
    await flush();
    expect(env.popups[0]!.calls).toEqual([
      'done:qwen2.5-coder:7b:Marks 2.4 as done.',
      'timings:900',
    ]);
    expect(env.timings).toEqual([
      { elapsedMs: 1234, status: 'done', model: 'qwen2.5-coder:7b', timings },
    ]);
  });

  it("records the click's tasks, adds the service worker's, and shows them in Details (PR 9.1)", async () => {
    const timings = { totalMs: 900, answerTokens: 20, answerMs: 800 };
    const worker = {
      totalMs: 950,
      tasks: [
        {
          key: 'settings',
          label: 'Read settings',
          source: 'worker' as const,
          startMs: 0,
          durationMs: 2,
        },
        {
          key: 'model',
          label: 'Wait for the model',
          source: 'worker' as const,
          startMs: 10,
          durationMs: 930,
          firstChunkMs: 100,
        },
      ],
    };
    // A clock that moves 1 s each time it is read, so the page's tasks take
    // longer than the fake service worker's.
    let time = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (time += 1000));
    onTestFinished(() => clock.mockRestore());
    env = setup();
    // Like content.ts: the page's own tasks, then the request is sent.
    vi.mocked(env.deps.explain).mockImplementationOnce((_context, onChunk, { trace }) => {
      trace!.time('pr-description', 'Read the PR description', Promise.resolve());
      trace!.markSent();
      const result = Promise.resolve().then(() => {
        onChunk('<think>hmm</think>');
        onChunk('## What it does\nMarks it.');
        return { ...DONE, timings, trace: worker };
      });
      return { result, stop: vi.fn() };
    });
    click(code('R44'));
    await flush();
    const [shown] = env.popups[0]!.traces;
    expect(shown!.timings).toBe(timings);
    expect(shown!.reply).toBe('<think>hmm</think>## What it does\nMarks it.');
    expect(shown!.tasks.map((t) => t.key)).toEqual([
      'find-code',
      'pr-description',
      'settings',
      'model',
      'show',
    ]);
    expect(shown!.tasks[0]).toMatchObject({ source: 'page', label: 'Find the code' });
    expect(shown!.tasks.find((t) => t.key === 'model')).toMatchObject({ firstChunkMs: 100 });
    // The console gets the same tasks and the reply.
    expect(env.traced[0]).toEqual({ tasks: shown!.tasks, reply: shown!.reply });
  });

  it("hands the debug log the click's id, time, place and round trips (PR 9.3)", async () => {
    env = setup();
    const trip = {
      target: 'github' as const,
      method: 'GET',
      endpoint: 'github.com/o/r/raw/main/a.ts',
      purpose: 'file at head',
      cause: 'click' as const,
      startMs: 2,
      durationMs: 30,
      status: 'done' as const,
      bytesSent: 0,
      bytesReceived: 100,
    };
    let sentId: string | undefined;
    vi.mocked(env.deps.explain).mockImplementationOnce((_context, _onChunk, { trace }) => {
      sentId = trace!.id;
      trace!.addRoundTrips([trip]);
      return { result: Promise.resolve(DONE), stop: vi.fn() };
    });
    const before = Date.now();
    click(code('R44'));
    await flush();
    const [debug] = env.debugs;
    expect(debug).toMatchObject({ group: sentId, roundTrips: [trip] });
    expect(debug!.where).toMatch(/:44$/);
    expect(debug!.at).toBeGreaterThanOrEqual(before);
    expect(debug!.at).toBeLessThanOrEqual(Date.now());
  });

  it('shows the short trace of a cached answer, with no model task', async () => {
    const worker = {
      totalMs: 5,
      tasks: [
        {
          key: 'cache',
          label: 'Check the cache',
          source: 'worker' as const,
          startMs: 1,
          durationMs: 3,
        },
      ],
    };
    env = setup(() =>
      Promise.resolve({ ...DONE, cached: { elapsedMs: 9800, savedAt: 1 }, trace: worker }),
    );
    click(code('R44'));
    await flush();
    const keys = env.popups[0]!.traces[0]!.tasks.map((t) => t.key);
    expect(keys.sort()).toEqual(['cache', 'find-code', 'show']);
    expect(env.popups[0]!.traces[0]!.timings).toBeUndefined();
  });

  it('shows the trace of a failed request too: a failed model call and a prompt too large', async () => {
    const failedTask = (key: string, durationMs: number) => ({
      key,
      label: key,
      source: 'worker' as const,
      startMs: 0,
      durationMs,
      status: 'failed' as const,
    });
    for (const [key, durationMs] of [
      ['model', 30_000],
      ['fit-prompt', 3],
    ] as const) {
      env?.cleanup();
      document.body.innerHTML = fixture(file);
      env = setup(() =>
        Promise.resolve({
          status: 'failed',
          message: 'Failed.',
          fix: 'Fix it.',
          trace: { totalMs: durationMs, tasks: [failedTask(key, durationMs)] },
        }),
      );
      click(code('R44'));
      await flush();
      expect(env.popups[0]!.calls).toEqual(['failed:Failed.|Fix it.']);
      const shown = env.popups[0]!.traces[0]!;
      expect(shown.timings).toBeUndefined();
      expect(shown.tasks.find((t) => t.key === key)).toMatchObject({ status: 'failed' });
      expect(env.traced[0]!.tasks).toEqual(shown.tasks);
    }
  });

  it('shows the error message and fix when the model fails', async () => {
    env = setup(() =>
      Promise.resolve({ status: 'failed', message: 'Ollama is not running.', fix: 'Start it.' }),
    );
    click(code('R44'));
    await flush();
    expect(env.popups[0]!.calls).toEqual(['failed:Ollama is not running.|Start it.']);
    expect(env.timings).toEqual([{ elapsedMs: 1234, status: 'failed', model: undefined }]);
  });

  it('shows a friendly error when the service worker cannot answer', async () => {
    env = setup(() => Promise.reject(new RequestError('"explain" timed out', 'TimeoutError')));
    click(code('R44'));
    await flush();
    expect(env.popups[0]!.calls[0]).toMatch(/^failed:The model took too long/);
    expect(env.timings).toEqual([{ elapsedMs: 1234, status: 'failed' }]);
  });

  it("still hands the debug log the click's trace and GitHub round trips when the request fails (PR 9.3)", async () => {
    env = setup();
    let sentId: string | undefined;
    vi.mocked(env.deps.explain).mockImplementationOnce((_context, _onChunk, { trace }) => {
      sentId = trace!.id;
      trace!.pageRoundTrips(() => [GITHUB_TRIP]);
      void trace!.time('send', 'Send the request', new Promise(() => {}));
      return { result: Promise.reject(new Error('port closed')), stop: vi.fn() };
    });
    click(code('R44'));
    await flush();
    expect(env.timings).toEqual([{ elapsedMs: 1234, status: 'failed' }]);
    expect(env.debugs[0]).toMatchObject({ group: sentId, roundTrips: [GITHUB_TRIP] });
    expect(env.debugs[0]!.where).toMatch(/:44$/);
    const tasks = env.traced[0]!.tasks!;
    expect(tasks.map((t) => [t.key, t.status])).toEqual([
      ['find-code', undefined],
      ['send', 'failed'],
    ]);
  });

  it('ignores hunk headers and clicks outside a diff', () => {
    env = setup();
    click(headerRow());
    click(document.body);
    expect(env.deps.explain).not.toHaveBeenCalled();
    expect(env.popups).toHaveLength(0);
  });

  it("ignores GitHub's comment button, links, and menus inside a diff line", () => {
    env = setup();
    const cell = code('R44').closest('td')!;
    const button = document.createElement('button');
    button.className = 'add-line-comment';
    const icon = document.createElement('span');
    button.append(icon);
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'link';
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menuitem');
    cell.append(button, link, menu);

    click(button);
    click(icon);
    click(link);
    click(menu);
    expect(env.deps.explain).not.toHaveBeenCalled();
  });

  it('ignores modified clicks and clicks that end a text selection', () => {
    env = setup();
    const line = code('R44');
    click(line, { shiftKey: true });
    click(line, { ctrlKey: true });
    click(line, { metaKey: true });
    click(line, { altKey: true });

    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection()!.addRange(range);
    click(line);
    expect(env.deps.explain).not.toHaveBeenCalled();
  });

  it('replaces a pending popup when another line is clicked, and drops the late answer', async () => {
    const first = deferred<ExplainResult>();
    const second = deferred<ExplainResult>();
    const answers = [first.promise, second.promise];
    env = setup(() => answers.shift()!);

    click(code('R44'));
    click(code('R45'));
    expect(env.popups).toHaveLength(2);
    expect(env.popups[0]!.state).toBe('closed');

    second.resolve(DONE);
    first.resolve({ ...DONE, model: 'old' });
    await flush();
    expect(env.popups[0]!.calls).toEqual([]);
    expect(env.popups[1]!.calls).toEqual(['done:qwen2.5-coder:7b:Marks 2.4 as done.']);
    // Only the answer that was shown is timed.
    expect(env.timings).toHaveLength(1);
    // Replacing the popup stopped the first request only.
    expect(env.stops[0]).toHaveBeenCalled();
    expect(env.stops[1]).not.toHaveBeenCalled();
  });

  it('shows the reply growing as it streams, then the sections', async () => {
    const answer = deferred<ExplainResult>();
    let send!: (text: string) => void;
    env = setup((onChunk) => {
      send = onChunk;
      return answer.promise;
    });
    click(code('R44'));
    send('## What it');
    send(' does\nMarks');
    answer.resolve(DONE);
    await flush();
    expect(env.popups[0]!.calls).toEqual([
      'partial:## What it',
      'partial:## What it does\nMarks',
      `done:${DONE.model}:${DONE.explanation.what}`,
    ]);
    expect(env.timings).toEqual([
      { elapsedMs: 1234, status: 'done', model: DONE.model, firstChunkMs: 1234 },
    ]);
  });

  it("Stop hands the debug log the click's GitHub round trips, with running tasks marked stopped (PR 9.3)", async () => {
    env = setup();
    let sentId: string | undefined;
    vi.mocked(env.deps.explain).mockImplementationOnce((_context, _onChunk, { trace }) => {
      sentId = trace!.id;
      // Stopped while the file is still being fetched, before the request was sent.
      trace!.pageRoundTrips(() => [{ ...GITHUB_TRIP, status: 'running' }]);
      void trace!.time('file-at-head', 'Fetch the file at head', new Promise(() => {}));
      return { result: new Promise<ExplainResult>(() => {}), stop: vi.fn() };
    });
    click(code('R44'));
    env.popups[0]!.pressStop();
    expect(env.timings).toEqual([{ elapsedMs: 1234, status: 'stopped' }]);
    expect(env.debugs[0]).toMatchObject({
      group: sentId,
      roundTrips: [{ ...GITHUB_TRIP, status: 'running' }],
    });
    expect(env.traced[0]!.tasks!.find((t) => t.key === 'file-at-head')).toMatchObject({
      status: 'stopped',
    });
  });

  it('Stop stops the request, keeps the text so far, and ignores what arrives later', async () => {
    const answer = deferred<ExplainResult>();
    let send!: (text: string) => void;
    env = setup((onChunk) => {
      send = onChunk;
      return answer.promise;
    });
    click(code('R44'));
    send('Marks 2.4');
    env.popups[0]!.pressStop();
    expect(env.stops[0]).toHaveBeenCalledOnce();
    expect(env.timings).toEqual([{ elapsedMs: 1234, status: 'stopped', firstChunkMs: 1234 }]);

    // The debug log still gets the click so far, its running tasks marked stopped (PR 9.3).
    expect(env.debugs[0]).toMatchObject({ group: expect.any(String), roundTrips: [] });
    expect(env.traced[0]!.tasks!.map((t) => t.key)).toContain('find-code');

    send(' as done.');
    answer.resolve(DONE);
    await flush();
    expect(env.popups[0]!.calls).toEqual(['partial:Marks 2.4']);
    expect(env.popups[0]!.state).toBe('stopped');
    expect(env.timings).toHaveLength(1);
  });

  it('asks for a cached answer first and says when it came from the cache', async () => {
    env = setup(() => Promise.resolve({ ...DONE, cached: { elapsedMs: 9800, savedAt: 1 } }));
    click(code('R44'));
    expect(env.deps.explain).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      fresh: false,
      code: expect.objectContaining({ filePath: 'docs/roadmap.md', startLine: 44, endLine: 44 }),
      trace: expect.any(Object),
    });
    await flush();
    expect(env.popups[0]!.calls).toEqual([
      `done:${DONE.model}:${DONE.explanation.what} (cached 9800)`,
    ]);
    expect(env.timings).toEqual([
      { elapsedMs: 1234, status: 'done', model: DONE.model, cached: true },
    ]);
  });

  it('says where the clicked line is in the new file, but not for a removed line (PR 6.3)', () => {
    env = setup();
    click(code('R44'));
    expect(vi.mocked(env.deps.explain).mock.calls[0]![2].code).toEqual({
      filePath: 'docs/roadmap.md',
      startLine: 44,
      endLine: 44,
      text: '| 2.4 | Friendly LLM error messages | Small | ✅ Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)) |',
    });
    click(code('L44'));
    expect(vi.mocked(env.deps.explain).mock.calls[1]![2]).toEqual({
      fresh: false,
      trace: expect.any(Object),
    });
  });

  it('Regenerate asks again without the cache and shows the new answer', async () => {
    const second = deferred<ExplainResult>();
    let send!: (text: string) => void;
    env = setup((onChunk, fresh) => {
      if (!fresh) return Promise.resolve({ ...DONE, cached: { elapsedMs: 9800, savedAt: 1 } });
      send = onChunk;
      return second.promise;
    });
    click(code('R44'));
    await flush();
    env.popups[0]!.pressRegenerate();
    expect(env.deps.explain).toHaveBeenCalledTimes(2);
    expect(vi.mocked(env.deps.explain).mock.calls[1]![2]).toEqual({
      fresh: true,
      code: vi.mocked(env.deps.explain).mock.calls[0]![2].code,
      trace: expect.any(Object),
    });
    // Regenerate starts a new trace (PR 9.1).
    expect(vi.mocked(env.deps.explain).mock.calls[1]![2].trace).not.toBe(
      vi.mocked(env.deps.explain).mock.calls[0]![2].trace,
    );
    expect(env.contexts[1]).toBe(env.contexts[0]);
    expect(env.stops[0]).toHaveBeenCalledOnce();

    send('New');
    second.resolve({ ...DONE, explanation: { ...DONE.explanation, what: 'New answer.' } });
    await flush();
    expect(env.popups[0]!.calls).toEqual([
      `done:${DONE.model}:${DONE.explanation.what} (cached 9800)`,
      'loading',
      'partial:New',
      `done:${DONE.model}:New answer.`,
    ]);
    expect(env.timings[1]).toEqual({
      elapsedMs: 1234,
      status: 'done',
      model: DONE.model,
      firstChunkMs: 1234,
    });
  });

  it('Regenerate after Stop ignores what the stopped request sends later', async () => {
    const first = deferred<ExplainResult>();
    const second = deferred<ExplainResult>();
    const senders: Array<(text: string) => void> = [];
    env = setup((onChunk, fresh) => {
      senders.push(onChunk);
      return fresh ? second.promise : first.promise;
    });
    click(code('R44'));
    senders[0]!('Old');
    env.popups[0]!.pressStop();
    env.popups[0]!.pressRegenerate();
    senders[0]!(' text');
    first.resolve(DONE);
    await flush();
    expect(env.popups[0]!.state).toBe('loading');
    second.resolve({ ...DONE, explanation: { ...DONE.explanation, what: 'Fresh.' } });
    await flush();
    expect(env.popups[0]!.calls.at(-1)).toBe(`done:${DONE.model}:Fresh.`);
  });

  it('Ask a question opens the chat with the code, the explanation, and the line', async () => {
    env = setup();
    const openChat = vi.fn();
    click(code('R44'));
    expect(env.popups[0]!.hooks.onAsk).toBeUndefined();

    env.deps.openChat = openChat;
    click(code('R44'));
    await flush();
    env.popups[1]!.hooks.onAsk!();
    expect(openChat).toHaveBeenCalledWith({
      context: env.contexts[1],
      explanation: DONE.explanation,
      subject: {
        filePath: 'docs/roadmap.md',
        startLine: 44,
        code: [{ lineNumber: 44, text: expect.stringContaining('Friendly LLM error messages') }],
      },
      regenerated: false,
      // The clicked row, for the chat to point at (PR 11.14).
      anchor: env.popups[1]!.anchor,
    });
    expect(openChat.mock.calls[0]![0].anchor.getBoundingClientRect().right).toBeDefined();

    // After Regenerate the chat is marked to start over, even with the same text.
    env.popups[1]!.pressRegenerate();
    await flush();
    env.popups[1]!.hooks.onAsk!();
    expect(openChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ explanation: DONE.explanation, regenerated: true }),
    );
  });

  it('opens the popup with the facts known without the model, before any answer (PR 9.12)', () => {
    env = setup(() => new Promise(() => {}));
    click(code('R44'));
    expect(env.popups[0]!.hooks.facts).toEqual({
      where: 'docs/roadmap.md, line 44',
      scope: "Update this table (and the PR's heading) when a roadmap PR merges.",
      change: 'Changed line, was:',
      was: '| 2.4 | Friendly LLM error messages | Small | Not started |',
    });
    click(code('L44'));
    expect(env.popups[1]!.hooks.facts).toEqual(
      expect.objectContaining({
        where: 'docs/roadmap.md, line 44 of the old file',
        change: 'Removed line',
      }),
    );
    // The request text sent to the model is unchanged by the facts.
    expect(env.contexts[0]).not.toContain('Changed line');
  });

  it('while a chat is open, a clicked line goes to the chat instead of a popup (PR 5.4)', () => {
    env = setup();
    let chatOpen = true;
    const addToChat = vi.fn(() => chatOpen);
    env.deps.addToChat = addToChat;
    click(code('R44'));
    expect(addToChat).toHaveBeenCalledWith(
      {
        text: expect.stringContaining('docs/roadmap.md'),
        subject: {
          filePath: 'docs/roadmap.md',
          startLine: 44,
          code: [{ lineNumber: 44, text: expect.stringContaining('Friendly LLM error messages') }],
        },
        code: expect.objectContaining({ startLine: 44, endLine: 44 }),
        facts: expect.objectContaining({ where: 'docs/roadmap.md, line 44' }),
      },
      // The clicked row, for the chat's pointer (PR 11.14).
      expect.objectContaining({ getBoundingClientRect: expect.any(Function) }),
    );
    expect(env.deps.explain).not.toHaveBeenCalled();
    expect(env.popups).toEqual([]);

    // Once the chat is closed, clicks explain in the popup again.
    chatOpen = false;
    click(code('R44'));
    expect(env.deps.explain).toHaveBeenCalledTimes(1);
    expect(env.popups).toHaveLength(1);
  });

  it('Ask a question does nothing until there is an explanation', () => {
    env = setup(() => new Promise(() => {}));
    env.deps.openChat = vi.fn();
    click(code('R44'));
    env.popups[0]!.hooks.onAsk!();
    expect(env.deps.openChat).not.toHaveBeenCalled();
  });

  it('closing the popup stops the request', async () => {
    const answer = deferred<ExplainResult>();
    env = setup(() => answer.promise);
    click(code('R44'));
    env.popups[0]!.close();
    expect(env.stops[0]).toHaveBeenCalledOnce();
    answer.resolve(DONE);
    await flush();
    expect(env.popups[0]!.calls).toEqual([]);
    expect(env.timings).toEqual([]);
  });

  describe('starting the request when the mouse goes down (PR 11.1)', () => {
    it('sends the request on the press, and the click opens the popup on that same request', async () => {
      const answer = deferred<ExplainResult>();
      let send!: (text: string) => void;
      env = setup((onChunk) => {
        send = onChunk;
        return answer.promise;
      });
      const line = code('R44');
      pointer('pointerdown', line);
      expect(env.deps.explain).toHaveBeenCalledTimes(1);
      expect(env.contexts[0]).toContain('@@ -41,7 +41,7 @@');
      expect(env.popups).toHaveLength(0);
      // The model writes while the button is still down.
      send('## What it does\nMarks');
      pointer('pointerup', line);
      click(line);
      expect(env.popups).toHaveLength(1);
      expect(env.popups[0]!.anchor).toBe(line.closest('tr'));
      await flush();
      expect(env.popups[0]!.calls).toEqual(['partial:## What it does\nMarks']);
      send(' 2.4 as done.');
      answer.resolve(DONE);
      await flush();
      // One request, not two.
      expect(env.deps.explain).toHaveBeenCalledTimes(1);
      expect(env.stops[0]).not.toHaveBeenCalled();
      expect(env.popups[0]!.calls).toEqual([
        'partial:## What it does\nMarks',
        'partial:## What it does\nMarks 2.4 as done.',
        `done:${DONE.model}:${DONE.explanation.what}`,
      ]);
    });

    it('shows an answer that came in full before the click', async () => {
      env = setup((onChunk) => {
        onChunk('## What it does');
        return Promise.resolve(DONE);
      });
      pointer('pointerdown', code('R44'));
      await flush();
      pointer('pointerup', code('R44'));
      click(code('R44'));
      await flush();
      expect(env.deps.explain).toHaveBeenCalledTimes(1);
      expect(env.popups[0]!.calls).toEqual([
        'partial:## What it does',
        `done:${DONE.model}:${DONE.explanation.what}`,
      ]);
    });

    it('opens a cached line from the cache', async () => {
      const cached = { ...DONE, cached: { elapsedMs: 3, savedAt: 1 } };
      env = setup(() => Promise.resolve(cached));
      pressAndClick(code('R44'));
      await flush();
      expect(env.deps.explain).toHaveBeenCalledOnce();
      expect(env.deps.explain).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
        fresh: false,
        code: expect.objectContaining({ startLine: 44 }),
        trace: expect.anything(),
      });
      expect(env.popups[0]!.calls).toEqual([
        `done:${DONE.model}:${DONE.explanation.what} (cached 3)`,
      ]);
    });

    it('cancels the request on a drag past 4 pixels, but not on a small wobble', () => {
      env = setup(() => new Promise(() => {}));
      const line = code('R44');
      pointer('pointerdown', line);
      pointer('pointermove', line, { clientX: 103, clientY: 202 });
      expect(env.stops[0]).not.toHaveBeenCalled();
      pointer('pointermove', line, { clientX: 100, clientY: 205 });
      expect(env.stops[0]).toHaveBeenCalledOnce();
      // The browser sends no click after a drag that selected text.
      pointer('pointerup', line, { clientX: 100, clientY: 205 });
      expect(env.popups).toHaveLength(0);
      expect(env.deps.explain).toHaveBeenCalledOnce();
    });

    it('cancels the request when the button is released somewhere else', () => {
      env = setup(() => new Promise(() => {}));
      pointer('pointerdown', code('R44'));
      pointer('pointerup', code('R45'), { clientX: 101 });
      expect(env.stops[0]).toHaveBeenCalledOnce();
      expect(env.popups).toHaveLength(0);
    });

    it('cancels the request when the click is left alone, such as one that ends a text selection', () => {
      env = setup(() => new Promise(() => {}));
      const line = code('R44');
      pointer('pointerdown', line);
      pointer('pointerup', line);
      const range = document.createRange();
      range.selectNodeContents(line);
      document.getSelection()!.addRange(range);
      click(line);
      expect(env.stops[0]).toHaveBeenCalledOnce();
      expect(env.popups).toHaveLength(0);
    });

    it('cancels the request when the button is released outside the page', () => {
      env = setup(() => new Promise(() => {}));
      const line = code('R44');
      // The pointer leaves the page with the button held.
      pointer('pointerdown', line);
      document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
      expect(env.stops[0]).toHaveBeenCalledOnce();
      // The window loses focus, as when the release lands in another window.
      pointer('pointerdown', line);
      window.dispatchEvent(new FocusEvent('blur'));
      expect(env.stops[1]).toHaveBeenCalledOnce();
      // The pointer comes back with the button up and no release seen.
      pointer('pointerdown', line);
      pointer('pointermove', line, { buttons: 0 });
      expect(env.stops[2]).toHaveBeenCalledOnce();
      expect(env.popups).toHaveLength(0);
    });

    it('takes its listeners off when removed, and cancels a pending press', () => {
      env = setup(() => new Promise(() => {}));
      pointer('pointerdown', code('R44'));
      env.cleanup();
      expect(env.stops[0]).toHaveBeenCalledOnce();
      pointer('pointerdown', code('R44'));
      window.dispatchEvent(new FocusEvent('blur'));
      click(code('R44'));
      expect(env.deps.explain).toHaveBeenCalledOnce();
    });

    it('cancels the request if no click comes after the release', () => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      env = setup(() => new Promise(() => {}));
      pointer('pointerdown', code('R44'));
      pointer('pointerup', code('R44'));
      vi.advanceTimersByTime(PRESS_CLICK_WAIT_MS - 1);
      expect(env.stops[0]).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(env.stops[0]).toHaveBeenCalledOnce();
    });

    it('a new press on another line cancels the first', () => {
      env = setup(() => new Promise(() => {}));
      pointer('pointerdown', code('R44'));
      pointer('pointercancel', code('R44'));
      expect(env.stops[0]).toHaveBeenCalledOnce();
      pointer('pointerdown', code('R45'));
      pointer('pointerdown', code('R44'));
      expect(env.stops[1]).toHaveBeenCalledOnce();
      expect(env.deps.explain).toHaveBeenCalledTimes(3);
    });

    it('sends nothing for the right button, modifier keys, controls, a press while turned off, or while the chat is open', () => {
      let enabled = false;
      env = setup(undefined, () => enabled);
      pointer('pointerdown', code('R44'));
      enabled = true;
      pointer('pointerdown', code('R44'), { button: 2 });
      for (const key of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
        pointer('pointerdown', code('R44'), { [key]: true });
      }
      pointer('pointerdown', headerRow());
      env.deps.isChatOpen = () => true;
      pointer('pointerdown', code('R44'));
      expect(env.deps.explain).not.toHaveBeenCalled();
    });

    it('a click on another line than the pressed one cancels the press and explains the clicked line', () => {
      env = setup(() => new Promise(() => {}));
      pointer('pointerdown', code('R44'));
      // No pointerup: a click with no matching release, as from a script.
      click(code('R45'));
      expect(env.stops[0]).toHaveBeenCalledOnce();
      expect(env.deps.explain).toHaveBeenCalledTimes(2);
      expect(env.popups[0]!.anchor).toBe(code('R45').closest('tr'));
    });

    it('Regenerate after a pressed click asks again without the cache', async () => {
      env = setup((_onChunk, fresh) => Promise.resolve(fresh ? { ...DONE, model: 'fresh' } : DONE));
      pressAndClick(code('R44'));
      await flush();
      env.popups[0]!.pressRegenerate();
      await flush();
      expect(env.deps.explain).toHaveBeenCalledTimes(2);
      expect(env.popups[0]!.calls.at(-1)).toBe(`done:fresh:${DONE.explanation.what}`);
    });

    it('records Pressed before Clicked in the trace, so Details shows how much earlier it started', async () => {
      let time = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
      onTestFinished(() => clock.mockRestore());
      env = setup();
      const line = code('R44');
      pointer('pointerdown', line);
      time = 150;
      pointer('pointerup', line);
      click(line);
      await flush();
      const tasks = env.traced[0]!.tasks!;
      const row = (key: string) => tasks.find((t) => t.key === key);
      expect(row('press')).toMatchObject({ label: 'Pressed', startMs: 0, durationMs: 150 });
      expect(row('find-code')).toMatchObject({ startMs: 0 });
      expect(row('click')).toMatchObject({ label: 'Clicked', startMs: 150, durationMs: 0 });
      expect(tasks.map((t) => t.key).indexOf('press')).toBeLessThan(
        tasks.map((t) => t.key).indexOf('click'),
      );
    });

    it('joins a running hover prefetch of the same line instead of stopping it', () => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      env = setup(() => new Promise(() => {}));
      const worker = env.deps.explain;
      const prefetcher = createPrefetcher({ explain: worker, isOn: () => true, delayMs: 300 });
      env.deps.explain = prefetcher.explain;
      const line = code('R44');
      document.addEventListener('mouseover', prefetcher.onMouseOver);
      onTestFinished(() => document.removeEventListener('mouseover', prefetcher.onMouseOver));
      line.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(300);
      expect(prefetcher.running()).toBe(hoveredLine(line)!.key);
      pointer('pointerdown', line);
      // The press sends the same text, for the service worker to join to the prefetch.
      expect(worker).toHaveBeenCalledTimes(2);
      expect(env.contexts[1]).toBe(env.contexts[0]);
      expect(env.stops[0]).not.toHaveBeenCalled();
      expect(prefetcher.running()).toBe(hoveredLine(line)!.key);
    });
  });
});

describe.each([
  { name: 'classic', file: 'github-diff-classic-split.html' },
  { name: 'new (React)', file: 'github-diff-new-split.html' },
])('press then click in split view on the $name layout (PR 11.1)', ({ file }) => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  afterEach(() => {
    env?.cleanup();
    document.body.innerHTML = '';
  });

  // A changed row: removed line 46 on the left, added line 48 on the right.
  const changedRow = () =>
    [...document.querySelectorAll('tbody tr')].find((r) => {
      const line = r.children.length === 4 ? locateLine(r.children[1]!) : null;
      return line?.lineNumber === 46 && line.side === 'removed';
    })!;
  const left = () => changedRow().children[1]!;
  const right = () => changedRow().children[3]!;

  it("does not hand the left line's request to a click on the right of the same row", async () => {
    env = setup(() => Promise.resolve(DONE));
    expect(locateLine(left())).toMatchObject({ side: 'removed', lineNumber: 46 });
    expect(locateLine(right())).toMatchObject({ side: 'added', lineNumber: 48 });
    pointer('pointerdown', left());
    pointer('pointerup', right());
    expect(env.stops[0]).toHaveBeenCalledOnce();
    click(right());
    await flush();
    // The right line is explained with its own request.
    expect(env.deps.explain).toHaveBeenCalledTimes(2);
    expect(env.contexts[1]).not.toBe(env.contexts[0]);
    expect(env.deps.explain).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ code: expect.objectContaining({ startLine: 48 }) }),
    );
    expect(env.popups).toHaveLength(1);
  });

  it('a click with no release seen still explains the clicked side', () => {
    env = setup(() => new Promise(() => {}));
    pointer('pointerdown', left());
    click(right());
    expect(env.stops[0]).toHaveBeenCalledOnce();
    expect(env.deps.explain).toHaveBeenCalledTimes(2);
    expect(env.contexts[1]).not.toBe(env.contexts[0]);
  });

  it('press and click on the same side still send one request', async () => {
    env = setup(() => Promise.resolve(DONE));
    pointer('pointerdown', right());
    pointer('pointerup', right());
    click(right());
    await flush();
    expect(env.deps.explain).toHaveBeenCalledOnce();
    expect(env.popups[0]!.calls).toEqual([`done:${DONE.model}:${DONE.explanation.what}`]);
  });
});

describe('click handler with the real popup', () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    currentPopup()?.close();
    document.body.innerHTML = '';
  });

  it('shows loading, then the three sections, and the popup itself is not a diff line', async () => {
    document.body.innerHTML = fixture('github-diff-classic.html');
    const answer = deferred<ExplainResult>();
    let send!: (text: string) => void;
    const explain = vi.fn((_context: string, onChunk: (text: string) => void) => {
      send = onChunk;
      return { result: answer.promise, stop: vi.fn() };
    });
    const handler = createClickHandler({
      explain,
      openPopup: (anchor, options) => openPopup(anchor, options),
    });
    document.addEventListener('click', handler);
    cleanup = () => document.removeEventListener('click', handler);

    const line = document
      .getElementById(`${ANCHOR}R44`)!
      .closest('tr')!
      .querySelector('.blob-code-inner')!;
    click(line);
    const root = document.getElementById(POPUP_ID)!.shadowRoot!;
    expect(root.querySelector('.loading')).not.toBeNull();

    // The reply is kept back while it is written (PR 9.6): the placeholders stay.
    send('Marks **2.4**');
    expect(currentPopup()!.state).toBe('streaming');
    expect(root.querySelector('.partial')).toBeNull();
    expect(root.querySelector('.placeholder')).not.toBeNull();

    answer.resolve(DONE);
    await flush();
    expect(currentPopup()!.state).toBe('done');
    expect(root.querySelector('.placeholder')).toBeNull();
    expect(root.querySelectorAll('section')).toHaveLength(3);

    click(root.querySelector('section')!);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('shows each section once it is written, one at a time (PR 9.13)', async () => {
    document.body.innerHTML = fixture('github-diff-classic.html');
    const answer = deferred<ExplainResult>();
    let send!: (text: string) => void;
    const handler = createClickHandler({
      explain: (_context, onChunk) => {
        send = onChunk;
        return { result: answer.promise, stop: vi.fn() };
      },
      openPopup: (anchor, options) => openPopup(anchor, options),
    });
    document.addEventListener('click', handler);
    cleanup = () => document.removeEventListener('click', handler);

    click(
      document.getElementById(`${ANCHOR}R44`)!.closest('tr')!.querySelector('.blob-code-inner')!,
    );
    const root = document.getElementById(POPUP_ID)!.shadowRoot!;
    const shown = () =>
      [...root.querySelectorAll<HTMLElement>('.body > section')].map((s) => s.dataset.section);
    send('## What it does\nMarks 2.4 as done.\n');
    expect(shown()).toEqual([]);
    send("## Why it's needed\nIt merged.\n");
    expect(shown()).toEqual(['what']);
    expect(currentPopup()!.state).toBe('streaming');
    send('## Concerns\nNone');
    expect(shown()).toEqual(['what', 'why']);
    answer.resolve(DONE);
    await flush();
    expect(currentPopup()!.state).toBe('done');
    expect(shown()).toEqual(['what', 'why', 'concerns']);
  });

  it('streams the reply with Show answers as they are written on (PR 9.6)', async () => {
    document.body.innerHTML = fixture('github-diff-classic.html');
    const answer = deferred<ExplainResult>();
    let send!: (text: string) => void;
    const handler = createClickHandler({
      explain: (_context, onChunk) => {
        send = onChunk;
        return { result: answer.promise, stop: vi.fn() };
      },
      openPopup: (anchor, options) => openPopup(anchor, { ...options, streamAnswers: true }),
    });
    document.addEventListener('click', handler);
    cleanup = () => document.removeEventListener('click', handler);

    click(
      document.getElementById(`${ANCHOR}R44`)!.closest('tr')!.querySelector('.blob-code-inner')!,
    );
    const root = document.getElementById(POPUP_ID)!.shadowRoot!;
    send('Marks **2.4**');
    expect(root.querySelector('.partial strong')!.textContent).toBe('2.4');
    answer.resolve(DONE);
    await flush();
    expect(root.querySelectorAll('section')).toHaveLength(3);
  });
});

describe('rating an answer (PR 11.11)', () => {
  const KEY = 'b'.repeat(64);
  const LENGTH =
    DONE.status === 'done'
      ? DONE.explanation.what.length +
        DONE.explanation.why.length +
        DONE.explanation.concerns.length
      : 0;
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    currentPopup()?.close();
    document.body.innerHTML = '';
  });

  function clickWithRatings(results: ExplainResult[], rate?: ClickHandlerDeps['rate']) {
    document.body.innerHTML = fixture('github-diff-classic.html');
    const explain = vi.fn(() => ({
      result: Promise.resolve(results.shift() ?? DONE),
      stop: vi.fn(),
    }));
    const handler = createClickHandler({
      explain,
      openPopup: (anchor, options) => openPopup(anchor, options),
      ...(rate && { rate }),
    });
    document.addEventListener('click', handler);
    cleanup = () => document.removeEventListener('click', handler);
    click(
      document.getElementById(`${ANCHOR}R44`)!.closest('tr')!.querySelector('.blob-code-inner')!,
    );
    const root = document.getElementById(POPUP_ID)!.shadowRoot!;
    const button = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
    return {
      explain,
      up: () => button('button.rate-button[data-rating="up"]'),
      down: () => button('button.rate-button[data-rating="down"]'),
      retry: () => button('button.retry'),
      root,
    };
  }

  it('saves the model, kind, length, time and key of the answer, but not its text', async () => {
    const rate = vi.fn<NonNullable<ClickHandlerDeps['rate']>>();
    const page = clickWithRatings([{ ...DONE, key: KEY } as ExplainResult], rate);
    await flush();
    page.up().click();
    expect(rate).toHaveBeenCalledOnce();
    const sent = rate.mock.calls[0]![0];
    expect(sent).toEqual({
      id: expect.any(String),
      rating: 'up',
      model: 'qwen2.5-coder:7b',
      kind: 'click',
      length: LENGTH,
      elapsedMs: expect.any(Number),
      key: KEY,
      ratedAt: expect.any(Number),
    });
    expect(JSON.stringify(sent)).not.toContain('Marks 2.4');
    // Changing the rating keeps the same answer id.
    page.down().click();
    expect(rate.mock.calls[1]![0]).toMatchObject({ id: sent.id, rating: 'down' });
  });

  it('after 👎, Regenerate asks again without the cache, and the new answer is rated on its own', async () => {
    const rate = vi.fn<NonNullable<ClickHandlerDeps['rate']>>();
    const page = clickWithRatings([DONE, DONE], rate);
    await flush();
    page.down().click();
    page.retry().click();
    expect(page.explain).toHaveBeenCalledTimes(2);
    expect((page.explain.mock.calls[1] as unknown[])[2]).toMatchObject({ fresh: true });
    await flush();
    page.up().click();
    const [first, second] = rate.mock.calls.map(([update]) => update);
    expect(first!.rating).toBe('down');
    expect(second!.rating).toBe('up');
    expect(second!.id).not.toBe(first!.id);
  });

  it('shows no rating buttons without rate', async () => {
    const page = clickWithRatings([DONE]);
    await flush();
    expect(page.root.querySelector('.rate')).toBeNull();
  });
});

describe('ratingOf', () => {
  const done = DONE as Extract<ExplainResult, { status: 'done' }>;

  it('says a fresh answer is a click, with how long this click waited', () => {
    expect(ratingOf(done, 1834.6, 'id-1')).toEqual({
      id: 'id-1',
      model: 'qwen2.5-coder:7b',
      kind: 'click',
      length: 'Marks 2.4 as done.It merged.None found.'.length,
      elapsedMs: 1835,
    });
  });

  it('takes the kind and the first time from a cached answer', () => {
    const cached = (info: object) =>
      ratingOf({ ...done, cached: { elapsedMs: 9800, savedAt: 1, ...info } }, 5, 'id');
    expect(cached({ kind: 'hover' })).toMatchObject({
      kind: 'hover',
      elapsedMs: 9800,
      cached: true,
    });
    expect(cached({ kind: 'hunk', prefetched: true })).toMatchObject({ kind: 'hunk' });
    // Saved before kinds existed: prefetched means Explain ahead, otherwise a click.
    expect(cached({ prefetched: true })).toMatchObject({ kind: 'ahead' });
    expect(cached({})).toMatchObject({ kind: 'click' });
  });

  it('gives each answer its own id', () => {
    expect(ratingOf(done, 1).id).not.toBe(ratingOf(done, 1).id);
  });
});

describe('isInteractive', () => {
  it('finds controls from text nodes and nested elements', () => {
    document.body.innerHTML = '<button><span>+</span></button><div><span>code</span></div>';
    expect(isInteractive(document.querySelector('button span')!.firstChild)).toBe(true);
    expect(isInteractive(document.querySelector('div span'))).toBe(false);
    expect(isInteractive(null)).toBe(false);
  });
});

describe('describeRequestError', () => {
  it('explains timeouts and unreachable service workers', () => {
    expect(describeRequestError(new RequestError('x', 'TimeoutError')).message).toMatch(/too long/);
    const unreachable = describeRequestError(
      new RequestError('Could not reach the service worker: Extension context invalidated.'),
    );
    expect(unreachable.message).toContain('Extension context invalidated');
    expect(unreachable.fix).toContain('chrome://extensions');
  });
});
