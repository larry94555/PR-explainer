// Background work on battery, in the service worker (PR 11.3). Each PR tab's
// content script reads the charging state (src/batteryState.ts, since the
// service worker cannot) and says whether background work is paused. While
// any open tab says so, the background queue starts no new hover or Explain
// ahead job (src/explain/prefetchQueue.ts) and the toolbar icon shows the
// pause (src/toolbarToggle.ts). Closing a tab forgets what it said.
//
// What the tabs said is kept in chrome.storage.session, so the pause holds
// when Chrome stops this worker and starts it again.

/** The chrome.storage.session key holding the tabs that said they are paused. */
export const PAUSED_TABS_KEY = 'backgroundPause.tabs';

/** The part of chrome.storage.session this code uses. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface BackgroundPause {
  /** What a tab says: paused or not. */
  report(tab: number, paused: boolean): void;
  /** Forgets a closed tab. */
  forgetTab(tab: number): void;
  /** True while any tab says background work is paused. */
  paused(): boolean;
  /** Settles once what was kept from before is read (for tests). */
  ready: Promise<void>;
}

export function createBackgroundPause(deps: {
  storage: SessionStorageLike;
  /** Hears each change of paused(), including one read back on start. */
  onChange(paused: boolean): void;
}): BackgroundPause {
  const tabs = new Set<number>();
  // Tabs that spoke since this worker started: what they said wins over what was kept.
  const heard = new Set<number>();
  let last = false;

  const changed = () => {
    const now = tabs.size > 0;
    if (now === last) return;
    last = now;
    deps.onChange(now);
  };
  const save = () => {
    deps.storage.set({ [PAUSED_TABS_KEY]: [...tabs] }).catch(() => {
      // Only a worker restart misses it.
    });
  };

  const ready = deps.storage.get([PAUSED_TABS_KEY]).then(
    (stored) => {
      const kept = stored[PAUSED_TABS_KEY];
      if (!Array.isArray(kept)) return;
      for (const tab of kept) {
        if (typeof tab === 'number' && !heard.has(tab)) tabs.add(tab);
      }
      changed();
    },
    () => undefined,
  );

  return {
    report(tab, paused) {
      heard.add(tab);
      if (paused === tabs.has(tab)) return;
      if (paused) tabs.add(tab);
      else tabs.delete(tab);
      save();
      changed();
    },
    forgetTab(tab) {
      heard.add(tab);
      if (!tabs.delete(tab)) return;
      save();
      changed();
    },
    paused: () => tabs.size > 0,
    ready,
  };
}

/** The part of chrome.tabs.onUpdated forgetTabOnLoad uses. */
export interface TabUpdatedLike {
  addListener(listener: (tabId: number, changeInfo: { status?: string }) => void): void;
}

/**
 * Lets go of a tab's pause when it loads a new page: a reload, or moving to
 * a site without the content script. Its old content script is gone and
 * cannot say it no longer holds the pause; the new page says again if it
 * does (review on #71). GitHub's own page changes load no page, and the
 * content script reports those itself.
 */
export function forgetTabOnLoad(onUpdated: TabUpdatedLike, pause: BackgroundPause): void {
  onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') pause.forgetTab(tabId);
  });
}
