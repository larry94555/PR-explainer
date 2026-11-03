// Opens the debug window (PR 9.4): debug.html in a window of its own, beside
// the PR. The popup's Debug button asks the service worker to open it
// (`openDebugWindow`), and so does the toolbar button's right-click menu item
// Open debug window, which is shown only while the Debug window setting is on.
//
// There is one debug window at a time: opening it again brings the one that
// is open to the front. Its id is kept in chrome.storage.session, so this
// still works after Chrome stops the service worker.
//
// Runs in the service worker. Chrome's APIs are passed in so the tests can use
// fakes.

import { storageKey } from '../settings';
import type { SessionStorageLike, StorageChangedLike } from './debugLog';

export const DEBUG_WINDOW_ID_KEY = 'debugWindowId';
export const DEBUG_MENU_ID = 'open-debug-window';
export const DEBUG_MENU_TITLE = 'Open debug window';

export const DEBUG_WINDOW_SIZE = { width: 760, height: 860 };

/** The part of chrome.windows used here. */
export interface WindowsLike {
  create(options: {
    url: string;
    type: 'popup';
    width: number;
    height: number;
    focused: boolean;
  }): Promise<{ id?: number } | undefined>;
  update(windowId: number, options: { focused: boolean }): Promise<unknown>;
}

export type OpenResult = 'opened' | 'focused';

export interface DebugWindowOpener {
  /** Opens the window, or brings the open one to the front. */
  open(): Promise<OpenResult>;
}

export function createDebugWindowOpener(deps: {
  windows: WindowsLike;
  storage: SessionStorageLike;
  /** debug.html's address (chrome.runtime.getURL('debug.html')). */
  url: string;
}): DebugWindowOpener {
  const { windows, storage, url } = deps;
  // One open at a time, so two quick clicks open one window.
  let queue: Promise<unknown> = Promise.resolve();
  const open = async (): Promise<OpenResult> => {
    const id = (await storage.get([DEBUG_WINDOW_ID_KEY]))[DEBUG_WINDOW_ID_KEY];
    if (typeof id === 'number') {
      try {
        await windows.update(id, { focused: true });
        return 'focused';
      } catch {
        // The window was closed: open a new one.
      }
    }
    const created = await windows.create({
      url,
      type: 'popup',
      focused: true,
      ...DEBUG_WINDOW_SIZE,
    });
    if (typeof created?.id === 'number') {
      await storage.set({ [DEBUG_WINDOW_ID_KEY]: created.id });
    }
    return 'opened';
  };
  return {
    open() {
      const run = queue.then(open);
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The part of chrome.contextMenus used here. */
export interface ContextMenusLike {
  removeAll(): Promise<void>;
  create(properties: {
    id: string;
    title: string;
    contexts: ['action'];
    visible: boolean;
  }): unknown;
  update(id: string, properties: { visible: boolean }): Promise<void>;
  onClicked: { addListener(listener: (info: { menuItemId: string | number }) => void): void };
}

/**
 * Adds Open debug window to the toolbar button's right-click menu, shown only
 * while the setting is on. Returns a promise that settles once the menu item
 * is made (for tests).
 */
export function setupDebugMenu(deps: {
  menus: ContextMenusLike;
  onChanged: StorageChangedLike;
  isOn(): Promise<boolean>;
  open(): Promise<unknown>;
}): Promise<void> {
  const { menus, onChanged } = deps;
  // Listeners must be added on the worker's first run (see background.ts).
  menus.onClicked.addListener((info) => {
    if (info.menuItemId !== DEBUG_MENU_ID) return;
    deps.open().catch((error: unknown) => {
      console.warn('[PR Explainer] could not open the debug window', error);
    });
  });
  // Made again each time the worker starts, so it is never there twice.
  const made = (async () => {
    let visible = false;
    try {
      visible = await deps.isOn();
    } catch {
      // Hidden until the setting can be read.
    }
    await menus.removeAll();
    menus.create({ id: DEBUG_MENU_ID, title: DEBUG_MENU_TITLE, contexts: ['action'], visible });
  })().catch((error: unknown) => {
    console.warn('[PR Explainer] could not add the debug window menu item', error);
  });
  const key = storageKey('debugWindow');
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    const visible = changes[key]?.newValue === true;
    void made.then(() => menus.update(DEBUG_MENU_ID, { visible })).catch(() => undefined);
  });
  return made;
}

/** The part of chrome.storage.sync read here. */
export interface SyncStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
}

/**
 * Follows the Debug window setting in the service worker without reading
 * storage for each request: undefined until the first read answers, then
 * true or false, updated on every save (PR 9.4).
 */
export function followDebugSetting(
  storage: SyncStorageLike,
  onChanged: StorageChangedLike,
): { current(): boolean | undefined } {
  const key = storageKey('debugWindow');
  let current: boolean | undefined;
  let changed = false;
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    changed = true;
    current = changes[key]?.newValue === true;
  });
  storage.get([key]).then(
    (stored) => {
      if (!changed) current = stored[key] === true;
    },
    () => undefined,
  );
  return { current: () => current };
}
