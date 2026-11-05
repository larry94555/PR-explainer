// Keyboard shortcuts on the settings page (PR 11.9).
//
// The Explain and Open chat shortcuts are Chrome commands (src/commands.ts),
// so only Chrome's own page, chrome://extensions/shortcuts, can change them.
// This section shows the keys they have now, read again whenever the page
// comes back into view (after a visit to Chrome's page), and a button that
// opens Chrome's page: a link to a chrome:// address does nothing when
// clicked, so it is opened as a new tab.

/** One command as chrome.commands.getAll gives it. */
export interface CommandInfo {
  name?: string;
  description?: string;
  /** The key, such as "Alt+E", or empty when none is set. */
  shortcut?: string;
}

export interface ShortcutsDeps {
  /** chrome.commands.getAll. */
  getAll(): Promise<CommandInfo[]>;
  /** Opens a tab; used for chrome://extensions/shortcuts. */
  openTab(url: string): Promise<unknown>;
}

export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

/** The commands shown, in order, with the names this page gives them. */
export const SHORTCUT_ROWS = [
  { name: 'explain', label: 'Explain the focused line or the selected lines' },
  { name: 'open-chat', label: 'Open chat' },
] as const;

export const NOT_SET = 'Not set';
/** Shown when Chrome did not give Explain its suggested key. */
export const EXPLAIN_NOT_SET_NOTE =
  'Chrome did not give Explain a key, which happens when another extension already uses ' +
  'Ctrl+Shift+E. Click Change shortcuts and set one, such as Alt+E.';

export interface Shortcuts {
  /** Reads the keys again and shows them. */
  refresh(): Promise<void>;
}

function el<T extends HTMLElement>(doc: Document, id: string): T {
  const found = doc.getElementById(id);
  if (!found) throw new Error(`options.html is missing #${id}`);
  return found as T;
}

/** Fills the Keyboard shortcuts section and keeps it up to date. */
export function initShortcuts(doc: Document, deps: ShortcutsDeps): Shortcuts {
  const list = el(doc, 'shortcut-list');
  const note = el(doc, 'shortcut-note');
  const button = el<HTMLButtonElement>(doc, 'change-shortcuts');

  const show = (commands: CommandInfo[] | null) => {
    list.replaceChildren();
    for (const row of SHORTCUT_ROWS) {
      const key = commands?.find((command) => command.name === row.name)?.shortcut ?? '';
      const term = doc.createElement('dt');
      term.textContent = row.label;
      const value = doc.createElement('dd');
      value.dataset.command = row.name;
      if (key) {
        const kbd = doc.createElement('kbd');
        kbd.textContent = key;
        value.append(kbd);
      } else {
        value.textContent = commands ? NOT_SET : 'Unknown';
        value.className = 'unset';
      }
      list.append(term, value);
    }
    const explainSet = commands?.some((command) => command.name === 'explain' && command.shortcut);
    note.textContent = commands && !explainSet ? EXPLAIN_NOT_SET_NOTE : '';
    note.hidden = note.textContent === '';
  };

  const refresh = async () => {
    let commands: CommandInfo[] | null;
    try {
      commands = await deps.getAll();
    } catch {
      commands = null;
    }
    show(commands);
  };

  button.addEventListener('click', () => {
    deps.openTab(SHORTCUTS_URL).catch((error: unknown) => {
      console.warn('[PR Explainer] could not open the shortcuts page', error);
    });
  });
  // Back from Chrome's shortcuts page: show what was changed there.
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') void refresh();
  });
  doc.defaultView?.addEventListener('focus', () => void refresh());

  void refresh();
  return { refresh };
}
