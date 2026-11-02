// Explain on hover (PR 8.7): starts explaining a diff line once the pointer
// has rested on it for PREFETCH_DELAY_MS, so the answer is ready, or partly
// written, by the time the user clicks.
//
// The prefetch goes through the same `explain` as a click, with the same
// request text (lineRequest in src/clickHandler.ts), so a finished prefetch
// is in the service worker's cache (PR 4.3) and a click shows it at once. A
// click on a line whose prefetch is still running joins it instead of
// starting a second request: the popup gets what the model has written so
// far, then the rest as it arrives.
//
// Only one prefetch runs at a time, so the laptop is not flooded:
// - Moving to another line cancels a prefetch that has not finished (unless
//   a click has joined it), and restarts the wait.
// - Nothing starts while a click's explanation is still running or the chat
//   is open (`isBusy`), or while a mouse button is held (a drag selects lines,
//   src/selection.ts).
// - A click on other code cancels the prefetch, so the click's request is the
//   only one.
// - Moving off the code (the gutter, a header, the popup) ends the wait.
// - Moving to another page, or GitHub redrawing this one, cancels it all.
// A line whose prefetch finished is not asked for again on this page.
//
// The setting is off by default. It is saved with the other settings in
// chrome.storage.sync, which the content script reads directly because it
// cannot import src/settings.ts (see src/content.ts). prefetch.test.ts checks
// that the key matches.

import { lineRequest, type ClickHandlerDeps, type ExplainRequest } from './clickHandler';
import { locateLine } from './diffDom';
import type { StorageChangedEvent } from './enabledState';
import type { ExplainStream } from './messaging/client';

/** The chrome.storage.sync key of the Explain on hover setting (storageKey('explainOnHover')). */
export const HOVER_SETTING_KEY = 'settings.explainOnHover';

/** How long the pointer rests on a line before its explanation starts. */
export const PREFETCH_DELAY_MS = 800;

/** Turns a stored value into on/off. Anything but a boolean means off (the default). */
export function toHoverEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

/** The part of chrome.storage.sync this code reads. */
export interface SyncStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
}

/**
 * Follows the Explain on hover setting: reads it, then hears about every
 * save, so turning it on or off on the settings page takes effect without
 * reloading the PR. It is off until the read answers, and stays off if the
 * read fails. A save that arrives while the read is pending wins.
 */
export function trackHoverSetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
  onChange?: (on: boolean) => void,
): { current(): boolean } {
  let current = false;
  let changed = false;
  events.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, HOVER_SETTING_KEY)) return;
    changed = true;
    current = toHoverEnabled(changes[HOVER_SETTING_KEY]?.newValue);
    onChange?.(current);
  });
  storage.get([HOVER_SETTING_KEY]).then(
    (stored) => {
      if (changed) return;
      current = toHoverEnabled(stored[HOVER_SETTING_KEY]);
      onChange?.(current);
    },
    (error: unknown) => console.warn('[PR Explainer] could not read Explain on hover', error),
  );
  return { current: () => current };
}

/** A diff line under the pointer: a name for it, and how to build its request. */
export interface HoveredLine {
  /** Names the line, such as "src/a.ts:added:12". The same line gives the same key. */
  key: string;
  /** The request a click on this line would send. Built only when the prefetch starts. */
  request(): ExplainRequest | null;
}

/** The line `target` is on, read from GitHub's diff (src/diffDom.ts), or null. */
export function hoveredLine(target: EventTarget | null): HoveredLine | null {
  const line = locateLine(target);
  if (!line) return null;
  return {
    key: `${line.filePath}:${line.side}:${line.lineNumber}`,
    request: () => lineRequest(target)?.request ?? null,
  };
}

export type PrefetchEvent =
  | { type: 'started'; key: string }
  | { type: 'cancelled'; key: string }
  | { type: 'joined'; key: string; elapsedMs: number }
  | { type: 'finished'; key: string; elapsedMs: number; status: 'done' | 'failed' };

export interface PrefetchDeps {
  /** The explain a click uses (it reaches the service worker and its cache). */
  explain: ClickHandlerDeps['explain'];
  /** The Explain on hover setting. */
  isOn(): boolean;
  /** False while the toolbar button has click-to-explain off. Leaving it out means on. */
  isEnabled?(): boolean;
  /** True while a click's explanation is running or the chat is open. */
  isBusy?(): boolean;
  /** The line under the pointer. Defaults to hoveredLine; tests pass a fake. */
  locate?(target: EventTarget | null): HoveredLine | null;
  delayMs?: number;
  /** Clock in milliseconds, for the events. Defaults to performance.now. */
  now?(): number;
  /** Called as prefetches start, end, are cancelled or joined (logging). */
  onEvent?(event: PrefetchEvent): void;
}

export interface Prefetcher {
  /** The document's `mouseover` listener: starts the wait for a newly hovered line. */
  onMouseOver(event: MouseEvent): void;
  /** The document's `mousedown` listener: a press (click or drag) ends the wait. */
  onMouseDown(): void;
  /**
   * Use in place of `deps.explain` for clicks: joins a running prefetch of
   * the same text, and otherwise cancels any prefetch and asks as usual.
   */
  explain: ClickHandlerDeps['explain'];
  /** Ends the wait and cancels a prefetch no click has joined (leaving the page, turning off). */
  cancel(): void;
  /**
   * For every page change or redraw: ends the wait, stops a prefetch no click
   * has joined (its code may be gone), and forgets which lines were already
   * prefetched (the page's code may have changed).
   */
  pageChanged(): void;
  /** The line being prefetched, if any (for tests and logging). */
  running(): string | undefined;
}

interface Running {
  key: string;
  text: string;
  stream: ExplainStream;
  chunks: string[];
  startedAt: number;
  /** The joined click's onChunk, once it has been given the text so far. */
  listener?: (text: string) => void;
  joined: boolean;
}

export function createPrefetcher(deps: PrefetchDeps): Prefetcher {
  const delayMs = deps.delayMs ?? PREFETCH_DELAY_MS;
  const locate = deps.locate ?? hoveredLine;
  const now = deps.now ?? (() => performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The line the pointer is on, so moving inside it does not restart the wait.
  let hoverKey: string | undefined;
  let current: Running | undefined;
  const done = new Set<string>();

  const active = () => deps.isOn() && deps.isEnabled?.() !== false && deps.isBusy?.() !== true;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  /** Stops the running prefetch unless a click has joined it. */
  const cancelRunning = () => {
    if (!current || current.joined) return;
    const { key, stream } = current;
    current = undefined;
    stream.stop();
    deps.onEvent?.({ type: 'cancelled', key });
  };

  const start = (line: HoveredLine) => {
    if (current || done.has(line.key) || !active()) return;
    const request = line.request();
    if (!request) return;
    const run: Running = {
      key: line.key,
      text: request.text,
      chunks: [],
      startedAt: now(),
      joined: false,
      // Set just below; no chunk can arrive before explain returns.
      stream: undefined as unknown as ExplainStream,
    };
    run.stream = deps.explain(
      request.text,
      (chunk) => {
        run.chunks.push(chunk);
        run.listener?.(chunk);
      },
      { fresh: false, ...(request.code && { code: request.code }) },
    );
    current = run;
    deps.onEvent?.({ type: 'started', key: run.key });
    const finish = (status: 'done' | 'failed') => {
      if (current !== run) return;
      current = undefined;
      // A finished answer is in the cache; a failed one may work on a click.
      if (status === 'done') done.add(run.key);
      deps.onEvent?.({ type: 'finished', key: run.key, elapsedMs: now() - run.startedAt, status });
    };
    run.stream.result.then(
      (result) => finish(result.status),
      () => finish('failed'),
    );
  };

  const onMouseOver = (event: MouseEvent) => {
    // A held button means a drag (selecting lines), not reading.
    if (event.buttons !== 0) {
      clearTimer();
      return;
    }
    const line = locate(event.target);
    // Off the code (the popup, the gutter, a header): the pointer is no longer
    // resting on a line, so the wait ends. A running prefetch keeps going, so
    // moving to the popup or the line number to click does not lose it.
    if (!line) {
      clearTimer();
      hoverKey = undefined;
      return;
    }
    if (line.key === hoverKey) return;
    hoverKey = line.key;
    clearTimer();
    if (current && current.key !== line.key) cancelRunning();
    if (!deps.isOn()) return;
    timer = setTimeout(() => {
      timer = undefined;
      start(line);
    }, delayMs);
  };

  const explain: ClickHandlerDeps['explain'] = (context, onChunk, options) => {
    clearTimer();
    const run = current;
    if (run && !run.joined && !options.fresh && run.text === context) {
      run.joined = true;
      deps.onEvent?.({ type: 'joined', key: run.key, elapsedMs: now() - run.startedAt });
      let stopped = false;
      // The caller starts listening once this returns, so the text so far is
      // handed over a moment later, then each new piece as it arrives.
      queueMicrotask(() => {
        if (stopped) return;
        const soFar = run.chunks.join('');
        if (soFar) onChunk(soFar);
        run.listener = onChunk;
      });
      return {
        result: run.stream.result,
        stop: () => {
          stopped = true;
          run.listener = undefined;
          run.stream.stop();
        },
      };
    }
    cancelRunning();
    return deps.explain(context, onChunk, options);
  };

  const cancel = () => {
    clearTimer();
    hoverKey = undefined;
    cancelRunning();
  };

  return {
    onMouseOver,
    onMouseDown: clearTimer,
    explain,
    cancel,
    pageChanged: () => {
      cancel();
      done.clear();
    },
    running: () => current?.key,
  };
}
