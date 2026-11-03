import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createClickHandler,
  describeRequestError,
  isInteractive,
  type ClickHandlerDeps,
  type ExplainTiming,
} from '../src/clickHandler';
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

function setup(answer: Answer = () => Promise.resolve(DONE), isEnabled?: () => boolean) {
  const contexts: string[] = [];
  const timings: ExplainTiming[] = [];
  // The click's tasks and reply (PR 9.1), kept apart so the timing checks stay short.
  const traced: Pick<ExplainTiming, 'tasks' | 'reply'>[] = [];
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
    onTiming: ({ tasks, reply, ...timing }) => {
      timings.push(timing);
      traced.push({ tasks, reply });
    },
  };
  const handler = createClickHandler(deps);
  document.addEventListener('click', handler);
  return {
    deps,
    contexts,
    popups,
    stops,
    timings,
    traced,
    cleanup: () => document.removeEventListener('click', handler),
  };
}

function click(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...init }));
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
      subject: { filePath: 'docs/roadmap.md', startLine: 44 },
      regenerated: false,
    });

    // After Regenerate the chat is marked to start over, even with the same text.
    env.popups[1]!.pressRegenerate();
    await flush();
    env.popups[1]!.hooks.onAsk!();
    expect(openChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ explanation: DONE.explanation, regenerated: true }),
    );
  });

  it('while a chat is open, a clicked line goes to the chat instead of a popup (PR 5.4)', () => {
    env = setup();
    let chatOpen = true;
    const addToChat = vi.fn(() => chatOpen);
    env.deps.addToChat = addToChat;
    click(code('R44'));
    expect(addToChat).toHaveBeenCalledWith({
      text: expect.stringContaining('docs/roadmap.md'),
      subject: { filePath: 'docs/roadmap.md', startLine: 44 },
      code: expect.objectContaining({ startLine: 44, endLine: 44 }),
    });
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

    send('Marks **2.4**');
    expect(currentPopup()!.state).toBe('streaming');
    expect(root.querySelector('.partial strong')!.textContent).toBe('2.4');

    answer.resolve(DONE);
    await flush();
    expect(currentPopup()!.state).toBe('done');
    expect(root.querySelectorAll('section')).toHaveLength(3);

    click(root.querySelector('section')!);
    expect(explain).toHaveBeenCalledTimes(1);
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
