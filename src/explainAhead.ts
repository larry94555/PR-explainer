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
// Whole PR (PR 10.6) works through every changed line of the PR instead,
// built from the PR's diff on GitHub's API (src/patchRequests.ts, PR 10.4),
// so files GitHub has not drawn yet are explained too. Once the page has been
// still, the lines are put in order: the lines on screen first, then the rest
// of the files on screen and the files just above and below them, then the
// rest of the PR in its order (orderWholePr). Each request tells the service
// worker's queue which of these it is, so two tabs share one order. Scrolling
// starts the wait again, and the order is built again from the code then on
// screen, so the code you move to comes next. It stops at AHEAD_MAX_PER_PR
// lines the model answered for one PR and head commit in this tab (each tab
// counts its own; a line another tab already explained is a cache hit and
// does not count), kept across page
// changes of that PR, and starts over after a new commit. When the PR's diff
// cannot be read (a private repository), it explains the lines on screen as
// you scroll, up to the same limit.
//
// Up to `concurrency` requests are sent at once (the Requests at once
// setting, 1 by default), each still one line or one hunk.
//
// The setting (Off, Lines on screen or Whole PR) is off by default. It is
// saved with the other settings in chrome.storage.sync, which the content
// script reads directly because it cannot import src/settings.ts (see
// src/content.ts). explainAhead.test.ts checks that the keys and values
// match.

import { lineRequest, type ClickHandlerDeps, type ExplainRequest } from './clickHandler';
import { addedLineCells, locateHunk, locateLine, type DiffHunk } from './diffDom';
import type { StorageChangedEvent } from './enabledState';
import type { HunkResult } from './explain/hunkHandler';
import type { ExplainResult } from './explain/explainHandler';
import { hunkSection, withMarker } from './lineContext';
import type { PortStream } from './messaging/client';
import type { SyncStorageLike } from './prefetch';
import type { AheadMode } from './settings';
import { trackSyncValue } from './syncFlag';

/** The chrome.storage.sync key of the setting (storageKey('explainAhead')). */
export const AHEAD_SETTING_KEY = 'settings.explainAhead';

/** How long the page must be still (no scrolling) before lines are explained ahead. */
export const AHEAD_IDLE_MS = 2_000;

/** The most lines the model is asked to explain ahead on one page. */
export const AHEAD_MAX_PER_PAGE = 30;

/**
 * With Whole PR (PR 10.6), the most lines the model is asked to explain for
 * one PR and head commit, to bound battery and fan use.
 */
export const AHEAD_MAX_PER_PR = 500;

/** The chrome.storage.sync key of Requests at once (storageKey('requestsAtOnce')). */
export const REQUESTS_SETTING_KEY = 'settings.requestsAtOnce';

/** Requests at once's limits and default, as in src/settings.ts. */
export const REQUESTS_AT_ONCE = { min: 1, max: 4, default: 1 } as const;

/** While busy (a click, a chat answer, a hover, a hidden tab), how often to check again. */
export const AHEAD_RETRY_MS = 500;

/**
 * The most lines of one hunk sent in one request. The service worker's
 * MAX_HUNK_LINES (src/explain/hunkPrompt.ts); the content script keeps its
 * own copy, and explainAhead.test.ts checks they agree.
 */
export const AHEAD_HUNK_MAX_LINES = 15;

/**
 * The Explain ahead choice as stored. An on or off saved before PR 10.6 is
 * Lines on screen or Off; anything else is Off.
 */
export function aheadModeOf(stored: unknown): AheadMode {
  if (stored === true || stored === 'screen') return 'screen';
  return stored === 'pr' ? 'pr' : 'off';
}

/** Requests at once as stored: a whole number from 1 to 4, or 1. */
export function requestsAtOnceOf(stored: unknown): number {
  return typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= REQUESTS_AT_ONCE.min &&
    stored <= REQUESTS_AT_ONCE.max
    ? stored
    : REQUESTS_AT_ONCE.default;
}

/** Follows the Explain ahead setting (src/syncFlag.ts). */
export function trackAheadSetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
  onChange?: (mode: AheadMode) => void,
): { current(): AheadMode } {
  return trackSyncValue(AHEAD_SETTING_KEY, storage, events, aheadModeOf, onChange);
}

/** Follows the Requests at once setting (src/syncFlag.ts). */
export function trackRequestsSetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
): { current(): number } {
  return trackSyncValue(REQUESTS_SETTING_KEY, storage, events, requestsAtOnceOf);
}

/** The PR a page shows, and its head commit when the page says. */
export interface AheadPage {
  pr: string;
  head: string | null;
}

/**
 * Whether the lines done for `before` still hold on `after`: the same PR,
 * and no new head commit. A page that does not say its head (such as the
 * Conversation tab, sometimes) keeps them; the next page that does decides.
 */
export function samePrHead(before: AheadPage | undefined, after: AheadPage | undefined): boolean {
  if (!before || !after || before.pr !== after.pr) return false;
  return before.head === null || after.head === null || before.head === after.head;
}

/** How near the screen a line is, for Whole PR's order and the service worker's queue. */
export type AheadPriority = 'on-screen' | 'near-screen' | 'rest';

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
  /** The file the line is in, for Whole PR's order. */
  filePath?: string;
  /** Where the line is in the PR (Whole PR), for the service worker's queue. */
  order?: number;
  /** Set by orderWholePr. */
  priority?: AheadPriority;
}

/**
 * Whole PR's order (PR 10.6): `prLines` (every changed line, in the PR's
 * order) with the lines on screen first, then the other lines of the files on
 * screen and of the files just above and below them, then the rest. Each line
 * gets its priority; within one, the PR's order is kept.
 */
export function orderWholePr(
  prLines: readonly AheadLine[],
  onScreen: readonly AheadLine[],
): AheadLine[] {
  const shown = new Set(onScreen.map((line) => line.key));
  const files = [...new Set(prLines.map((line) => line.filePath ?? ''))];
  const shownFiles = new Set(
    prLines.filter((line) => shown.has(line.key)).map((line) => line.filePath ?? ''),
  );
  for (const line of onScreen) if (line.filePath !== undefined) shownFiles.add(line.filePath);
  const near = new Set<string>();
  files.forEach((file, i) => {
    if (!shownFiles.has(file)) return;
    near.add(file);
    if (i > 0) near.add(files[i - 1]!);
    if (i < files.length - 1) near.add(files[i + 1]!);
  });
  const priorityOf = (line: AheadLine): AheadPriority =>
    shown.has(line.key) ? 'on-screen' : near.has(line.filePath ?? '') ? 'near-screen' : 'rest';
  const rank: Record<AheadPriority, number> = { 'on-screen': 0, 'near-screen': 1, rest: 2 };
  return prLines
    .map((line, index) => ({ line: { ...line, priority: priorityOf(line) }, index }))
    .sort((a, b) => rank[a.line.priority] - rank[b.line.priority] || a.index - b.index)
    .map(({ line }) => line);
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
      filePath: line.filePath,
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
  | { type: 'limit'; count: number; wholePr: boolean };

export interface ExplainAheadDeps {
  /** The explain a click uses (it reaches the service worker and its cache). */
  explain: ClickHandlerDeps['explain'];
  /**
   * Sends a hunk's lines in one request (PR 10.5). Left out, every line is
   * sent on its own.
   */
  explainHunk?(
    request: HunkRequest,
    options: { debugId: string; job?: { priority?: AheadPriority; order?: number } },
  ): PortStream<HunkResult>;
  /** The Explain ahead setting is not Off. */
  isOn(): boolean;
  /** The Explain ahead setting is Whole PR (PR 10.6). Left out means Lines on screen. */
  wholePr?(): boolean;
  /**
   * Every changed line of the PR, in its order, built from the PR's diff
   * (PR 10.4), or null when it cannot be read. Used with Whole PR.
   */
  prLines?(): Promise<AheadLine[] | null>;
  /**
   * The PR and its head commit (null when the page does not say), so Whole
   * PR's limit and the lines done are kept across page changes of the same
   * PR (PR 10.6), and start over after a new commit. Undefined (off a PR, or
   * left out) starts over on every page change.
   */
  pageKey?(): AheadPage | undefined;
  /** How many requests to send at once (Requests at once). Defaults to 1. */
  concurrency?(): number;
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
  maxPerPr?: number;
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
   * lines were done and how many were asked (the page's code may have
   * changed), unless `pageKey` names the same PR and head commit as before.
   */
  pageChanged(): void;
  /** The line being explained ahead (the first, when several are), if any. */
  running(): string | undefined;
  /** Every line or hunk being explained ahead. */
  runningAll(): string[];
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

/** What the service worker's queue is told about a Whole PR request: priority and place. */
function jobPlace(line: AheadLine): { priority?: AheadPriority; order?: number } {
  return {
    ...(line.priority && { priority: line.priority }),
    ...(line.order !== undefined && { order: line.order }),
  };
}

export function createExplainAhead(deps: ExplainAheadDeps): ExplainAhead {
  const idleMs = deps.idleMs ?? AHEAD_IDLE_MS;
  const retryMs = deps.retryMs ?? AHEAD_RETRY_MS;
  const maxPerPage = deps.maxPerPage ?? AHEAD_MAX_PER_PAGE;
  const maxPerPr = deps.maxPerPr ?? AHEAD_MAX_PER_PR;
  const now = deps.now ?? (() => performance.now());
  const newGroupId = deps.newGroupId ?? (() => crypto.randomUUID());

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: AheadLine[] = [];
  let running: Running[] = [];
  // Lines answered on this page, or for this PR and head with Whole PR (by
  // the model or from the cache).
  const done = new Set<string>();
  // Lines the model was asked to explain, for the cap.
  let asked = 0;
  let group = newGroupId();
  let pageKey = deps.pageKey?.();
  // Each wait gets a number, so a PR diff read for an older one is ignored.
  let build = 0;

  const active = () => deps.isOn() && deps.isEnabled?.() !== false;
  const wholePr = () => deps.wholePr?.() === true;
  const cap = () => (wholePr() ? maxPerPr : maxPerPage);
  const limit = () => {
    const value = Math.floor(deps.concurrency?.() ?? 1);
    return Math.min(REQUESTS_AT_ONCE.max, Math.max(1, value || 1));
  };

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

  /** Stops the running requests and puts their lines back first in line. */
  const cancelRunning = () => {
    const stopped = running;
    running = [];
    for (const { lines, key, stream } of stopped.reverse()) {
      asked -= lines.length;
      stream.stop();
      queue.unshift(...lines);
      deps.onEvent?.({ type: 'cancelled', key });
    }
  };

  /**
   * The waiting lines of `line`'s hunk, `line` first, taken out of the queue:
   * at most AHEAD_HUNK_MAX_LINES, and no more than the cap allows.
   */
  const takeHunk = (line: AheadLine): AheadLine[] => {
    const id = line.hunk?.id;
    const room = Math.min(AHEAD_HUNK_MAX_LINES, cap() - asked);
    if (!deps.explainHunk || id === undefined || room < 2) return [line];
    const group = [line];
    for (const other of queue) {
      if (group.length >= room) break;
      if (other.hunk?.id === id && !done.has(other.key)) group.push(other);
    }
    queue = queue.filter((other) => !group.includes(other));
    return group;
  };

  /** Starts the next request. False when nothing more can start now. */
  function startNext(): boolean {
    if (queue.length === 0) return false;
    if (asked >= cap()) {
      queue = [];
      deps.onEvent?.({ type: 'limit', count: asked, wholePr: wholePr() });
      return false;
    }
    if (deps.isBusy?.() === true) {
      retryLater();
      return false;
    }
    const line = queue.shift()!;
    if (done.has(line.key)) return true;
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
        return true;
      }
      queue.unshift(...lines.slice(1));
    }
    const request = line.request();
    if (request) run(line, request);
    return true;
  }

  function pump(): void {
    retryTimer = undefined;
    if (!active()) {
      queue = [];
      return;
    }
    while (running.length < limit() && startNext()) {
      // Starts requests until there is no room or nothing left.
    }
  }

  /** Tracks one request to its end. */
  function track(
    request: Running,
    outcome: (result: ExplainResult | HunkResult) => {
      done: string[];
      cached: number;
      missing?: number;
    },
  ): void {
    running.push(request);
    deps.onEvent?.({ type: 'started', key: request.key });
    const finish = (
      status: 'done' | 'failed',
      answered: { done: string[]; cached: number; missing?: number } = { done: [], cached: 0 },
    ) => {
      if (!running.includes(request)) return;
      running = running.filter((other) => other !== request);
      if (status === 'done') {
        for (const key of answered.done) done.add(key);
        // An answer from the cache did not keep the model busy, and a line a
        // hunk's answer left out was not answered here (review on #65): it
        // counts when it is asked again after a scroll. The service worker
        // asks about it once on its own meanwhile; if that answer is in by
        // then, asking again is a cache hit and counts nothing.
        asked -= answered.cached + (answered.missing ?? 0);
      } else {
        // Ollama may be down or the model missing: try again after a scroll.
        queue = [];
      }
      deps.onEvent?.({
        type: 'finished',
        key: request.key,
        elapsedMs: now() - request.startedAt,
        status,
        cached: answered.cached === request.lines.length,
      });
      pump();
    };
    request.stream.result.then(
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
          job: { label: line.key, ...jobPlace(line) },
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
    const place = jobPlace(lines[0]!);
    track(
      {
        lines,
        key: request.label,
        startedAt: now(),
        stream: deps.explainHunk!(request, {
          debugId: group,
          ...(Object.keys(place).length > 0 && { job: place }),
        }),
      },
      (result) => {
        // A line the answer left out is asked again on its own by the
        // service worker, and here after the next scroll.
        const answered = result.status === 'hunk' ? result.lines : [];
        return {
          done: answered.filter((l) => l.status !== 'missing').map((l) => l.label),
          cached: answered.filter((l) => l.status === 'cached').length,
          missing: answered.filter((l) => l.status === 'missing').length,
        };
      },
    );
  }

  /** Queues `lines` (leaving out what runs or is done, blank and closing lines) and starts. */
  const fill = (lines: AheadLine[]) => {
    const busy = new Set(running.flatMap((request) => request.lines.map((line) => line.key)));
    queue = lines.filter(
      (line) => !busy.has(line.key) && !done.has(line.key) && worthExplaining(line.text),
    );
    pump();
  };

  const restart = () => {
    clearTimers();
    queue = [];
    const mine = ++build;
    if (!active()) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const onScreen = deps.lines();
      if (!wholePr() || !deps.prLines) {
        fill(onScreen);
        return;
      }
      // The PR's whole diff, read once per head commit; the lines on screen
      // when it cannot be read.
      deps.prLines().then(
        (prLines) => {
          if (mine !== build || !active()) return;
          fill(prLines ? orderWholePr(prLines, onScreen) : onScreen);
        },
        () => {
          if (mine === build && active()) fill(onScreen);
        },
      );
    }, idleMs);
  };

  const cancel = () => {
    build++;
    clearTimers();
    cancelRunning();
    queue = [];
  };

  return {
    restart,
    cancel,
    pageChanged: () => {
      cancel();
      const page = deps.pageKey?.();
      // The same PR and head commit keeps its count and the lines done, so
      // Whole PR's limit is per PR; anything else starts over.
      if (samePrHead(pageKey, page)) {
        pageKey = { pr: page!.pr, head: page!.head ?? pageKey!.head };
      } else {
        done.clear();
        asked = 0;
        pageKey = page;
      }
      group = newGroupId();
    },
    running: () => running[0]?.key,
    runningAll: () => running.map((request) => request.key),
    queued: () => queue.map((line) => line.key),
  };
}
