// GitHub changes pages without a full reload: Turbo swaps the page body for
// most links, and the React views (such as the new Files changed page) call
// history.pushState. Chrome injects a content script only on a full load, so
// the script is injected on every github.com page (see public/manifest.json)
// and uses this file to notice when the page changes and to turn
// click-to-explain on and off with it (PR 7.1).

import { parsePrUrl } from './prUrl';

/** How often the address is checked, for navigations that send no event. */
export const POLL_MS = 500;

/**
 * A Turbo redraw this soon after a reported move or redraw belongs to it
 * (Turbo sends `turbo:render` and then `turbo:load` for one visit).
 */
export const REDRAW_MERGE_MS = 1000;

export interface WatchNavigationOptions {
  /**
   * Called when Turbo redraws the page without moving to another page (for
   * example after the PR's title or description is edited), so what was
   * read from the page can be read again. At most once per visit.
   */
  onRedraw?: (url: string) => void;
  pollMs?: number;
}

/** The page part of `url` (no query or hash), so a `#diff-…` jump is not a new page. */
export function pageOf(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Calls `onChange` once each time the page's address moves to another page,
 * however GitHub got there: Turbo's `turbo:load` and `turbo:render`, back and
 * forward (`popstate`), the Navigation API's `navigate` (pushState and
 * replaceState by GitHub's React views), and a check every `pollMs` for
 * anything that sends no event. A change to only the query or hash does not
 * count. A Turbo event on the same page calls `onRedraw` instead, unless a
 * move or redraw was reported in the last REDRAW_MERGE_MS. Returns a function
 * that stops watching.
 */
export function watchNavigation(
  win: Window,
  onChange: (url: string, previous: string) => void,
  { onRedraw, pollMs = POLL_MS }: WatchNavigationOptions = {},
): () => void {
  let last = win.location.href;
  let reportedAt = -Infinity;
  /** Reports a move; returns false when the page did not change. */
  const check = (): boolean => {
    const url = win.location.href;
    if (pageOf(url) === pageOf(last)) {
      last = url;
      return false;
    }
    const previous = last;
    last = url;
    reportedAt = Date.now();
    onChange(url, previous);
    return true;
  };
  const onTurbo = () => {
    if (check() || !onRedraw) return;
    if (Date.now() - reportedAt < REDRAW_MERGE_MS) return;
    reportedAt = Date.now();
    onRedraw(last);
  };
  // `navigate` fires before the address changes, so check just after it.
  const checkSoon = () => win.setTimeout(check, 0);
  const doc = win.document;
  doc.addEventListener('turbo:load', onTurbo);
  doc.addEventListener('turbo:render', onTurbo);
  win.addEventListener('popstate', check);
  const navigation = (win as Window & { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', checkSoon);
  const timer = win.setInterval(check, pollMs);
  return () => {
    doc.removeEventListener('turbo:load', onTurbo);
    doc.removeEventListener('turbo:render', onTurbo);
    win.removeEventListener('popstate', check);
    navigation?.removeEventListener('navigate', checkSoon);
    win.clearInterval(timer);
  };
}

/** True on the PR tabs that show diffs: Files changed and a PR's commits. */
export function showsDiffs(url: string): boolean {
  const tab = parsePrUrl(url)?.tab;
  return tab === 'files' || tab === 'commits';
}

/**
 * Keeps click-to-explain attached only while the page shows a PR's diffs.
 * `sync(url)` calls `attach` on entering such a page (once, however many
 * times it is called there) and the function `attach` returned on leaving.
 */
export class DiffPageFeatures {
  #detach: (() => void) | undefined;

  constructor(
    private readonly attach: () => () => void,
    private readonly wanted: (url: string) => boolean = showsDiffs,
  ) {}

  get attached(): boolean {
    return this.#detach !== undefined;
  }

  sync(url: string): void {
    if (this.wanted(url)) {
      this.#detach ??= this.attach();
    } else if (this.#detach) {
      const detach = this.#detach;
      this.#detach = undefined;
      detach();
    }
  }
}

/** Something drawn on the page, such as the popup or the chat panel. */
interface PageUi {
  readonly host: HTMLElement;
  close(): void;
}

/**
 * Closes each of `uis` that is no longer on the page, as after Turbo swapped
 * the page body: its request is stopped and later clicks do not go to it.
 */
export function closeDetached(uis: ReadonlyArray<PageUi | null | undefined>): void {
  for (const ui of uis) if (ui && !ui.host.isConnected) ui.close();
}
