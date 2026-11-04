// Explain ahead (PR 9.10): once a PR's Files changed tab has been still for
// AHEAD_IDLE_MS, explains the added and changed lines on screen, top to
// bottom, one at a time, so a click on one of them is answered at once from
// the service worker's cache (PR 4.3) instead of waiting for the model.
//
// Each line goes through the same `explain` as a click, with the same request
// text (lineRequest in src/clickHandler.ts), so its answer is saved under the
// key a click on that line looks up. Lines of one hunk are sent together, at
// most AHEAD_HUNK_MAX_LINES at a time, as one request that explains each of
// them (PR 10.5, src/explain/hunkHandler.ts), which saves each line's answer
// under that same key. Each request goes through the service
// worker's queue (PR 10.3, src/explain/prefetchQueue.ts), which joins a click
// on the line being explained to it, as with Explain on hover.
//
// It keeps out of the way:
// - One request at a time, and at most AHEAD_MAX_PER_PAGE lines that the model
//   answered per page (an answer already in the cache comes back at once and
//   does not count).
// - Blank lines and lines that only close a block (`}`, `});`) are skipped.
// - Nothing starts while `isBusy` says so: a click's answer or a chat answer
//   is being written, Explain on hover is running, or the tab is hidden. It
//   checks again every AHEAD_RETRY_MS until it is free.
// - A click on other code makes the service worker's queue stop the line
//   being explained ahead, so the model is free for it, and run it again
//   once the click is answered. Its request here simply takes longer.
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
import { addedLineCells, locateHunk, locateLine, type DiffHunk } from './diffDom';
import type { StorageChangedEvent } from './enabledState';
import type { HunkResult } from './explain/hunkHandler';
import type { ExplainResult } from './explain/explainHandler';
import { hunkSection, withMarker } from './lineContext';
import type { PortStream } from './messaging/client';
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

/**
 * The most lines of one hunk sent in one request. The service worker's
 * MAX_HUNK_LINES (src/explain/hunkPrompt.ts); the content script keeps its
 * own copy, and explainAhead.test.ts checks they agree.
 */
export const AHEAD_HUNK_MAX_LINES = 15;

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
  /**
   * The hunk the line is in (PR 10.5): lines with the same `id` are sent in
   * one request. `read` gives the hunk as the page shows it now.
   */
  hunk?: { id: string; read(): DiffHunk | null };
}

/** A hunk's lines to explain in one request (PR 10.5). */
export interface HunkRequest {
  /** For the debug window, such as "src/a.ts: lines 12, 14, 15". */
  label: string;
  /** The diff section the model reads (hunkSection in src/lineContext.ts). */
  text: string;
  lines: {
    /** The line's name, such as "src/a.ts:added:12". */
    label: string;
    /** The request a click on it sends. */
    request: ExplainRequest;
    /** Its number in the new file. */
    line: number;
    /** The line diff style, such as "+const a = 1;". */
    code: string;
  }[];
}

/** Names a hunk on the page: its file, header and first line. */
export function hunkId(hunk: DiffHunk): string {
  const first = hunk.lines[0];
  return `${first?.filePath ?? ''}\n${hunk.header}\n${first?.lineNumber ?? ''}`;
}

/**
 * The request for `lines` of one hunk, or null when the page no longer
 * shows it. `lines` that are not in it are left out.
 */
export function hunkRequest(lines: readonly AheadLine[]): HunkRequest | null {
  const hunk = lines[0]?.hunk?.read();
  if (!hunk) return null;
  const out: HunkRequest['lines'] = [];
  const indexes: number[] = [];
  for (const line of lines) {
    const request = line.request();
    const number = request?.subject.startLine;
    const index = hunk.lines.findIndex((l) => l.side === 'added' && l.lineNumber === number);
    if (!request || number === undefined || index === -1) continue;
    indexes.push(index);
    out.push({ label: line.key, request, line: number, code: withMarker(hunk.lines[index]!) });
  }
  if (out.length === 0) return null;
  const { filePath } = hunk.lines[indexes[0]!]!;
  return {
    label: `${filePath}: ${out.length === 1 ? 'line' : 'lines'} ${out.map((l) => l.line).join(', ')}`,
    text: hunkSection(hunk, indexes),
    lines: out,
  };
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
    const hunk = locateHunk(cell);
    lines.push({
      key: `${line.filePath}:${line.side}:${line.lineNumber}`,
      text: line.text,
      request: () => lineRequest(cell)?.request ?? null,
      ...(hunk && { hunk: { id: hunkId(hunk), read: () => locateHunk(cell) } }),
    });
  }
  return lines;
}

export type AheadEvent =
  | { type: 'started'; key: string }
  | { type: 'cancelled'; key: string }
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
  /**
   * Sends a hunk's lines in one request (PR 10.5). Left out, every line is
   * sent on its own.
   */
  explainHunk?(request: HunkRequest, options: { debugId: string }): PortStream<HunkResult>;
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
  /** Called as lines start, end or are cancelled (logging). */
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
   * Stops the wait, the queue and the line being explained (turning off,
   * leaving). A click that joined it in the service worker keeps its answer.
   */
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
  /** One line, or the lines of one hunk. */
  lines: AheadLine[];
  /** The line's key, or the hunk request's label. */
  key: string;
  stream: PortStream<ExplainResult | HunkResult>;
  startedAt: number;
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

  /** Stops the running request and puts its lines back first in line. */
  const cancelRunning = () => {
    if (!current) return;
    const { lines, key, stream } = current;
    current = undefined;
    asked -= lines.length;
    stream.stop();
    queue.unshift(...lines);
    deps.onEvent?.({ type: 'cancelled', key });
  };

  /**
   * The waiting lines of `line`'s hunk, `line` first, taken out of the queue:
   * at most AHEAD_HUNK_MAX_LINES, and no more than the page's cap allows.
   */
  const takeHunk = (line: AheadLine): AheadLine[] => {
    const id = line.hunk?.id;
    const room = Math.min(AHEAD_HUNK_MAX_LINES, maxPerPage - asked);
    if (!deps.explainHunk || id === undefined || room < 2) return [line];
    const group = [line];
    for (const other of queue) {
      if (group.length >= room) break;
      if (other.hunk?.id === id && !done.has(other.key)) group.push(other);
    }
    queue = queue.filter((other) => !group.includes(other));
    return group;
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
    const lines = takeHunk(line);
    if (lines.length > 1) {
      const request = hunkRequest(lines);
      // Lines the page no longer shows as part of the hunk go back.
      const sent = new Set(request?.lines.map((l) => l.label));
      const rest = lines.filter((l) => !sent.has(l.key));
      if (request && request.lines.length > 1) {
        queue.unshift(...rest);
        runHunk(
          lines.filter((l) => sent.has(l.key)),
          request,
        );
        return;
      }
      queue.unshift(...lines.slice(1));
    }
    const request = line.request();
    if (!request) {
      pump();
      return;
    }
    run(line, request);
  }

  /** Tracks one request to its end. `doneKeys` are the lines it answered. */
  function track(
    running: Running,
    outcome: (result: ExplainResult | HunkResult) => { done: string[]; cached: number },
  ): void {
    current = running;
    deps.onEvent?.({ type: 'started', key: running.key });
    const finish = (status: 'done' | 'failed', answered = { done: [] as string[], cached: 0 }) => {
      if (current !== running) return;
      current = undefined;
      if (status === 'done') {
        for (const key of answered.done) done.add(key);
        // An answer from the cache did not keep the model busy.
        asked -= answered.cached;
      } else {
        // Ollama may be down or the model missing: try again after a scroll.
        queue = [];
      }
      deps.onEvent?.({
        type: 'finished',
        key: running.key,
        elapsedMs: now() - running.startedAt,
        status,
        cached: answered.cached === running.lines.length,
      });
      pump();
    };
    running.stream.result.then(
      (result) => (result.status === 'failed' ? finish('failed') : finish('done', outcome(result))),
      () => finish('failed'),
    );
  }

  function run(line: AheadLine, request: ExplainRequest): void {
    asked += 1;
    track(
      {
        lines: [line],
        key: line.key,
        startedAt: now(),
        // The answer goes to the cache; only a click shows it.
        stream: deps.explain(request.text, () => {}, {
          fresh: false,
          cause: 'ahead',
          debugId: group,
          job: { label: line.key },
          ...(request.code && { code: request.code }),
        }),
      },
      (result) => ({
        done: [line.key],
        cached: result.status === 'done' && result.cached !== undefined ? 1 : 0,
      }),
    );
  }

  function runHunk(lines: AheadLine[], request: HunkRequest): void {
    asked += lines.length;
    track(
      {
        lines,
        key: request.label,
        startedAt: now(),
        stream: deps.explainHunk!(request, { debugId: group }),
      },
      (result) => {
        // A line the answer left out is asked again on its own by the
        // service worker, and here after the next scroll.
        const answered = result.status === 'hunk' ? result.lines : [];
        return {
          done: answered.filter((l) => l.status !== 'missing').map((l) => l.label),
          cached: answered.filter((l) => l.status === 'cached').length,
        };
      },
    );
  }

  const restart = () => {
    clearTimers();
    queue = [];
    if (!active()) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const running = new Set(current?.lines.map((line) => line.key));
      queue = deps
        .lines()
        .filter(
          (line) => !running.has(line.key) && !done.has(line.key) && worthExplaining(line.text),
        );
      pump();
    }, idleMs);
  };

  const cancel = () => {
    clearTimers();
    cancelRunning();
    queue = [];
  };

  return {
    restart,
    cancel,
    pageChanged: () => {
      cancel();
      done.clear();
      asked = 0;
      group = newGroupId();
    },
    running: () => current?.key,
    queued: () => queue.map((line) => line.key),
  };
}
