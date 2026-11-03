// The debug window (PR 9.4): every round trip to GitHub and the local LLM,
// with its prompt, reply and time, updating live.
//
// It reads the debug log the service worker keeps (src/debug/debugLog.ts,
// PR 9.3) over the debug log port: first the whole log and the round trips
// still running, then each new entry as it comes. Round trips are grouped
// under what caused them (a click, Explain on hover, the warm-up or a chat
// question), newest first. Opening a row shows the request (a chat prompt
// message by message, with its role), the reply (thinking apart from the
// answer), Ollama's own timings, and the click's tasks from PR 9.1. A row
// still running shows its reply growing and its time ticking.
//
// At the top: Pause (updates wait until Resume), Clear (empties the window
// and the log), GitHub and Ollama filters, and Copy as JSON (what is shown).
//
// It is an extension page (src/debug.html), opened by
// src/debug/debugWindowOpener.ts. It must not import code the content script
// imports, or Vite would put that code in a chunk the content script cannot
// load (see src/content.ts); type imports are fine. The demo page
// (`npm run demo:debug`) shows it with a recorded flow.

import type { LlmTimings } from '../llm/types';
import type { RoundTrip, RoundTripTarget, TraceTask } from '../trace/types';
import type {
  DebugCause,
  DebugEntry,
  DebugLogPortMessage,
  DebugLogPortName,
  DebugRoundTripEntry,
  DebugRunningEntry,
  DebugTraceEntry,
} from './types';

export const DEBUG_PORT_NAME: DebugLogPortName = 'pr-explainer:debugLog';

/** How often running times tick. */
export const TICK_MS = 200;
/** How long to wait before connecting again when the service worker goes away. */
export const RECONNECT_MS = 1_000;
/**
 * The window keeps the same newest entries the service worker keeps
 * (DEBUG_LOG_LIMIT in src/debug/debugLog.ts, which debugWindow.test.ts
 * checks), so it never holds prompts and replies the log has dropped.
 */
export const WINDOW_LIMIT = 200;

/** The part of a chrome.runtime.Port the window uses. */
export interface DebugPort {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  disconnect(): void;
}

export interface DebugWindowDeps {
  /** Connects to the service worker on the debug log port. */
  connect(): DebugPort;
  /** Empties the debug log (`debugLogClear`). */
  clear(): Promise<unknown>;
  /** Puts text on the clipboard. */
  copy(text: string): Promise<void>;
  /** Clock in milliseconds (Date.now()). Tests pass a fake one. */
  now?: () => number;
}

export interface DebugWindow {
  readonly paused: boolean;
  /** Stops listening and ticking. */
  destroy(): void;
}

export const CAUSE_LABELS: Record<DebugCause, string> = {
  click: 'Click',
  hover: 'Explain on hover',
  warmup: 'Warm-up',
  chat: 'Chat question',
};

const TARGET_LABELS: Record<RoundTripTarget, string> = { github: 'GitHub', ollama: 'Ollama' };

/** "850 ms", "2.3 s", or "1 min 05 s". */
export function formatMs(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** "14:02:07.315", in local time. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The reply's thinking and its answer. Thinking Ollama returned in its own
 * field wins; otherwise a `<think>` section at the start of the reply (still
 * open while the model is thinking) is the thinking.
 */
export function splitThinking(trip: Pick<RoundTrip, 'reply' | 'thinking'>): {
  thinking: string;
  answer: string;
} {
  const reply = trip.reply ?? '';
  const match = /^\s*<think>([\s\S]*?)(?:<\/think>|$)/.exec(reply);
  const inline = match ? match[1]!.trim() : '';
  const answer = match ? reply.slice(match[0].length).trim() : reply.trim();
  const thinking = [trip.thinking?.trim() ?? '', inline].filter(Boolean).join('\n\n');
  return { thinking, answer };
}

type TripEntry = DebugRoundTripEntry | DebugRunningEntry;

interface Row {
  key: string;
  entry: TripEntry;
  running: boolean;
}

interface Group {
  id: string;
  cause: DebugCause;
  where?: string;
  start: number;
  end: number;
  rows: Row[];
  trace?: DebugTraceEntry;
}

function rowKey(entry: TripEntry): string {
  return entry.trip.id ?? `entry-${(entry as DebugRoundTripEntry).id}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Puts `wanted` in `parent` in order, moving as few nodes as it can. */
function syncChildren(parent: Element, wanted: Element[]): void {
  wanted.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null);
  });
  while (parent.children.length > wanted.length) parent.lastElementChild!.remove();
}

interface RowView {
  li: HTMLLIElement;
  button: HTMLButtonElement;
  time: HTMLSpanElement;
  target: HTMLSpanElement;
  endpoint: HTMLSpanElement;
  purpose: HTMLSpanElement;
  duration: HTMLSpanElement;
  status: HTMLSpanElement;
  detail: HTMLDivElement;
  /** What the open detail was last drawn from, so it is redrawn only when that changes. */
  drawn?: string;
}

interface GroupView {
  section: HTMLElement;
  cause: HTMLSpanElement;
  where: HTMLSpanElement;
  meta: HTMLSpanElement;
  list: HTMLUListElement;
}

export function createDebugWindow(root: HTMLElement, deps: DebugWindowDeps): DebugWindow {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const now = deps.now ?? Date.now;

  // --- State ---
  const entries = new Map<number, DebugEntry>();
  /** Trip ids of round trips that have ended (their running row is gone). */
  const ended = new Set<string>();
  const running = new Map<string, DebugRunningEntry>();
  const filters: Record<RoundTripTarget, boolean> = { github: true, ollama: true };
  const opened = new Set<string>();
  let paused = false;
  let pending: DebugLogPortMessage[] = [];
  let destroyed = false;
  let idCounter = 0;

  // --- Layout ---
  const header = el(doc, 'header', 'toolbar');
  const title = el(doc, 'h1', 'title', 'PR Explainer debug');
  const controls = el(doc, 'div', 'controls');
  controls.setAttribute('role', 'toolbar');
  controls.setAttribute('aria-label', 'Debug window controls');
  const pauseButton = el(doc, 'button', 'pause', 'Pause');
  pauseButton.type = 'button';
  pauseButton.setAttribute('aria-pressed', 'false');
  pauseButton.title = 'Stop updating until Resume';
  const clearButton = el(doc, 'button', 'clear', 'Clear');
  clearButton.type = 'button';
  clearButton.title = 'Empty this window and the debug log';
  const filterBox = (target: RoundTripTarget) => {
    const label = el(doc, 'label', `filter filter-${target}`);
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.checked = true;
    input.name = target;
    input.addEventListener('change', () => {
      filters[target] = input.checked;
      render();
    });
    label.append(input, ` ${TARGET_LABELS[target]}`);
    return label;
  };
  const copyButton = el(doc, 'button', 'copy', 'Copy as JSON');
  copyButton.type = 'button';
  copyButton.title = 'Copy what is shown, to paste into an issue or a chat';
  controls.append(pauseButton, clearButton, filterBox('github'), filterBox('ollama'), copyButton);
  const summary = el(doc, 'span', 'summary');
  header.append(title, controls, summary);
  const status = el(doc, 'p', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const empty = el(
    doc,
    'p',
    'empty',
    'No round trips yet. With Debug window on in the settings, click a line in a PR’s Files changed tab.',
  );
  const main = el(doc, 'main', 'groups');
  main.setAttribute('aria-label', 'Round trips, newest first');
  root.replaceChildren(header, status, empty, main);

  const say = (text: string) => {
    status.textContent = text;
  };

  // --- Messages ---
  const apply = (message: DebugLogPortMessage) => {
    switch (message.type) {
      case 'snapshot':
        entries.clear();
        ended.clear();
        running.clear();
        for (const entry of message.entries) addEntry(entry);
        for (const entry of message.running) addRunning(entry);
        break;
      case 'entry':
        addEntry(message.entry);
        break;
      case 'running':
        addRunning(message.entry);
        break;
      case 'cleared':
        entries.clear();
        ended.clear();
        running.clear();
        break;
    }
  };
  function addEntry(entry: DebugEntry) {
    entries.set(entry.id, entry);
    if (entry.kind === 'round-trip' && entry.trip.id) {
      if (ended.size >= WINDOW_LIMIT * 5) ended.clear();
      ended.add(entry.trip.id);
      running.delete(entry.trip.id);
    }
    // Drop the oldest, as the log does. Running round trips are not counted.
    if (entries.size > WINDOW_LIMIT) {
      const ids = [...entries.keys()].sort((a, b) => a - b);
      for (const id of ids.slice(0, entries.size - WINDOW_LIMIT)) entries.delete(id);
    }
  }
  function addRunning(entry: DebugRunningEntry) {
    const id = entry.trip.id;
    if (!id || ended.has(id)) return;
    running.set(id, entry);
  }

  const isMessage = (value: unknown): value is DebugLogPortMessage =>
    typeof value === 'object' &&
    value !== null &&
    ['snapshot', 'entry', 'running', 'cleared'].includes(
      (value as { type?: unknown }).type as string,
    );

  const onMessage = (message: unknown) => {
    if (destroyed || !isMessage(message)) return;
    if (paused) {
      pending.push(message);
      updatePause();
      return;
    }
    apply(message);
    render();
  };

  let port: DebugPort | undefined;
  let reconnect: number | undefined;
  const connect = () => {
    if (destroyed) return;
    try {
      port = deps.connect();
    } catch {
      reconnect = win.setTimeout(connect, RECONNECT_MS);
      return;
    }
    port.onMessage.addListener(onMessage);
    // Chrome stops an idle service worker; the window connects again and gets the log anew.
    port.onDisconnect.addListener(() => {
      port = undefined;
      if (!destroyed) reconnect = win.setTimeout(connect, RECONNECT_MS);
    });
  };

  // --- Groups ---
  const tripEnd = (entry: TripEntry, isRunning: boolean) =>
    entry.at +
    (isRunning ? Math.max(entry.trip.durationMs, now() - entry.at) : entry.trip.durationMs);

  const buildGroups = (): Group[] => {
    const groups = new Map<string, Group>();
    const groupOf = (entry: DebugEntry | DebugRunningEntry) => {
      let group = groups.get(entry.group);
      if (!group) {
        group = {
          id: entry.group,
          cause: entry.cause,
          start: entry.at,
          end: entry.at,
          rows: [],
        };
        groups.set(entry.group, group);
      }
      if (entry.where && !group.where) group.where = entry.where;
      // A click's own entries name it, even when a warm-up's came first.
      if (entry.cause === 'click' || entry.cause === 'hover') group.cause = entry.cause;
      group.start = Math.min(group.start, entry.at);
      return group;
    };
    for (const entry of entries.values()) {
      const group = groupOf(entry);
      if (entry.kind === 'trace') {
        group.trace = entry;
        const last = Math.max(0, ...entry.tasks.map((t) => t.startMs + t.durationMs));
        group.end = Math.max(group.end, entry.at + last);
      } else {
        group.rows.push({ key: rowKey(entry), entry, running: false });
        group.end = Math.max(group.end, tripEnd(entry, false));
      }
    }
    for (const entry of running.values()) {
      const group = groupOf(entry);
      group.rows.push({ key: rowKey(entry), entry, running: true });
      group.end = Math.max(group.end, tripEnd(entry, true));
    }
    for (const group of groups.values()) {
      group.rows.sort((a, b) => b.entry.at - a.entry.at || (b.key > a.key ? 1 : -1));
    }
    return [...groups.values()].sort((a, b) => b.start - a.start);
  };

  const visibleRows = (group: Group) => group.rows.filter((row) => filters[row.entry.trip.target]);
  const shownGroups = (groups: Group[]) =>
    groups.filter((group) => group.rows.length === 0 || visibleRows(group).length > 0);

  // --- Drawing ---
  const groupViews = new Map<string, GroupView>();
  const rowViews = new Map<string, RowView>();

  const makeGroup = (group: Group): GroupView => {
    const section = el(doc, 'section', 'group');
    const headingId = `group-${++idCounter}`;
    section.setAttribute('aria-labelledby', headingId);
    const heading = el(doc, 'h2', 'group-title');
    heading.id = headingId;
    const cause = el(doc, 'span', 'cause');
    const where = el(doc, 'span', 'where');
    const meta = el(doc, 'span', 'meta');
    heading.append(cause, where, meta);
    const list = el(doc, 'ul', 'rows');
    section.append(heading, list);
    section.dataset.group = group.id;
    return { section, cause, where, meta, list };
  };

  const makeRow = (key: string): RowView => {
    const li = el(doc, 'li', 'row');
    const button = el(doc, 'button', 'row-button');
    button.type = 'button';
    const detail = el(doc, 'div', 'detail');
    detail.id = `detail-${++idCounter}`;
    detail.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', detail.id);
    const time = el(doc, 'span', 'time');
    const target = el(doc, 'span', 'target');
    const endpoint = el(doc, 'span', 'endpoint');
    const purpose = el(doc, 'span', 'purpose');
    const duration = el(doc, 'span', 'duration');
    const statusLabel = el(doc, 'span', 'trip-status');
    button.append(time, target, endpoint, purpose, duration, statusLabel);
    const view: RowView = {
      li,
      button,
      time,
      target,
      endpoint,
      purpose,
      duration,
      status: statusLabel,
      detail,
    };
    button.addEventListener('click', () => {
      if (opened.has(key)) opened.delete(key);
      else opened.add(key);
      render();
    });
    li.append(button, detail);
    return view;
  };

  const drawGroup = (view: GroupView, group: Group) => {
    view.cause.textContent = CAUSE_LABELS[group.cause] ?? group.cause;
    view.where.textContent = group.where ?? '';
    view.where.hidden = !group.where;
    const trips = group.rows.length;
    const live = group.rows.some((row) => row.running);
    view.meta.textContent = [
      formatClock(group.start),
      `${formatMs(group.end - group.start)}${live ? ' so far' : ''}`,
      `${trips} round trip${trips === 1 ? '' : 's'}`,
    ].join(' · ');
    view.section.dataset.cause = group.cause;
  };

  const statusText = (trip: RoundTrip, isRunning: boolean) => {
    if (isRunning) return 'running';
    if (trip.status === 'done' && trip.httpStatus !== undefined) return `${trip.httpStatus}`;
    if (trip.status === 'failed' && trip.httpStatus !== undefined && trip.httpStatus >= 400) {
      return `failed (${trip.httpStatus})`;
    }
    return trip.status;
  };

  const drawRow = (view: RowView, row: Row, group: Group) => {
    const { trip } = row.entry;
    const duration = row.running
      ? Math.max(trip.durationMs, now() - row.entry.at)
      : trip.durationMs;
    view.time.textContent = formatClock(row.entry.at);
    view.target.textContent = TARGET_LABELS[trip.target];
    view.target.dataset.target = trip.target;
    view.endpoint.textContent = trip.endpoint;
    view.endpoint.title = `${trip.method} ${trip.endpoint}`;
    view.purpose.textContent = trip.purpose;
    view.duration.textContent = formatMs(duration);
    const label = statusText(trip, row.running);
    view.status.textContent = label;
    view.li.dataset.status = row.running ? 'running' : trip.status;
    view.li.dataset.target = trip.target;
    view.button.setAttribute(
      'aria-label',
      `${formatClock(row.entry.at)}, ${TARGET_LABELS[trip.target]} ${trip.endpoint}, ` +
        `${trip.purpose}, ${formatMs(duration)}, ${label}`,
    );
    const open = opened.has(row.key);
    view.button.setAttribute('aria-expanded', String(open));
    view.detail.hidden = !open;
    if (!open) {
      view.drawn = undefined;
      return;
    }
    // Redrawn only when what it shows changed, so text selected in it stays.
    const drawn = JSON.stringify([
      row.running,
      trip.status,
      row.running ? 0 : trip.durationMs,
      trip.reply?.length,
      trip.thinking?.length,
      trip.bytesReceived,
      group.trace?.id,
    ]);
    if (view.drawn === drawn) return;
    view.drawn = drawn;
    view.detail.replaceChildren(...detailOf(row, group));
  };

  const section = (heading: string, ...children: Node[]) => {
    const box = el(doc, 'div', 'section');
    box.append(el(doc, 'h3', undefined, heading), ...children);
    return box;
  };

  const facts = (pairs: [string, string][]) => {
    const dl = el(doc, 'dl', 'facts');
    for (const [name, value] of pairs) {
      dl.append(el(doc, 'dt', undefined, name), el(doc, 'dd', undefined, value));
    }
    return dl;
  };

  const detailOf = (row: Row, group: Group): Node[] => {
    const { trip } = row.entry;
    const nodes: Node[] = [];
    nodes.push(
      facts([
        ['Request', `${trip.method} ${trip.endpoint}`],
        ['Started', formatClock(row.entry.at)],
        ['Took', row.running ? 'still running' : formatMs(trip.durationMs)],
        [
          'Status',
          row.running
            ? 'running'
            : `${trip.status}${trip.httpStatus !== undefined ? ` (HTTP ${trip.httpStatus})` : ''}`,
        ],
        ['Sent', formatBytes(trip.bytesSent)],
        ['Received', `${formatBytes(trip.bytesReceived)}${row.running ? ' so far' : ''}`],
        ...(trip.error ? ([['Error', trip.error]] as [string, string][]) : []),
      ]),
    );
    if (trip.messages?.length) {
      const list = el(doc, 'ol', 'messages');
      for (const message of trip.messages) {
        const item = el(doc, 'li', 'message');
        item.dataset.role = message.role;
        item.append(
          el(doc, 'span', 'role', message.role),
          el(doc, 'pre', 'content', message.content),
        );
        list.append(item);
      }
      nodes.push(section(`Prompt (${trip.messages.length} messages)`, list));
    }
    if (trip.reply !== undefined || trip.thinking !== undefined || trip.messages) {
      const { thinking, answer } = splitThinking(trip);
      const parts: Node[] = [];
      if (thinking) {
        const box = el(doc, 'div', 'thinking');
        box.append(el(doc, 'span', 'role', 'thinking'), el(doc, 'pre', 'content', thinking));
        parts.push(box);
      }
      const box = el(doc, 'div', 'answer');
      box.append(
        el(doc, 'span', 'role', 'answer'),
        el(
          doc,
          'pre',
          'content',
          answer ||
            (row.running ? '(nothing yet)' : thinking ? '(no answer after thinking)' : '(empty)'),
        ),
      );
      parts.push(box);
      nodes.push(section(row.running ? 'Reply so far' : 'Reply', ...parts));
    }
    if (trip.timings) nodes.push(section('Ollama’s timings', timingsTable(trip.timings)));
    if (group.trace)
      nodes.push(section(`Tasks of the ${causeNoun(group.cause)}`, waterfall(group.trace.tasks)));
    return nodes;
  };

  const causeNoun = (cause: DebugCause) => (cause === 'hover' ? 'hover' : 'click');

  const timingsTable = (t: LlmTimings) => {
    const pairs: [string, string][] = [];
    if (t.loadMs !== undefined) pairs.push(['Load', formatMs(t.loadMs)]);
    if (t.promptMs !== undefined || t.promptTokens !== undefined) {
      pairs.push([
        'Read prompt',
        [
          t.promptMs !== undefined && formatMs(t.promptMs),
          t.promptTokens !== undefined && `${t.promptTokens} tokens`,
        ]
          .filter(Boolean)
          .join(', '),
      ]);
    }
    if (t.answerMs !== undefined || t.answerTokens !== undefined) {
      pairs.push([
        'Write answer',
        [
          t.answerMs !== undefined && formatMs(t.answerMs),
          t.answerTokens !== undefined && `${t.answerTokens} tokens`,
        ]
          .filter(Boolean)
          .join(', '),
      ]);
    }
    if (t.totalMs !== undefined) pairs.push(['Total', formatMs(t.totalMs)]);
    return facts(pairs);
  };

  const waterfall = (tasks: TraceTask[]) => {
    const total = Math.max(1, ...tasks.map((t) => t.startMs + t.durationMs));
    const list = el(doc, 'ol', 'waterfall');
    list.setAttribute('aria-label', `Tasks, ${formatMs(total)} in all`);
    for (const task of [...tasks].sort((a, b) => a.startMs - b.startMs)) {
      const item = el(doc, 'li', 'task');
      item.dataset.source = task.source;
      const label = el(
        doc,
        'span',
        'task-label',
        task.label + (task.status ? ` (${task.status})` : ''),
      );
      const track = el(doc, 'span', 'track');
      track.setAttribute('aria-hidden', 'true');
      const bar = el(doc, 'span', 'bar');
      bar.style.left = `${(Math.max(0, task.startMs) / total) * 100}%`;
      bar.style.width = `${Math.max(0.5, (task.durationMs / total) * 100)}%`;
      track.append(bar);
      const time = el(doc, 'span', 'task-time', formatMs(task.durationMs));
      item.append(label, track, time);
      list.append(item);
    }
    return list;
  };

  const render = () => {
    if (destroyed) return;
    const groups = buildGroups();
    const shown = shownGroups(groups);
    const sections: Element[] = [];
    for (const group of shown) {
      let view = groupViews.get(group.id);
      if (!view) {
        view = makeGroup(group);
        groupViews.set(group.id, view);
      }
      drawGroup(view, group);
      const items: Element[] = [];
      for (const row of visibleRows(group)) {
        let rowView = rowViews.get(row.key);
        if (!rowView) {
          rowView = makeRow(row.key);
          rowViews.set(row.key, rowView);
        }
        drawRow(rowView, row, group);
        items.push(rowView.li);
      }
      syncChildren(view.list, items);
      sections.push(view.section);
    }
    syncChildren(main, sections);
    // Forget what is no longer in the log (Clear, or the oldest dropped).
    const allKeys = new Set(groups.flatMap((g) => g.rows.map((r) => r.key)));
    for (const key of rowViews.keys()) {
      if (!allKeys.has(key)) {
        rowViews.delete(key);
        opened.delete(key);
      }
    }
    const groupIds = new Set(groups.map((g) => g.id));
    for (const id of groupViews.keys()) if (!groupIds.has(id)) groupViews.delete(id);
    empty.hidden = shown.length > 0;
    const trips = shown.reduce((n, g) => n + visibleRows(g).length, 0);
    summary.textContent = `${trips} round trip${trips === 1 ? '' : 's'} in ${shown.length} group${shown.length === 1 ? '' : 's'}`;
  };

  // --- Controls ---
  const updatePause = () => {
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.textContent = paused
      ? `Resume${pending.length ? ` (${pending.length} new)` : ''}`
      : 'Pause';
    pauseButton.title = paused
      ? 'Show what came while paused, and keep updating'
      : 'Stop updating until Resume';
    root.dataset.paused = String(paused);
  };
  pauseButton.addEventListener('click', () => {
    paused = !paused;
    if (!paused) {
      for (const message of pending) apply(message);
      pending = [];
      render();
      say('Resumed.');
    } else {
      say('Paused. New round trips wait until you resume.');
    }
    updatePause();
  });

  clearButton.addEventListener('click', async () => {
    pending = [];
    apply({ type: 'cleared' });
    render();
    updatePause();
    try {
      await deps.clear();
      say('Cleared the window and the debug log.');
    } catch (error) {
      say(
        `Could not clear the debug log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  /** What is shown, as plain data. */
  const shownData = () => {
    const groups = shownGroups(buildGroups());
    return {
      copiedAt: new Date(now()).toISOString(),
      groups: groups.map((group) => ({
        group: group.id,
        cause: group.cause,
        ...(group.where && { where: group.where }),
        startedAt: new Date(group.start).toISOString(),
        totalMs: Math.round(group.end - group.start),
        roundTrips: visibleRows(group).map(({ entry, running: isRunning }) => ({
          startedAt: new Date(entry.at).toISOString(),
          ...entry.trip,
          ...(isRunning && { status: 'running', durationMs: Math.round(now() - entry.at) }),
        })),
        ...(group.trace && { tasks: group.trace.tasks }),
      })),
    };
  };

  copyButton.addEventListener('click', async () => {
    const data = shownData();
    const trips = data.groups.reduce((n, g) => n + g.roundTrips.length, 0);
    try {
      await deps.copy(JSON.stringify(data, null, 2));
      say(
        `Copied ${trips} round trip${trips === 1 ? '' : 's'} in ${data.groups.length} group${data.groups.length === 1 ? '' : 's'} as JSON.`,
      );
    } catch (error) {
      say(`Could not copy: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Running rows tick.
  const ticker = win.setInterval(() => {
    if (!paused && running.size > 0) render();
  }, TICK_MS);

  updatePause();
  render();
  connect();

  return {
    get paused() {
      return paused;
    },
    destroy() {
      destroyed = true;
      win.clearInterval(ticker);
      if (reconnect !== undefined) win.clearTimeout(reconnect);
      port?.disconnect();
    },
  };
}
