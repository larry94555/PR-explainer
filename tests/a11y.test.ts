import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEditable, isExplainShortcut, restoreFocus, shortcutTarget } from '../src/a11y';
import { openChatPanel } from '../src/chat/chatPanel';
import type { ClickHandlerDeps } from '../src/clickHandler';
import { locateRow } from '../src/diffDom';
import type { ExplainResult } from '../src/explain/explainHandler';
import { openPopup, type Popup, type PopupAnchor } from '../src/popup/popup';
import { installSelection, SELECTED_ATTR, SELECTION_UI_ID } from '../src/selection';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'Marks 2.4 as done.', why: 'It merged.', concerns: 'None found.' },
  model: 'qwen2.5-coder:7b',
};

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}
const ALT_E: KeyboardEventInit = { code: 'KeyE', key: 'e', altKey: true };

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('isExplainShortcut', () => {
  it('matches Alt+E by key position, whatever character it types', () => {
    expect(isExplainShortcut(key(ALT_E))).toBe(true);
    // macOS: Option+E types a dead accent key.
    expect(isExplainShortcut(key({ ...ALT_E, key: 'Dead' }))).toBe(true);
  });

  it.each([
    ['E alone', { code: 'KeyE', key: 'e' }],
    ['Alt+R', { code: 'KeyR', key: 'r', altKey: true }],
    ['AltGr+E (Ctrl+Alt, types €)', { ...ALT_E, ctrlKey: true, key: '€' }],
    ['Alt+Shift+E', { ...ALT_E, shiftKey: true }],
    ['Cmd+Alt+E', { ...ALT_E, metaKey: true }],
    ['a held-down repeat', { ...ALT_E, repeat: true }],
  ])('ignores %s', (_, init) => {
    expect(isExplainShortcut(key(init))).toBe(false);
  });
});

describe('isEditable', () => {
  it('is true in text boxes and editable text, false elsewhere', () => {
    document.body.innerHTML = `
      <input id="i"><textarea id="t"></textarea>
      <div contenteditable="true"><span id="ce">x</span></div>
      <div contenteditable="false"><span id="off">x</span></div>
      <table><tr><td id="cell">code</td></tr></table>`;
    const at = (id: string) => document.getElementById(id);
    expect(isEditable(at('i'))).toBe(true);
    expect(isEditable(at('t'))).toBe(true);
    expect(isEditable(at('ce'))).toBe(true);
    expect(isEditable(at('off'))).toBe(false);
    expect(isEditable(at('cell'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('shortcutTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = fixture('github-diff-new.html');
  });
  const cell = (id: string) =>
    document.querySelector<HTMLElement>(`td[data-line-anchor="${ANCHOR}${id}"]`)!;
  const isLine = (node: Node) => locateRow(node) !== null;

  it('prefers the focused line', () => {
    cell('R45').focus();
    expect(shortcutTarget(document, isLine)).toBe(cell('R45'));
  });

  it('uses the text cursor when focus is not on a line', () => {
    const text = cell('R43').querySelector('.diff-text-inner')!.firstChild!;
    document.getSelection()!.collapse(text, 0);
    expect(shortcutTarget(document, isLine)).toBe(text);
  });

  it('is null when neither is on a line', () => {
    expect(shortcutTarget(document, isLine)).toBeNull();
  });
});

describe('restoreFocus', () => {
  it('focuses an element still on the page, and skips the body or a removed one', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    b.focus();
    restoreFocus(document.body);
    expect(document.activeElement).toBe(b);
    restoreFocus(a);
    expect(document.activeElement).toBe(a);
    b.remove();
    restoreFocus(b);
    expect(document.activeElement).toBe(a);
    restoreFocus(null);
  });
});

describe('popup roles, labels and focus', () => {
  const ANCHOR_RECT = { top: 0, bottom: 10, left: 0 };
  const shadow = (popup: Popup) => popup.host.shadowRoot!;
  let code: HTMLButtonElement;

  beforeEach(() => {
    // Stands in for a focused diff line.
    document.body.innerHTML = '<button id="code">line 45</button><input id="other">';
    code = document.querySelector('#code')!;
    code.focus();
  });

  it('is a labelled dialog with labelled buttons and a live region', () => {
    const popup = openPopup(ANCHOR_RECT);
    const panel = shadow(popup).querySelector('.popup')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('PR Explainer');
    expect(shadow(popup).querySelector('.close')!.getAttribute('aria-label')).toBe('Close');
    expect(shadow(popup).querySelector('.body')!.getAttribute('aria-live')).toBe('polite');
    for (const button of shadow(popup).querySelectorAll('button')) {
      expect(button.getAttribute('aria-label') ?? button.textContent).toBeTruthy();
    }
    popup.close();
  });

  it('is aria-busy only while the model is working', () => {
    const popup = openPopup(ANCHOR_RECT);
    const panel = shadow(popup).querySelector('.popup')!;
    expect(panel.getAttribute('aria-busy')).toBe('true');
    popup.showPartial('Retries');
    expect(panel.getAttribute('aria-busy')).toBe('true');
    popup.showExplanation(DONE.status === 'done' ? DONE.explanation : ({} as never));
    expect(panel.getAttribute('aria-busy')).toBe('false');
    popup.close();
  });

  it('is not busy once stopped mid-answer', () => {
    const popup = openPopup(ANCHOR_RECT);
    popup.showPartial('Retries');
    shadow(popup).querySelector<HTMLButtonElement>('.stop')!.click();
    expect(shadow(popup).querySelector('.popup')!.getAttribute('aria-busy')).toBe('false');
    popup.close();
  });

  it('moves focus into the popup when it opens', () => {
    const popup = openPopup(ANCHOR_RECT);
    expect(document.activeElement).toBe(popup.host);
    expect(shadow(popup).activeElement).toBe(shadow(popup).querySelector('.popup'));
    popup.close();
  });

  it('gives focus back to the code when closed with Esc', () => {
    const popup = openPopup(ANCHOR_RECT);
    shadow(popup)
      .querySelector('.popup')!
      .dispatchEvent(key({ key: 'Escape', composed: true }));
    expect(popup.state).toBe('closed');
    expect(document.activeElement).toBe(code);
  });

  it('gives focus back to the code when closed with the close button', () => {
    const popup = openPopup(ANCHOR_RECT);
    const close = shadow(popup).querySelector<HTMLButtonElement>('.close')!;
    close.focus();
    close.click();
    expect(document.activeElement).toBe(code);
  });

  it('leaves focus alone when the user already moved it elsewhere', () => {
    const popup = openPopup(ANCHOR_RECT);
    const other = document.querySelector<HTMLInputElement>('#other')!;
    other.focus();
    popup.close();
    expect(document.activeElement).toBe(other);
  });
});

describe('chat panel roles, labels and focus', () => {
  const SUBJECT = { filePath: 'a.ts', startLine: 1 };
  let code: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = '<button id="code">line 45</button>';
    code = document.querySelector('#code')!;
    code.focus();
  });

  it('is a labelled dialog whose messages are a log, busy while an answer is written', () => {
    const chat = openChatPanel({ subject: SUBJECT });
    const root = chat.host.shadowRoot!;
    expect(root.querySelector('.chat')!.getAttribute('role')).toBe('dialog');
    expect(root.querySelector('.chat')!.getAttribute('aria-label')).toBe('PR Explainer chat');
    expect(root.querySelector('.close')!.getAttribute('aria-label')).toBe('Close chat');
    expect(root.querySelector('.input')!.getAttribute('aria-label')).toBe('Your question');
    const log = root.querySelector('.messages')!;
    expect(log.getAttribute('role')).toBe('log');
    expect(log.getAttribute('aria-busy')).toBe('false');
    chat.setBusy(true);
    expect(log.getAttribute('aria-busy')).toBe('true');
    chat.setBusy(false);
    expect(log.getAttribute('aria-busy')).toBe('false');
    chat.close();
  });

  it('closes on Esc from the text box and gives focus back to the code', () => {
    const onClose = vi.fn();
    const chat = openChatPanel({ subject: SUBJECT, onClose });
    chat.focus();
    const input = chat.host.shadowRoot!.querySelector('.input')!;
    input.dispatchEvent(key({ key: 'Escape', composed: true }));
    expect(chat.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(code);
  });

  it('stays open on Esc that cancels an input method word', () => {
    const chat = openChatPanel({ subject: SUBJECT });
    chat.focus();
    chat.host
      .shadowRoot!.querySelector('.input')!
      .dispatchEvent(key({ key: 'Escape', isComposing: true, composed: true }));
    expect(chat.isOpen).toBe(true);
    chat.close();
  });
});

const layouts = [
  {
    name: 'classic',
    file: 'github-diff-classic.html',
    code: (id: string) =>
      document
        .querySelector(`[id="${ANCHOR}${id}"]`)!
        .closest('tr')!
        .querySelector<HTMLElement>('.blob-code-inner')!,
  },
  {
    name: 'new (React)',
    file: 'github-diff-new.html',
    code: (id: string) =>
      document.querySelector<HTMLElement>(
        `td[data-line-anchor="${ANCHOR}${id}"] .diff-text-inner`,
      )!,
  },
];

function setup(isEnabled?: () => boolean) {
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
        elapsedMs: 0,
        showLoading: () => {},
        showPartial: () => {},
        showExplanation: () => {},
        showError: () => {},
        showPrompt: () => {},
        showTimings: () => {},
        close: () => hooks.onClose(),
      } as Popup;
    },
  };
  const uninstall = installSelection(deps);
  return { deps, contexts, anchors, uninstall };
}

describe.each(layouts)('Alt+E on the $name layout', ({ file, code }) => {
  let env: ReturnType<typeof setup>;
  const row = (id: string) => code(id).closest('tr')!;
  /** The line's code cell, focusable like the cells of GitHub's newer view. */
  const focusLine = (id: string) => {
    const cell = code(id).closest('td')!;
    if (!cell.hasAttribute('tabindex')) cell.tabIndex = -1;
    cell.focus();
    return cell;
  };
  const press = (target: EventTarget, init: KeyboardEventInit = ALT_E) => {
    const event = key(init);
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    document.body.innerHTML = fixture(file);
    for (const id of ['R43', 'L44', 'R44', 'R45']) {
      const n = Number(id.slice(1));
      row(id).getBoundingClientRect = () => ({ top: n, bottom: n, left: 0 }) as DOMRect;
    }
  });
  afterEach(() => env?.uninstall());

  it('explains the focused line in a popup next to it, and stops the key', () => {
    env = setup();
    const cell = focusLine('R45');
    const event = press(cell);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0]).toContain('Clicked line: context, line 45 of the new file');
    expect(env.anchors[0]).toBe(row('R45'));
    expect(event.defaultPrevented).toBe(true);
  });

  it('explains the line holding the text cursor', () => {
    env = setup();
    document.getSelection()!.collapse(code('L44').firstChild, 1);
    press(document.body);
    expect(env.contexts[0]).toContain('Clicked line: removed, line 44 of the old file');
  });

  it('explains a block selected across lines, highlighted until its popup closes', () => {
    env = setup();
    const range = document.createRange();
    range.setStart(code('R43').firstChild!, 0);
    range.setEnd(code('R45').firstChild!, 1);
    document.getSelection()!.addRange(range);
    press(document.body);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0]).toContain('Selection: 4 lines');
    expect(document.querySelectorAll(`tr[${SELECTED_ATTR}]`)).toHaveLength(4);
    expect(document.getElementById(SELECTION_UI_ID)).toBeNull();
  });

  it('presses Explain selection when a block is already selected', () => {
    env = setup();
    const down = (target: Element, shiftKey = false) => {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, shiftKey }));
      }
    };
    down(code('R43'));
    down(code('R45'), true);
    expect(document.getElementById(SELECTION_UI_ID)).not.toBeNull();
    press(document.body);
    expect(env.contexts).toHaveLength(1);
    expect(env.contexts[0]).toContain('Selection: 4 lines');
    expect(document.getElementById(SELECTION_UI_ID)).toBeNull();
  });

  it('does nothing, and lets the key through, off a line', () => {
    env = setup();
    const event = press(document.body);
    expect(env.contexts).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing while typing in a text box', () => {
    env = setup();
    document.getSelection()!.collapse(code('R45').firstChild, 1);
    const box = document.createElement('textarea');
    document.body.append(box);
    box.focus();
    const event = press(box);
    expect(env.contexts).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing for AltGr+E, or while click-to-explain is off', () => {
    env = setup(() => false);
    const cell = focusLine('R45');
    press(cell);
    env.uninstall();
    env = setup();
    press(cell, { ...ALT_E, ctrlKey: true });
    expect(env.contexts).toHaveLength(0);
  });

  it('stops listening once removed', () => {
    env = setup();
    env.uninstall();
    press(focusLine('R45'));
    expect(env.contexts).toHaveLength(0);
  });
});
