// The toolbar button. Clicking the PR Explainer icon turns click-to-explain
// on or off for every tab, saves the choice, and shows "ON" or "OFF" on the
// icon. Content scripts hear about the change through chrome.storage (see
// src/enabledState.ts) and stop or start opening popups.
//
// While Explain ahead's Whole PR works in a tab, the icon shows that tab's
// progress instead ("37%", then a tick when done), with the line counts in
// its tooltip (PR 10.7, showAheadProgress). Chrome keeps these per tab, so
// other tabs still show ON or OFF.
//
// While background work is paused on battery (PR 11.3, src/backgroundPause.ts)
// and click-to-explain is on, every tab shows "⏸" instead, with the reason
// in its tooltip (showPaused).
//
// Runs in the service worker. Chrome and storage are passed in so the tests
// can use fakes.

import type { LocalStorageLike } from './enabledState';
import type { AheadProgress } from './explainAhead';

// Copies of the key and default in src/enabledState.ts (the content script
// cannot share code with this entry). toggle.test.ts checks they match.
export const ENABLED_KEY = 'clickToExplain.enabled';
export const DEFAULT_ENABLED = true;

// The part of chrome.action this code uses. With `tabId`, a value is for
// that tab only.
export interface ActionLike {
  setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
  setTitle(details: { title: string; tabId?: number }): Promise<void>;
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

/** Whole PR's progress colours: blue while working, green when done. */
export const PROGRESS_COLOR = '#0969da';
export const DONE_COLOR = '#1a7f37';

/**
 * What the icon shows for Whole PR's progress in a tab (PR 10.7): the share
 * done, rounded down so it says 100% only when every line is done (then a
 * tick), and the counts in the tooltip, above the usual on or off line.
 */
export function progressBadge(progress: AheadProgress, enabled: boolean): ActionBadge {
  const { done, total, limited } = progress;
  const complete = done >= total;
  const lines = `changed line${total === 1 ? '' : 's'}`;
  const counts = complete
    ? `Explained all ${total} ${lines}`
    : `Explained ${done} of ${total} ${lines}` +
      (limited !== undefined ? ` (stopped at the ${limited}-line limit)` : '');
  return {
    text: complete ? '✓' : `${Math.min(99, Math.floor((done / total) * 100))}%`,
    color: complete ? DONE_COLOR : PROGRESS_COLOR,
    title: `${counts}\n${actionBadge(enabled).title}`,
  };
}

/** The pause's colour (PR 11.3): GitHub's attention yellow. */
export const PAUSED_COLOR = '#9a6700';
export const PAUSED_TITLE = 'Background work paused: on battery';

/**
 * What the icon shows while background work is paused on battery (PR 11.3),
 * above the usual on line. Click-to-explain off shows OFF instead.
 */
export function pausedBadge(enabled: boolean): ActionBadge {
  if (!enabled) return actionBadge(false);
  return { text: '⏸', color: PAUSED_COLOR, title: `${PAUSED_TITLE}\n${actionBadge(true).title}` };
}

async function draw(action: ActionLike, badge: ActionBadge, tabId?: number): Promise<void> {
  const tab = tabId === undefined ? {} : { tabId };
  await Promise.all([
    action.setBadgeText({ text: badge.text, ...tab }),
    action.setBadgeBackgroundColor({ color: badge.color, ...tab }),
    action.setTitle({ title: badge.title, ...tab }),
  ]);
}

export async function showActionBadge(action: ActionLike, enabled: boolean): Promise<void> {
  await draw(action, actionBadge(enabled));
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
  /**
   * Shows Whole PR's progress on the icon for `tabId`, or puts back the on
   * or off look there when `progress` is null (PR 10.7).
   */
  showProgress(tabId: number, progress: AheadProgress | null): Promise<void>;
  /**
   * Shows or clears the pause on battery (PR 11.3) on the icon, for every
   * tab, over Whole PR's progress.
   */
  showPaused(paused: boolean): Promise<void>;
  /** Forgets a closed tab. */
  forgetTab(tabId: number): void;
} {
  const { action, storage } = deps;
  let queue: Promise<void> = Promise.resolve();
  const run = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((error: unknown) => {
      console.warn('[PR Explainer] toolbar toggle failed', error);
    });
  };
  // Tabs given a look of their own, with the progress they show (null once
  // cleared). Chrome keeps a tab's look until it is set again, so a click on
  // the button redraws these too.
  const tabs = new Map<number, AheadProgress | null>();
  // Background work paused on battery (PR 11.3): shown over everything else.
  let paused = false;
  const drawAll = (enabled: boolean) =>
    draw(action, paused ? pausedBadge(enabled) : actionBadge(enabled));
  const drawTab = (tabId: number, enabled: boolean) => {
    const progress = tabs.get(tabId);
    return draw(
      action,
      paused
        ? pausedBadge(enabled)
        : progress
          ? progressBadge(progress, enabled)
          : actionBadge(enabled),
      tabId,
    ).catch(() => {
      // The tab has closed.
      tabs.delete(tabId);
    });
  };
  // Listeners must be added on the worker's first run (see background.ts).
  action.onClicked.addListener(() =>
    run(async () => {
      const enabled = await toggleEnabled(storage);
      await drawAll(enabled);
      await Promise.all([...tabs.keys()].map((tabId) => drawTab(tabId, enabled)));
    }),
  );
  // Chrome forgets the badge when the browser restarts, so draw it each time
  // the worker starts.
  run(async () => drawAll(await readEnabled(storage)));
  return {
    idle: () => queue,
    showProgress: (tabId, progress) => {
      run(async () => {
        // A clear always draws, even for a tab this worker never drew: Chrome
        // keeps a tab's look after the worker restarts (review on #66).
        tabs.set(tabId, progress);
        await drawTab(tabId, await readEnabled(storage));
      });
      return queue;
    },
    showPaused: (value) => {
      run(async () => {
        if (value === paused) return;
        paused = value;
        const enabled = await readEnabled(storage);
        await drawAll(enabled);
        await Promise.all([...tabs.keys()].map((tabId) => drawTab(tabId, enabled)));
      });
      return queue;
    },
    forgetTab: (tabId) => void tabs.delete(tabId),
  };
}
