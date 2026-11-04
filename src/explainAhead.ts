// Explain ahead (PR 9.10): once a PR's Files changed tab has been still for
// AHEAD_IDLE_MS, explains the added and changed lines on screen, top to
// bottom, one at a time, so a click on one of them is answered at once from
// the service worker's cache (PR 4.3) instead of waiting for the model.
//
// Each line goes through the same `explain` as a click, with the same request
// text (lineRequest in src/clickHandler.ts), so its answer is saved under the
// key a click on that line looks up. A click on the line being explained
// joins it, as with Explain on hover (src/prefetch.ts).
//
// It keeps out of the way:
// - One line at a time, and at most AHEAD_MAX_PER_PAGE lines that the model
//   answered per page (an answer already in the cache comes back at once and
//   does not count).
// - Blank lines and lines that only close a block (`}`, `});`) are skipped.
// - Nothing starts while `isBusy` says so: a click's answer or a chat answer
//   is being written, Explain on hover is running, or the tab is hidden. It
//   checks again every AHEAD_RETRY_MS until it is free.
// - A click (or a hover prefetch) on other code stops the line being
//   explained ahead, so the model is free for it, and puts the line back at
//   the front of the queue.
// - Scrolling empties the queue and starts the wait again, so the lines on
//   screen once the page is still are the ones explained next. A line
//   already being explained keeps going.
// - A failed line ends the pass (Ollama may be down), until the next scroll.
// - Turning the setting or click-to-explain off, or leaving the page, stops it.
//
// Every request of a page shares one debug log group, so the debug window
// shows them as one "Explain ahead" group that fills in (PR 9.4).
//
// The setting is off by default. It is saved with the other settings in
// chrome.storage.sync, which the content script reads directly because it
// cannot import src/settings.ts (see src/content.ts). explainAhead.test.ts
// checks that the key matches.

import { lineRequest, type ClickHandlerDeps, type ExplainRequest } from './clickHandler';
import { addedLineCells, locateLine } from './diffDom';
import type { StorageChangedEvent } from './enabledState';
import type { ExplainStream } from './messaging/client';
import type { SyncStorageLike } from './prefetch';
import { trackSyncFlag } from './syncFlag';

/** The chrome.storage.sync key of the setting (storageKey('explainAhead')). */
export const AHEAD_SETTING_KEY = 'settings.explainAhead';

/** How long the page must be still (no scrolling) before lines are explained ahead. */
export const AHEAD_IDLE_MS = 2_000;

/** The most lines the model is asked to explain ahead on one page. */
export const AHEAD_MAX_PER_PAGE = 30;

/** While busy (a click, a chat answer, a hover, a hidden tab), how often to check again. */
export const AHEAD_RETRY_MS = 500;

/** Follows the Explain ahead setting, like the other on/off settings (src/syncFlag.ts). */
export function trackAheadSetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
  onChange?: (on: boolean) => void,
): { current(): boolean } {
  return trackSyncFlag(AHEAD_SETTING_KEY, storage, events, onChange);
}

/** A diff line to explain ahead. */
export interface AheadLine {
  /** Names the line, such as "src/a.ts:added:12", the same way Explain on hover does. */
  key: string;
  /** The line's code, to skip blank and closing lines. */
  text: string;
  /** The request a click on this line would send. Built only when its turn comes. */
  request(): ExplainRequest | null;
}

/** True when the line is worth asking about: not blank, and not only closing brackets. */
export function worthExplaining(text: string): boolean {
  return !/^[\s)}\];,]*$/.test(text);
}

/** True when some of `element` is inside the window. */
export function inViewport(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  const height = view?.innerHeight ?? 0;
  return rect.height > 0 && rect.bottom > 0 && rect.top < height;
}

/** The added lines on screen, top to bottom, read from GitHub's diff (src/diffDom.ts). */
export function visibleAddedLines(
  root: ParentNode,
  isVisible: (element: Element) => boolean = inViewport,
): AheadLine[] {
  const lines: AheadLine[] = [];
  for (const cell of addedLineCells(root)) {
    if (!isVisible(cell)) continue;
    const line = locateLine(cell);
    if (!line) continue;
    lines.push({
      key: `${line.filePath}:${line.side}:${line.lineNumber}`,
      text: line.text,
      request: () => lineRequest(cell)?.request ?? null,
    });
  }
  return lines;
}

export type AheadEvent =
  | { type: 'started'; key: string }
  | { type: 'cancelled'; key: string }
  | { type: 'joined'; key: string; elapsedMs: number }
  | {
      type: 'finished';
      key: string;
      elapsedMs: number;
      status: 'done' | 'failed';
      cached: boolean;
    }
  | { type: 'limit'; count: number };

export interface ExplainAheadDeps {
  /** The explain a click uses (it reaches the service worker and its cache). */
  explain: ClickHandlerDeps['explain'];
  /** The Explain ahead setting. */
  isOn(): boolean;
  /** False while the toolbar button has click-to-explain off. Leaving it out means on. */
  isEnabled?(): boolean;
  /** True while a click's or chat answer is being written, a hover runs, or the tab is hidden. */
  isBusy?(): boolean;
  /** The added lines on screen, top to bottom. Tests pass a fake. */
  lines(): AheadLine[];
  /** A new debug log group id, one per page. Defaults to crypto.randomUUID. */
  newGroupId?(): string;
  idleMs?: number;
  retryMs?: number;
  maxPerPage?: number;
  /** Clock in milliseconds, for the events. Defaults to performance.now. */
  now?(): number;
  /** Called as lines start, end, are cancelled or joined (logging). */
  onEvent?(event: AheadEvent): void;
}

export interface ExplainAhead {
  /**
   * Starts the wait again: when the page is shown, the setting or
   * click-to-explain is turned on, and on every scroll. The queue is built
   * from the lines on screen once the wait ends.
   */
  restart(): void;
  /**
   * Use in place of `deps.explain` for clicks and Explain on hover: joins the
   * line being explained ahead when it is the same text, and otherwise stops
   * it (it is asked again later) and asks as usual.
   */
  explain: ClickHandlerDeps['explain'];
  /** Stops the wait, the queue and a line no click has joined (turning off, leaving). */
  cancel(): void;
  /**
   * For every page change or redraw: cancels everything and forgets which
   * lines were done and how many were asked (the page's code may have changed).
   */
  pageChanged(): void;
  /** The line being explained ahead, if any. */
  running(): string | undefined;
  /** The lines waiting their turn, in order. */
  queued(): string[];
}

interface Running {
  line: AheadLine;
  text: string;
  stream: ExplainStream;
  chunks: string[];
  startedAt: number;
  listener?: (text: string) => void;
  joined: boolean;
}

export function createExplainAhead(deps: ExplainAheadDeps): ExplainAhead {
  const idleMs = deps.idleMs ?? AHEAD_IDLE_MS;
  const retryMs = deps.retryMs ?? AHEAD_RETRY_MS;
  const maxPerPage = deps.maxPerPage ?? AHEAD_MAX_PER_PAGE;
  const now = deps.now ?? (() => performance.now());
  const newGroupId = deps.newGroupId ?? (() => crypto.randomUUID());

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: AheadLine[] = [];
  let current: Running | undefined;
  // Lines answered on this page (by the model or from the cache).
  const done = new Set<string>();
  // Lines the model was asked to explain on this page, for the cap.
  let asked = 0;
  let group = newGroupId();

  const active = () => deps.isOn() && deps.isEnabled?.() !== false;

  const clearTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    idleTimer = undefined;
    retryTimer = undefined;
  };

  const retryLater = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(pump, retryMs);
  };

  /** Stops the running line unless a click has joined it, and puts it back first in line. */
  const cancelRunning = () => {
    if (!current || current.joined) return;
    const { line, stream } = current;
    current = undefined;
    asked -= 1;
    stream.stop();
    queue.unshift(line);
    deps.onEvent?.({ type: 'cancelled', key: line.key });
  };

  function pump(): void {
    retryTimer = undefined;
    if (current) return;
    if (!active()) {
      queue = [];
      return;
    }
    if (queue.length === 0) return;
    if (asked >= maxPerPage) {
      queue = [];
      deps.onEvent?.({ type: 'limit', count: asked });
      return;
    }
    if (deps.isBusy?.() === true) {
      retryLater();
      return;
    }
    const line = queue.shift()!;
    if (done.has(line.key)) {
      pump();
      return;
    }
    const request = line.request();
    if (!request) {
      pump();
      return;
    }
    run(line, request);
  }

  function run(line: AheadLine, request: ExplainRequest): void {
    const running: Running = {
      line,
      text: request.text,
      chunks: [],
      startedAt: now(),
      joined: false,
      // Set just below; no chunk can arrive before explain returns.
      stream: undefined as unknown as ExplainStream,
    };
    asked += 1;
    current = running;
    running.stream = deps.explain(
      request.text,
      (chunk) => {
        running.chunks.push(chunk);
        running.listener?.(chunk);
      },
      {
        fresh: false,
        cause: 'ahead',
        debugId: group,
        ...(request.code && { code: request.code }),
      },
    );
    deps.onEvent?.({ type: 'started', key: line.key });
    const finish = (status: 'done' | 'failed', cached: boolean) => {
      if (current !== running) return;
      current = undefined;
      if (status === 'done') {
        done.add(line.key);
        // An answer from the cache did not keep the model busy.
        if (cached) asked -= 1;
      } else if (!running.joined) {
        // Ollama may be down or the model missing: try again after a scroll.
        queue = [];
      }
      deps.onEvent?.({
        type: 'finished',
        key: line.key,
        elapsedMs: now() - running.startedAt,
        status,
        cached,
      });
      pump();
    };
    running.stream.result.then(
      (result) => finish(result.status, result.status === 'done' && result.cached !== undefined),
      () => finish('failed', false),
    );
  }

  const restart = () => {
    clearTimers();
    queue = [];
    if (!active()) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const running = current?.line.key;
      queue = deps
        .lines()
        .filter(
          (line) => line.key !== running && !done.has(line.key) && worthExplaining(line.text),
        );
      pump();
    }, idleMs);
  };

  const explain: ClickHandlerDeps['explain'] = (context, onChunk, options) => {
    const running = current;
    if (running && !running.joined && !options.fresh && running.text === context) {
      running.joined = true;
      deps.onEvent?.({
        type: 'joined',
        key: running.line.key,
        elapsedMs: now() - running.startedAt,
      });
      let stopped = false;
      // The caller starts listening once this returns, so the text so far is
      // handed over a moment later, then each new piece as it arrives.
      queueMicrotask(() => {
        if (stopped) return;
        const soFar = running.chunks.join('');
        if (soFar) onChunk(soFar);
        running.listener = onChunk;
      });
      return {
        result: running.stream.result,
        stop: () => {
          stopped = true;
          running.listener = undefined;
          running.stream.stop();
        },
      };
    }
    cancelRunning();
    // Carry on once the click (or hover) is done; isBusy holds it until then.
    if (queue.length > 0) retryLater();
    return deps.explain(context, onChunk, options);
  };

  const cancel = () => {
    clearTimers();
    cancelRunning();
    queue = [];
  };

  return {
    restart,
    explain,
    cancel,
    pageChanged: () => {
      cancel();
      done.clear();
      asked = 0;
      group = newGroupId();
    },
    running: () => current?.line.key,
    queued: () => queue.map((line) => line.key),
  };
}
