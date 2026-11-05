// Keyboard shortcuts and the right-click menu (PR 11.9), in the service worker.
//
// The manifest declares two commands, so Chrome lists them on
// chrome://extensions/shortcuts where they can be changed:
// - Explain (suggested Ctrl+Shift+E, Command+Shift+E on macOS): the PR tab
//   explains the selected block, or the line that has keyboard focus or holds
//   the text cursor, as Alt+E did when the page handled it (PR 7.3). Chrome
//   does not give an extension Alt+E by itself, as that key opens Chrome's
//   menu on Windows and Linux, but it can be set to Alt+E on Chrome's page.
// - Open chat (no key until one is set): opens the chat in Chrome's side
//   panel (PR 11.8), or on the page when Chat opens in is On the page or
//   Chrome refuses the side panel.
// A command reaches the active tab only while it shows a GitHub PR.
//
// A right-click on a PR page gets Explain with PR Explainer, which explains
// what was right-clicked: the selected lines, or the line under the pointer.
// The page knows which (src/tabCommands.ts); Chrome cannot show a menu item
// only over diff lines, so it is on every PR page, and a right-click off the
// diff says so.
//
// Chrome's APIs are passed in so the tests can use fakes.

import type { StorageChangedLike } from './debug/debugLog';
import type { ContextMenusLike } from './debug/debugWindowOpener';
import type { TabCommand, TabCommandType } from './messaging/protocol';
import { storageKey } from './settings';
import { openSidePanel, type SidePanelLike } from './sidePanelOpener';

export const EXPLAIN_COMMAND = 'explain';
export const OPEN_CHAT_COMMAND = 'open-chat';
export const EXPLAIN_MENU_ID = 'explain-code';
export const EXPLAIN_MENU_TITLE = 'Explain with PR Explainer';
/** Where the menu item shows: a PR's pages (Conversation, Files changed, Commits). */
export const PR_PAGE_PATTERNS = ['https://github.com/*/*/pull/*'];

const COMMAND_TYPE: TabCommandType = 'pr-explainer:command';

/** True for a GitHub PR page: https://github.com/owner/repo/pull/17 and below it. */
export function isPrPage(url: string | undefined): boolean {
  return (
    url !== undefined && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/.test(url)
  );
}

/** A tab as Chrome passes it to a command or menu click. */
export interface TabLike {
  id?: number;
  url?: string;
  windowId?: number;
}

/** The part of chrome.commands used in the service worker. */
export interface CommandsLike {
  onCommand: { addListener(listener: (command: string, tab?: TabLike) => void): void };
}

/** The part of chrome.tabs used here. */
export interface CommandTabsLike {
  query(info: { active: boolean; currentWindow: boolean }): Promise<TabLike[]>;
  sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
}

/** Where the chat opens: Chat opens in (PR 11.8). */
export type ChatPlace = 'sidepanel' | 'page';

/** Sends `command` to the page in tab `tabId` (its top frame, where the content script runs). */
function sendToTab(tabs: CommandTabsLike, tabId: number, command: TabCommand): void {
  tabs.sendMessage(tabId, command, { frameId: 0 }).catch((error: unknown) => {
    // A tab opened before the extension was loaded has no content script yet.
    console.warn(`[PR Explainer] could not send ${command.command} to the tab`, error);
  });
}

/**
 * Follows Chat opens in without reading storage when a key is pressed, since
 * the side panel must be opened before anything is awaited. Side panel (the
 * default) until the setting is read.
 */
export function followChatPlace(
  storage: { get(keys: string[]): Promise<Record<string, unknown>> },
  onChanged: StorageChangedLike,
): { current(): ChatPlace } {
  const key = storageKey('chatOpensIn');
  const placeOf = (value: unknown): ChatPlace => (value === 'page' ? 'page' : 'sidepanel');
  let current: ChatPlace = 'sidepanel';
  let changed = false;
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    changed = true;
    current = placeOf(changes[key]?.newValue);
  });
  storage.get([key]).then(
    (stored) => {
      if (!changed) current = placeOf(stored[key]);
    },
    () => undefined,
  );
  return { current: () => current };
}

/** Sends the Explain and Open chat shortcuts to the active tab, while it shows a PR. */
export function setupCommands(deps: {
  commands: CommandsLike | undefined;
  tabs: CommandTabsLike;
  sidePanel: SidePanelLike | undefined;
  chatPlace(): ChatPlace;
}): void {
  const { tabs } = deps;
  const openChat = (tab: TabLike & { id: number }) => {
    if (deps.chatPlace() === 'page') {
      sendToTab(tabs, tab.id, { type: COMMAND_TYPE, command: 'open-chat' });
      return;
    }
    // Called before anything is awaited, so Chrome counts the key press.
    void openSidePanel(deps.sidePanel, { tabId: tab.id }).then((result) => {
      if (result.opened) return;
      sendToTab(tabs, tab.id, { type: COMMAND_TYPE, command: 'open-chat', reason: result.reason });
    });
  };
  const run = (command: string, tab: TabLike) => {
    if (tab.id === undefined || !isPrPage(tab.url)) return;
    const withId = { ...tab, id: tab.id };
    if (command === EXPLAIN_COMMAND) {
      sendToTab(tabs, withId.id, { type: COMMAND_TYPE, command: 'explain' });
    } else if (command === OPEN_CHAT_COMMAND) {
      openChat(withId);
    }
  };
  // Listeners must be added on the worker's first run (see background.ts).
  deps.commands?.onCommand.addListener((command, tab) => {
    if (tab) {
      run(command, tab);
      return;
    }
    // An older Chrome passes no tab: ask which one is active.
    void tabs.query({ active: true, currentWindow: true }).then(
      ([active]) => {
        if (active) run(command, active);
      },
      () => undefined,
    );
  });
}

/**
 * Adds Explain with PR Explainer to the right-click menu of PR pages.
 * `after` is the setup of the toolbar button's items, the first of which
 * removes every item first. Returns a promise that settles once it is made.
 */
export function setupExplainMenu(deps: {
  menus: ContextMenusLike;
  tabs: CommandTabsLike;
  after: Promise<unknown>;
}): Promise<void> {
  const { menus, tabs } = deps;
  menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== EXPLAIN_MENU_ID || tab?.id === undefined) return;
    if (!isPrPage(info.pageUrl ?? tab.url)) return;
    sendToTab(tabs, tab.id, { type: COMMAND_TYPE, command: 'explain-at-pointer' });
  });
  return deps.after
    .catch(() => undefined)
    .then(() => {
      menus.create({
        id: EXPLAIN_MENU_ID,
        title: EXPLAIN_MENU_TITLE,
        contexts: ['page', 'selection'],
        documentUrlPatterns: PR_PAGE_PATTERNS,
        visible: true,
      });
    })
    .catch((error: unknown) => {
      console.warn('[PR Explainer] could not add the Explain menu item', error);
    });
}
