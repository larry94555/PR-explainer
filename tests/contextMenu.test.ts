// Explain with PR Explainer in the right-click menu (PR 11.9): the item is
// on PR pages only, and the page explains what was right-clicked, the
// selected lines or the line under the pointer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHandlerDeps } from '../src/clickHandler';
import {
  EXPLAIN_MENU_ID,
  EXPLAIN_MENU_TITLE,
  PR_PAGE_PATTERNS,
  setupExplainMenu,
  type CommandTabsLike,
} from '../src/commands';
import type { ContextMenusLike } from '../src/debug/debugWindowOpener';
import type { ExplainResult } from '../src/explain/explainHandler';
import type { Popup, PopupAnchor } from '../src/popup/popup';
import {
  installSelection,
  NOT_A_LINE_NOTE,
  SELECTED_ATTR,
  SELECTION_UI_ID,
} from '../src/selection';
import { trackContextTarget } from '../src/tabCommands';

const PR = 'https://github.com/owner/repo/pull/17/files';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeMenus() {
  let onClicked: Parameters<ContextMenusLike['onClicked']['addListener']>[0] = () => {};
  const menus = {
    removeAll: vi.fn(async () => {}),
    create: vi.fn(),
    update: vi.fn(async () => {}),
    onClicked: { addListener: (l: typeof onClicked) => void (onClicked = l) },
  };
  return { menus, click: (...args: Parameters<typeof onClicked>) => onClicked(...args) };
}

function fakeTabs() {
  const sent: { tabId: number; message: unknown }[] = [];
  const tabs: CommandTabsLike = {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async (tabId, message) => void sent.push({ tabId, message })),
  };
  return { tabs, sent };
}

describe('setupExplainMenu', () => {
  it('adds the item on PR pages only, for a right-click on the page or a selection', async () => {
    const { menus } = fakeMenus();
    let madeBefore = false;
    const after = new Promise<void>((done) => setTimeout(done, 0)).then(() => {
      madeBefore = menus.create.mock.calls.length === 0;
    });
    await setupExplainMenu({ menus, tabs: fakeTabs().tabs, after });
    expect(madeBefore).toBe(true);
    expect(menus.create).toHaveBeenCalledWith({
      id: EXPLAIN_MENU_ID,
      title: EXPLAIN_MENU_TITLE,
      contexts: ['page', 'selection'],
      documentUrlPatterns: PR_PAGE_PATTERNS,
      visible: true,
    });
    expect(EXPLAIN_MENU_TITLE).toBe('Explain with PR Explainer');
    expect(PR_PAGE_PATTERNS).toEqual(['https://github.com/*/*/pull/*']);
  });

  it('is made even when the earlier items failed', async () => {
    const { menus } = fakeMenus();
    await setupExplainMenu({ menus, tabs: fakeTabs().tabs, after: Promise.reject(new Error('x')) });
    expect(menus.create).toHaveBeenCalledTimes(1);
  });

  it('tells the tab to explain what was right-clicked', async () => {
    const { menus, click } = fakeMenus();
    const { tabs, sent } = fakeTabs();
    await setupExplainMenu({ menus, tabs, after: Promise.resolve() });
    click({ menuItemId: EXPLAIN_MENU_ID, pageUrl: PR }, { id: 3, url: PR });
    await flush();
    expect(sent).toEqual([
      { tabId: 3, message: { type: 'pr-explainer:command', command: 'explain-at-pointer' } },
    ]);
  });

  it('ignores other items, and pages that are not a PR', async () => {
    const { menus, click } = fakeMenus();
    const { tabs, sent } = fakeTabs();
    await setupExplainMenu({ menus, tabs, after: Promise.resolve() });
    click({ menuItemId: 'open-chat', pageUrl: PR }, { id: 3, url: PR });
    click({ menuItemId: EXPLAIN_MENU_ID, pageUrl: 'https://github.com/o/r' }, { id: 3 });
    click({ menuItemId: EXPLAIN_MENU_ID, pageUrl: PR });
    await flush();
    expect(sent).toEqual([]);
  });
});

// The page's side, on GitHub's classic diff (the same fixture as a11y.test.ts).
const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';
const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'Marks 2.4 as done.', why: 'It merged.', concerns: 'None found.' },
  model: 'qwen2.5-coder:7b',
};
const code = (id: string) =>
  document
    .querySelector(`[id="${ANCHOR}${id}"]`)!
    .closest('tr')!
    .querySelector<HTMLElement>('.blob-code-inner')!;
const row = (id: string) => code(id).closest('tr')!;

function setupPage(isEnabled?: () => boolean) {
  const contexts: string[] = [];
  const anchors: PopupAnchor[] = [];
  const deps = {
    isEnabled,
    explain: vi.fn((context: string) => {
      contexts.push(context);
      return { result: Promise.resolve(DONE), stop: vi.fn() };
    }),
    openPopup: (anchor: PopupAnchor, hooks: Parameters<ClickHandlerDeps['openPopup']>[1]) => {
      anchors.push(anchor);
      return {
        host: document.createElement('div'),
        state: 'loading',
        pinned: false,
        elapsedMs: 0,
        showLoading: () => {},
        showPartial: () => {},
        showExplanation: () => {},
        showError: () => {},
        showPrompt: () => {},
        showTrace: () => {},
        close: () => hooks.onClose(),
      } as Popup;
    },
  };
  const selection = installSelection(deps);
  const pointer = trackContextTarget(document);
  /** A right-click on `target`, then the menu item, as the page hears them. */
  const rightClick = (target: Element) => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    target.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 40, clientY: 50 }),
    );
    const at = pointer.current();
    return selection.explainAt(at?.target ?? null, at?.point);
  };
  return {
    contexts,
    anchors,
    rightClick,
    remove: () => {
      selection();
      pointer.remove();
    },
  };
}

describe('Explain with PR Explainer on the page', () => {
  let env: ReturnType<typeof setupPage>;
  beforeEach(() => {
    document.body.innerHTML = readFileSync(
      resolve(import.meta.dirname, 'fixtures', 'github-diff-classic.html'),
      'utf8',
    );
    for (const id of ['R43', 'L44', 'R44', 'R45']) {
      const n = Number(id.slice(1));
      row(id).getBoundingClientRect = () => ({ top: n, bottom: n, left: 0 }) as DOMRect;
    }
  });
  afterEach(() => {
    env?.remove();
    document.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('explains the line under the pointer', () => {
    env = setupPage();
    expect(env.rightClick(code('R45'))).toBe(true);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0]).toContain('Clicked line: context, line 45 of the new file');
    expect(env.anchors[0]).toBe(row('R45'));
  });

  it('explains a text selection across lines when right-clicked on it', () => {
    env = setupPage();
    const range = document.createRange();
    range.setStart(code('R43').firstChild!, 0);
    range.setEnd(code('R45').firstChild!, 1);
    document.getSelection()!.addRange(range);
    expect(env.rightClick(code('R44'))).toBe(true);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0]).toContain('Selection: 4 lines');
    expect(document.querySelectorAll(`tr[${SELECTED_ATTR}]`)).toHaveLength(4);
  });

  it('explains a block picked with Shift-click, which the right-click keeps', () => {
    env = setupPage();
    const down = (target: Element, shiftKey = false) => {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, shiftKey }));
      }
    };
    down(code('R43'));
    down(code('R45'), true);
    expect(document.getElementById(SELECTION_UI_ID)).not.toBeNull();
    expect(env.rightClick(code('R44'))).toBe(true);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0]).toContain('Selection: 4 lines');
  });

  it('explains the line, not the block, when right-clicked outside the block', () => {
    env = setupPage();
    const down = (target: Element, shiftKey = false) => {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, shiftKey }));
      }
    };
    down(code('R43'));
    down(code('R44'), true);
    expect(env.rightClick(code('R45'))).toBe(true);
    expect(env.contexts[0]).toContain('Clicked line: context, line 45 of the new file');
  });

  it('says what to do when right-clicked off the diff', () => {
    env = setupPage();
    const outside = document.createElement('p');
    document.body.append(outside);
    expect(env.rightClick(outside)).toBe(false);
    expect(env.contexts).toHaveLength(0);
    const note = document.getElementById(SELECTION_UI_ID)!;
    expect(note.shadowRoot!.textContent).toContain(NOT_A_LINE_NOTE);
    expect(note.style.top).toBe('54px');
    expect(note.style.left).toBe('40px');
  });

  it('does nothing while click-to-explain is off', () => {
    env = setupPage(() => false);
    expect(env.rightClick(code('R45'))).toBe(false);
    expect(env.contexts).toHaveLength(0);
    expect(document.getElementById(SELECTION_UI_ID)).toBeNull();
  });
});
