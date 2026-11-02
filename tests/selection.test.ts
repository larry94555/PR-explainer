import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHandlerDeps } from '../src/clickHandler';
import { locateRange, type DiffRange } from '../src/diffDom';
import {
  buildExplainPrompt,
  EXPLAIN_SELECTION_SYSTEM_PROMPT,
  EXPLAIN_SYSTEM_PROMPT,
  isSelectionContext,
} from '../src/explain/explainPrompt';
import type { ExplainResult } from '../src/explain/explainHandler';
import {
  describeSelection,
  extractContext,
  formatContext,
  formatSelection,
  MAX_SELECTED_LINES,
  selectionContext,
} from '../src/lineContext';
import type { Popup, PopupAnchor } from '../src/popup/popup';
import {
  installSelection,
  selectionSubject,
  NOTE_MS,
  OTHER_FILE_NOTE,
  SELECTED_ATTR,
  SELECTION_UI_ID,
  TOO_MANY_NOTE,
  type SelectionDeps,
} from '../src/selection';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';
const HEADER =
  "@@ -41,7 +41,7 @@ Update this table (and the PR's heading) when a roadmap PR merges.";

// The one hunk in both fixtures, written diff style.
const HUNK = [
  ' | 2.1 | Settings storage | Small | ✅ Done ([#7](https://github.com/larry94555/PR-explainer/pull/7)) |',
  ' | 2.2 | Ollama client: list models and non-streaming chat | Medium | ✅ Done ([#8](https://github.com/larry94555/PR-explainer/pull/8)) |',
  ' | 2.3 | Settings page UI | Medium | ✅ Done ([#9](https://github.com/larry94555/PR-explainer/pull/9)) |',
  '-| 2.4 | Friendly LLM error messages | Small | Not started |',
  '+| 2.4 | Friendly LLM error messages | Small | ✅ Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)) |',
  ' | 3.1 | Diff line locator | Medium | Not started |',
  ' | 3.2 | Hunk context extractor | Small | Not started |',
  ' | 3.3 | Explanation prompt and response parser | Medium | Not started |',
];

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'Marks 2.4 as done.', why: 'It merged.', concerns: 'None found.' },
  model: 'qwen2.5-coder:7b',
};

const layouts = [
  {
    name: 'classic',
    file: 'github-diff-classic.html',
    code: (id: string, root: ParentNode = document) =>
      root
        .querySelector(`[id="${ANCHOR}${id}"]`)!
        .closest('tr')!
        .querySelector('.blob-code-inner')!,
    headerRow: () => document.querySelector('td.blob-code-hunk')!.closest('tr')!,
    /** Adds a second file to the page and returns its root. */
    addFile: () => {
      const copy = document.querySelector('[data-file-path]')!.cloneNode(true) as Element;
      copy.setAttribute('data-file-path', 'docs/features.md');
      copy
        .querySelector('[data-tagsearch-path]')
        ?.setAttribute('data-tagsearch-path', 'docs/features.md');
      document.body.append(copy);
      return copy;
    },
  },
  {
    name: 'new (React)',
    file: 'github-diff-new.html',
    code: (id: string, root: ParentNode = document) =>
      root.querySelector(`td[data-line-anchor="${ANCHOR}${id}"] .diff-text-inner`)!,
    headerRow: () => document.querySelector('td.diff-hunk-cell')!.closest('tr')!,
    addFile: () => {
      const copy = document.querySelector('table[data-diff-anchor]')!.cloneNode(true) as Element;
      copy.setAttribute('aria-label', 'Diff for: docs/features.md');
      const wrapper = document.createElement('div');
      wrapper.append(copy);
      document.body.append(wrapper);
      return wrapper;
    },
  },
];

function lineTexts(range: DiffRange): string[] {
  return range.items.map((item) =>
    'line' in item ? `${item.line.side}:${item.line.lineNumber}` : item.header,
  );
}

/** Selects text from the start of `from` to the end of `to`, like a drag. */
function dragSelect(from: Element, to: Element): void {
  const range = document.createRange();
  range.setStart(from.firstChild ?? from, 0);
  range.setEnd(to.firstChild ?? to, (to.firstChild ?? to).textContent!.length);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function mouse(type: string, target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
}

/** A full click: mousedown, mouseup, click. */
function click(target: Element, init: MouseEventInit = {}): void {
  mouse('mousedown', target, init);
  mouse('mouseup', target, init);
  mouse('click', target, init);
}

const ui = () => document.getElementById(SELECTION_UI_ID);
const uiText = () => ui()?.shadowRoot?.querySelector('.bar')?.textContent ?? null;
const uiButton = () => ui()?.shadowRoot?.querySelector('button') ?? null;
const highlighted = () => [...document.querySelectorAll(`tr[${SELECTED_ATTR}]`)];

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe.each(layouts)('locateRange on the $name layout', ({ file, code, headerRow, addFile }) => {
  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  it('collects every line from the first to the last row, with mixed added and removed lines', () => {
    const range = locateRange(code('R43'), code('R45')) as DiffRange;
    expect(lineTexts(range)).toEqual(['context:43', 'removed:44', 'added:44', 'context:45']);
    expect(range.rows).toEqual(['R43', 'L44', 'R44', 'R45'].map((id) => code(id).closest('tr')));
  });

  it('gives the same range when selected bottom to top', () => {
    expect(locateRange(code('R45'), code('R43'))).toEqual(locateRange(code('R43'), code('R45')));
  });

  it('keeps the hunk header of a hunk the range crosses', () => {
    const second = headerRow().cloneNode(true) as Element;
    second.querySelector('.blob-code-hunk, .diff-text-inner')!.textContent = '@@ -46,2 +46,2 @@';
    code('R46').closest('tr')!.before(second);
    const range = locateRange(code('R45'), code('R46')) as DiffRange;
    expect(lineTexts(range)).toEqual(['context:45', '@@ -46,2 +46,2 @@', 'context:46']);
    expect(range.rows).toHaveLength(2);
  });

  it('rejects a range across two files', () => {
    const other = addFile();
    expect(locateRange(code('R43'), code('R45', other))).toBe('other-file');
  });

  it('returns null when either end is not on a code line', () => {
    expect(locateRange(headerRow(), code('R45'))).toBeNull();
    expect(locateRange(code('R45'), document.body)).toBeNull();
  });
});

describe('formatSelection', () => {
  beforeEach(() => {
    document.body.innerHTML = fixture('github-diff-classic.html');
  });
  const code = layouts[0]!.code;

  it('describes the block and puts the lines around it before and after', () => {
    const range = locateRange(code('R43'), code('R45')) as DiffRange;
    const text = formatSelection(selectionContext(range, { before: 1, after: 1 }));
    expect(text).toBe(
      [
        'File: docs/roadmap.md (Markdown)',
        'Selection: 4 lines (1 added, 1 removed, 2 unchanged); lines 43 to 45 of the new file, line 44 of the old file',
        '',
        'Lines before the selection:',
        HEADER,
        HUNK[1],
        '',
        'Selected lines:',
        ...HUNK.slice(2, 6),
        '',
        'Lines after the selection:',
        HUNK[6],
      ].join('\n'),
    );
  });

  it('describes a block of added lines only', () => {
    const line = (lineNumber: number) =>
      ({ filePath: 'a.ts', lineNumber, side: 'added', text: '' }) as const;
    expect(describeSelection([line(3), line(4), line(5)])).toBe(
      '3 lines (3 added); lines 3 to 5 of the new file',
    );
  });

  it('is asked about as a block, while a single line keeps the line prompt', () => {
    const range = locateRange(code('R43'), code('R45')) as DiffRange;
    const block = formatSelection(selectionContext(range));
    expect(isSelectionContext(block)).toBe(true);
    const [system, user] = buildExplainPrompt(block);
    expect(system!.content).toBe(EXPLAIN_SELECTION_SYSTEM_PROMPT);
    expect(system!.content).toContain('as a whole');
    expect(user!.content).toMatch(/^Explain the selected lines/);

    const single = formatContext(extractContext(code('R44'))!);
    expect(isSelectionContext(single)).toBe(false);
    expect(buildExplainPrompt(single)[0]!.content).toBe(EXPLAIN_SYSTEM_PROMPT);
  });
});

function setup(isEnabled?: () => boolean) {
  const contexts: string[] = [];
  const popups: Array<{
    anchor: PopupAnchor;
    hooks: Parameters<ClickHandlerDeps['openPopup']>[1];
  }> = [];
  const deps = {
    isEnabled,
    explain: vi.fn((context: string) => {
      contexts.push(context);
      return { result: Promise.resolve(DONE), stop: vi.fn() };
    }),
    openPopup: (anchor: PopupAnchor, hooks: Parameters<ClickHandlerDeps['openPopup']>[1]) => {
      popups.push({ anchor, hooks });
      return {
        host: document.createElement('div'),
        state: 'loading',
        elapsedMs: 0,
        showLoading: () => {},
        showPartial: () => {},
        showExplanation: () => {},
        showError: () => {},
        showPrompt: () => {},
        close: () => hooks.onClose(),
      } as Popup;
    },
  };
  const uninstall = installSelection(deps);
  return { deps, contexts, popups, uninstall };
}

describe.each(layouts)('selecting lines on the $name layout', ({ code, file, addFile }) => {
  let env: ReturnType<typeof setup>;
  const row = (id: string) => code(id).closest('tr')!;

  beforeEach(() => {
    document.body.innerHTML = fixture(file);
    // jsdom has no layout: give each row a box at its line number.
    for (const id of ['R41', 'R42', 'R43', 'L44', 'R44', 'R45', 'R46', 'R47']) {
      const n = Number(id.slice(1));
      row(id).getBoundingClientRect = () => ({ top: n, bottom: n, left: 0 }) as DOMRect;
    }
  });
  afterEach(() => env?.uninstall());

  it('highlights a dragged range and explains it as one block', () => {
    env = setup();
    dragSelect(code('R42'), code('R45'));
    mouse('mouseup', code('R45'));
    expect(highlighted()).toEqual(['R42', 'R43', 'L44', 'R44', 'R45'].map(row));
    expect(uiButton()?.textContent).toBe('Explain selection (5 lines)');
    expect(env.deps.explain).not.toHaveBeenCalled();

    uiButton()!.click();
    expect(env.deps.explain).toHaveBeenCalledTimes(1);
    expect(env.contexts[0]).toContain('Selection: 5 lines');
    expect(env.contexts[0]).toContain(`Selected lines:\n${HUNK.slice(1, 6).join('\n')}`);
    expect(env.popups[0]!.anchor.getBoundingClientRect()).toEqual({ top: 42, bottom: 45, left: 0 });
    expect(ui()).toBeNull();
    // The highlight stays while the popup is open and goes when it closes.
    expect(highlighted()).toHaveLength(5);
    env.popups[0]!.hooks.onClose();
    expect(highlighted()).toEqual([]);
  });

  it('gives the block to an open chat instead of a popup (PR 5.4)', () => {
    env = setup();
    const addToChat = vi.fn(() => true);
    (env.deps as SelectionDeps).addToChat = addToChat;
    dragSelect(code('R42'), code('R45'));
    mouse('mouseup', code('R45'));
    uiButton()!.click();
    expect(addToChat).toHaveBeenCalledWith({
      text: expect.stringContaining('Selection: 5 lines'),
      subject: expect.objectContaining({ startLine: 42, endLine: 45 }),
      code: expect.objectContaining({ filePath: 'docs/roadmap.md', startLine: 42, endLine: 45 }),
    });
    expect(env.deps.explain).not.toHaveBeenCalled();
    expect(env.popups).toEqual([]);
    expect(highlighted()).toEqual([]);
  });

  it('selects from a clicked line to a Shift-clicked one, in either direction', () => {
    env = setup();
    click(code('R46'));
    click(code('R43'), { shiftKey: true });
    expect(highlighted()).toEqual(['R43', 'L44', 'R44', 'R45', 'R46'].map(row));
    uiButton()!.click();
    expect(env.contexts[0]).toContain('Selection: 5 lines');
    // The popup points at the whole block, not the clicked line.
    expect(env.popups[0]!.anchor.getBoundingClientRect()).toEqual({ top: 43, bottom: 46, left: 0 });
  });

  it('ignores a text selection inside one line', () => {
    env = setup();
    dragSelect(code('R44'), code('R44'));
    mouse('mouseup', code('R44'));
    expect(ui()).toBeNull();
    expect(highlighted()).toEqual([]);
  });

  it('shows a note instead of a button for a range across two files', () => {
    vi.useFakeTimers();
    try {
      env = setup();
      const other = addFile();
      click(code('R43'));
      click(code('R45', other), { shiftKey: true });
      expect(uiText()).toBe(OTHER_FILE_NOTE);
      expect(uiButton()).toBeNull();
      expect(highlighted()).toEqual([]);
      vi.advanceTimersByTime(NOTE_MS);
      expect(ui()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for a smaller selection past the line limit', () => {
    env = setup();
    const extra = row('R45');
    for (let i = 0; i < MAX_SELECTED_LINES; i++) extra.after(extra.cloneNode(true));
    dragSelect(code('R41'), code('R47'));
    mouse('mouseup', code('R47'));
    expect(uiText()).toBe(TOO_MANY_NOTE);
  });

  it('clears the highlight on Esc and on a click elsewhere', () => {
    env = setup();
    dragSelect(code('R42'), code('R44'));
    mouse('mouseup', code('R44'));
    expect(highlighted()).toHaveLength(4);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(highlighted()).toEqual([]);
    expect(ui()).toBeNull();

    dragSelect(code('R42'), code('R44'));
    mouse('mouseup', code('R44'));
    mouse('mousedown', document.body);
    expect(highlighted()).toEqual([]);
    expect(ui()).toBeNull();
  });

  it('does not bring back an old selection on a later click', () => {
    env = setup();
    mouse('mousedown', code('R42'));
    dragSelect(code('R42'), code('R44'));
    mouse('mouseup', code('R44'));
    expect(highlighted()).toHaveLength(4);
    // The browser can keep the old text selection through the next click.
    click(document.body);
    expect(document.getSelection()!.isCollapsed).toBe(false);
    expect(highlighted()).toEqual([]);
    expect(ui()).toBeNull();
    // The same after Esc, and for a click on a line inside the old selection.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    click(code('R43'));
    expect(highlighted()).toEqual([]);
    expect(ui()).toBeNull();
    // A new drag still works.
    mouse('mousedown', code('R45'));
    dragSelect(code('R45'), code('R46'));
    mouse('mouseup', code('R46'));
    expect(highlighted()).toEqual(['R45', 'R46'].map(row));
  });

  it('does nothing while click-to-explain is off', () => {
    env = setup(() => false);
    dragSelect(code('R42'), code('R45'));
    mouse('mouseup', code('R45'));
    expect(ui()).toBeNull();
    expect(highlighted()).toEqual([]);
  });

  it('replaces the highlight when a new block is selected', () => {
    env = setup();
    dragSelect(code('R41'), code('R42'));
    mouse('mouseup', code('R42'));
    uiButton()!.click();
    dragSelect(code('R45'), code('R46'));
    mouse('mouseup', code('R46'));
    expect(highlighted()).toEqual(['R45', 'R46'].map(row));
    // Closing the first block's popup leaves the new highlight alone.
    env.popups[0]!.hooks.onClose();
    expect(highlighted()).toEqual(['R45', 'R46'].map(row));
  });
});

describe('selectionSubject', () => {
  const line = (lineNumber: number, side: 'added' | 'removed' | 'context') => ({
    filePath: 'src/a.ts',
    lineNumber,
    side,
    text: '',
  });
  const context = (lines: ReturnType<typeof line>[]) =>
    ({ filePath: 'src/a.ts', lines }) as Parameters<typeof selectionSubject>[0];

  it("uses the new file's lines, or the old file's when only removed lines are selected", () => {
    expect(
      selectionSubject(context([line(9, 'removed'), line(12, 'added'), line(14, 'context')])),
    ).toEqual({
      filePath: 'src/a.ts',
      startLine: 12,
      endLine: 14,
    });
    expect(selectionSubject(context([line(30, 'removed'), line(31, 'removed')]))).toEqual({
      filePath: 'src/a.ts',
      startLine: 30,
      endLine: 31,
    });
  });
});

// Split view (PR 7.2): GitHub selects text on one side at a time, so a drag
// down the left side explains the old lines and one down the right side the
// new lines. Both fixtures are tests/manifest.test.ts from PR #28.
describe.each([
  { name: 'classic', file: 'github-diff-classic-split.html' },
  { name: 'new (React)', file: 'github-diff-new-split.html' },
])('selecting lines in split view on the $name layout', ({ file }) => {
  let env: ReturnType<typeof setup>;
  // The code cell on `column`'s side of the n-th code row (hunk headers left out).
  const cell = (n: number, column: 'left' | 'right') =>
    [...document.querySelectorAll('tbody tr')].filter((r) => r.children.length === 4)[n]!.children[
      column === 'left' ? 1 : 3
    ]!;

  // Selects the text of the cells from `from` to `to`, like a drag.
  const dragCells = (from: Element, to: Element) => {
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, to.childNodes.length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  };

  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });
  afterEach(() => env?.uninstall());

  // Rows 2 to 6 of the first hunk: new lines 47 to 51, with two changed rows.
  it('explains only the old lines for a drag down the left side', () => {
    env = setup();
    dragCells(cell(2, 'left'), cell(6, 'left'));
    mouse('mouseup', cell(6, 'left'));
    expect(highlighted()).toHaveLength(5);
    expect(uiButton()?.textContent).toBe('Explain selection (5 lines)');
    uiButton()!.click();
    expect(env.contexts[0]).toContain('Selection: 5 lines (2 removed, 3 unchanged)');
    expect(env.contexts[0]).not.toMatch(/^\+/m);
  });

  it('explains only the new lines for a drag down the right side', () => {
    env = setup();
    dragCells(cell(2, 'right'), cell(6, 'right'));
    mouse('mouseup', cell(6, 'right'));
    uiButton()!.click();
    expect(env.contexts[0]).toContain('Selection: 5 lines (2 added, 3 unchanged)');
  });

  it('counts both lines of each changed row for a Shift-click across sides', () => {
    env = setup();
    click(cell(2, 'left'));
    mouse('mousedown', cell(6, 'right'), { shiftKey: true });
    mouse('mouseup', cell(6, 'right'), { shiftKey: true });
    expect(highlighted()).toHaveLength(5);
    expect(uiButton()?.textContent).toBe('Explain selection (7 lines)');
    uiButton()!.click();
    expect(env.contexts[0]).toContain('Selection: 7 lines (2 added, 2 removed, 3 unchanged)');
    // Removed before added, as in the unified view.
    expect(env.contexts[0]).toMatch(/^-.*injects one content script[^\n]*\n\+/m);
  });

  it('selects both lines of one changed row for a Shift-click from its old half to its new half', () => {
    env = setup();
    // Row 3 of the first hunk: removed line 46 on the left, added line 48 on the right.
    click(cell(3, 'left'));
    click(cell(3, 'right'), { shiftKey: true });
    expect(highlighted()).toHaveLength(1);
    expect(uiButton()?.textContent).toBe('Explain selection (2 lines)');
    uiButton()!.click();
    expect(env.contexts[0]).toContain('Selection: 2 lines (1 added, 1 removed)');
  });

  it('does not select one line for a Shift-click on the same half of a row', () => {
    env = setup();
    click(cell(3, 'right'));
    click(cell(3, 'right'), { shiftKey: true });
    expect(highlighted()).toEqual([]);
    expect(ui()).toBeNull();
  });
});
