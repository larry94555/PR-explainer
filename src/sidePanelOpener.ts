// Opens the chat in Chrome's side panel (PR 11.8), in the service worker.
//
// Chrome opens a side panel only in answer to something the user did, so
// chrome.sidePanel.open is called at once, before anything is awaited: from
// the popup's Ask a question button (the `openSidePanel` request) and from
// the toolbar button's right-click menu item Open chat. Either can fail (an
// older Chrome, or Chrome not counting it as the user's action): the request
// then answers with the reason, and the page opens the chat on the page.
//
// The menu item is shown while Chat opens in is Side panel. It is made after
// the debug window's item (src/debug/debugWindowOpener.ts), which first
// removes every item the extension had.
//
// Chrome's APIs are passed in so the tests can use fakes.

import type { OpenSidePanelResult } from './chat/sidePanelChat';
import type { StorageChangedLike } from './debug/debugLog';
import type { ContextMenusLike } from './debug/debugWindowOpener';
import { storageKey } from './settings';

export const CHAT_MENU_ID = 'open-chat';
export const CHAT_MENU_TITLE = 'Open chat';

/** The part of chrome.sidePanel used here (Chrome 116 and later). */
export interface SidePanelLike {
  open(options: { tabId?: number; windowId?: number }): Promise<void>;
}

/** Where to open it: the tab a request came from, or the window of a menu click. */
export type SidePanelTarget = { tabId: number } | { windowId: number };

function failed(error: unknown): OpenSidePanelResult {
  const reason = error instanceof Error ? error.message : String(error);
  return { opened: false, reason: reason || 'no reason given' };
}

/**
 * Opens the side panel. Calls chrome.sidePanel.open before returning, so it
 * still counts as the user's action. Never throws: a failure is the result.
 */
export function openSidePanel(
  sidePanel: SidePanelLike | undefined,
  target: SidePanelTarget | undefined,
): Promise<OpenSidePanelResult> {
  if (typeof sidePanel?.open !== 'function') {
    return Promise.resolve({ opened: false, reason: 'this version of Chrome has no side panel' });
  }
  if (!target) return Promise.resolve({ opened: false, reason: 'no tab to open it for' });
  let opening: Promise<void>;
  try {
    opening = sidePanel.open(target);
  } catch (error) {
    return Promise.resolve(failed(error));
  }
  return Promise.resolve(opening).then(
    () => ({ opened: true as const }),
    (error: unknown) => failed(error),
  );
}

/**
 * Adds Open chat to the toolbar button's right-click menu, shown while Chat
 * opens in is Side panel. `after` is the debug menu's setup, which removes
 * every item first. Returns a promise that settles once the item is made.
 */
export function setupChatMenu(deps: {
  menus: ContextMenusLike;
  sidePanel: SidePanelLike | undefined;
  onChanged: StorageChangedLike;
  isOn(): Promise<boolean>;
  after: Promise<unknown>;
}): Promise<void> {
  const { menus, onChanged } = deps;
  // Listeners must be added on the worker's first run (see background.ts).
  menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CHAT_MENU_ID) return;
    const target = tab?.windowId !== undefined ? { windowId: tab.windowId } : undefined;
    void openSidePanel(deps.sidePanel, target).then((result) => {
      if (!result.opened) console.warn(`[PR Explainer] could not open the chat: ${result.reason}`);
    });
  });
  const made = deps.after
    .catch(() => undefined)
    .then(async () => {
      let visible = true;
      try {
        visible = await deps.isOn();
      } catch {
        // Shown, as for the default.
      }
      menus.create({ id: CHAT_MENU_ID, title: CHAT_MENU_TITLE, contexts: ['action'], visible });
    })
    .catch((error: unknown) => {
      console.warn('[PR Explainer] could not add the Open chat menu item', error);
    });
  const key = storageKey('chatOpensIn');
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    const visible = changes[key]?.newValue !== 'page';
    void made.then(() => menus.update(CHAT_MENU_ID, { visible })).catch(() => undefined);
  });
  return made;
}
