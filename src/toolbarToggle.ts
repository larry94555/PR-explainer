// The toolbar button. Clicking the PR Explainer icon turns click-to-explain
// on or off for every tab, saves the choice, and shows "ON" or "OFF" on the
// icon. Content scripts hear about the change through chrome.storage (see
// src/enabledState.ts) and stop or start opening popups.
//
// Runs in the service worker. Chrome and storage are passed in so the tests
// can use fakes.

import type { LocalStorageLike } from './enabledState';

// Copies of the key and default in src/enabledState.ts (the content script
// cannot share code with this entry). toggle.test.ts checks they match.
export const ENABLED_KEY = 'clickToExplain.enabled';
export const DEFAULT_ENABLED = true;

// The part of chrome.action this code uses.
export interface ActionLike {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setTitle(details: { title: string }): Promise<void>;
  onClicked: { addListener(listener: () => void): void };
}

export interface ActionBadge {
  text: string;
  color: string;
  title: string;
}

/** What the icon shows for each state. */
export function actionBadge(enabled: boolean): ActionBadge {
  return enabled
    ? { text: 'ON', color: '#1a7f37', title: 'PR Explainer is on. Click to turn it off.' }
    : { text: 'OFF', color: '#6e7781', title: 'PR Explainer is off. Click to turn it on.' };
}

export async function showActionBadge(action: ActionLike, enabled: boolean): Promise<void> {
  const badge = actionBadge(enabled);
  await Promise.all([
    action.setBadgeText({ text: badge.text }),
    action.setBadgeBackgroundColor({ color: badge.color }),
    action.setTitle({ title: badge.title }),
  ]);
}

async function readEnabled(storage: LocalStorageLike): Promise<boolean> {
  const value = (await storage.get([ENABLED_KEY]))[ENABLED_KEY];
  return typeof value === 'boolean' ? value : DEFAULT_ENABLED;
}

/** Flips the saved state and returns the new one. */
export async function toggleEnabled(storage: LocalStorageLike): Promise<boolean> {
  const next = !(await readEnabled(storage));
  await storage.set({ [ENABLED_KEY]: next });
  return next;
}

/**
 * Shows the saved state on the icon and toggles it on each click. Returns a
 * promise that settles when the startup badge is drawn and every click so far
 * has been handled (used by tests and the dev helper).
 *
 * Clicks are handled one at a time, so two quick clicks always end where they
 * started instead of both reading the same old state.
 */
export function setupToolbarToggle(deps: { action: ActionLike; storage: LocalStorageLike }): {
  idle(): Promise<void>;
} {
  const { action, storage } = deps;
  let queue: Promise<void> = Promise.resolve();
  const run = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((error: unknown) => {
      console.warn('[PR Explainer] toolbar toggle failed', error);
    });
  };
  // Listeners must be added on the worker's first run (see background.ts).
  action.onClicked.addListener(() =>
    run(async () => showActionBadge(action, await toggleEnabled(storage))),
  );
  // Chrome forgets the badge when the browser restarts, so draw it each time
  // the worker starts.
  run(async () => showActionBadge(action, await readEnabled(storage)));
  return { idle: () => queue };
}
