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
import { currentPopup, openPopup, POPUP_ID, type Popup } from '../src/popup/popup';

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

/** A popup that records what it was asked to show. */
function fakePopup(anchor: Element) {
  const calls: string[] = [];
  let state: Popup['state'] = 'loading';
  const popup: Popup & { anchor: Element; calls: string[] } = {
    anchor,
    calls,
    host: document.createElement('div'),
    elapsedMs: 1234,
    get state() {
      return state;
    },
    showLoading: () => calls.push('loading'),
    showExplanation: (explanation, model) => {
      if (state === 'closed') return;
      state = 'done';
      calls.push(`done:${model}:${explanation.what}`);
    },
    showError: (message, fix) => {
      if (state === 'closed') return;
      state = 'failed';
      calls.push(`failed:${message}|${fix}`);
    },
    close: () => {
      state = 'closed';
    },
  };
  return popup;
}

function setup(
  answer: () => Promise<ExplainResult> = () => Promise.resolve(DONE),
  isEnabled?: () => boolean,
) {
  const contexts: string[] = [];
  const timings: ExplainTiming[] = [];
  const popups: ReturnType<typeof fakePopup>[] = [];
  const deps: ClickHandlerDeps = {
    isEnabled,
    explain: vi.fn((context: string) => {
      contexts.push(context);
      return answer();
    }),
    openPopup: (anchor) => {
      popups.at(-1)?.close();
      const popup = fakePopup(anchor);
      popups.push(popup);
      return popup;
    },
    onTiming: (timing) => timings.push(timing),
  };
  const handler = createClickHandler(deps);
  document.addEventListener('click', handler);
  return {
    deps,
    contexts,
    popups,
    timings,
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
    const explain = vi.fn(() => answer.promise);
    const handler = createClickHandler({ explain, openPopup: (anchor) => openPopup(anchor) });
    document.addEventListener('click', handler);
    cleanup = () => document.removeEventListener('click', handler);

    const line = document
      .getElementById(`${ANCHOR}R44`)!
      .closest('tr')!
      .querySelector('.blob-code-inner')!;
    click(line);
    const root = document.getElementById(POPUP_ID)!.shadowRoot!;
    expect(root.querySelector('.loading')).not.toBeNull();

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
