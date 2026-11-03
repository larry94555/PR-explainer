// The debug log (PR 9.3), kept by the service worker while the Debug window
// setting is on: every round trip to Ollama and GitHub (PR 9.2), with its
// prompt and reply, and the trace of the click that made it (PR 9.1). The
// debug window (PR 9.4) reads it and follows it live.
//
// It lives in chrome.storage.session: Chrome keeps it in memory, so it
// survives the service worker being stopped, and clears it when Chrome
// closes. Only the newest DEBUG_LOG_LIMIT entries are kept. When the setting
// is off nothing is added, and turning it off empties the log. Nothing in it
// leaves the computer (see PRIVACY.md).
//
// The service worker adds its own round trips to Ollama as each one ends
// (src/net/roundTrips.ts). While one runs, its reply so far is sent to the
// debug window (PR 9.4) with `progress`, but never stored: the window shows
// it growing, and the finished entry takes its place. The content script sends its GitHub round trips
// and the click's trace with a `debugLogAdd` request once the answer is
// shown; pageEntries checks that message before it is kept.

import { storageKey } from '../settings';
import type { PortLike, PortRuntime } from '../messaging/protocol';
import type { RoundTripLog } from '../net/roundTrips';
import type { RoundTrip, RoundTripCause, RoundTripStatus, TraceTask } from '../trace/types';
import type {
  DebugCause,
  DebugEntry,
  DebugEntryInput,
  DebugLogPortMessage,
  DebugLogPortName,
  DebugRunningEntry,
} from './types';

export const DEBUG_LOG_KEY = 'debugLog';
export const DEBUG_LOG_LIMIT = 200;
export const DEBUG_LOG_PORT: DebugLogPortName = 'pr-explainer:debugLog';

/** The part of chrome.storage.session the log uses. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface Stored {
  /** The id the next entry gets, kept across Clear so ids never repeat. */
  nextId: number;
  entries: DebugEntry[];
}

export interface DebugLog {
  /** Adds entries in order and sends each to the listeners. Does nothing when the setting is off. */
  add(items: readonly DebugEntryInput[]): Promise<DebugEntry[]>;
  /** The entries kept, oldest first. */
  read(): Promise<DebugEntry[]>;
  /** Empties the log and tells the listeners. */
  clear(): Promise<void>;
  /**
   * Tells the listeners about a round trip still running (PR 9.4), and keeps
   * it in memory until its finished entry is added. Does nothing when the
   * setting is off.
   */
  progress(item: DebugRunningEntry): Promise<void>;
  /** The entries kept and the round trips still running, for a window that just connected. */
  snapshot(): Promise<{ entries: DebugEntry[]; running: DebugRunningEntry[] }>;
  /** Calls `listener` with each new entry and each clear, until the returned function is called. */
  listen(listener: (message: DebugLogPortMessage) => void): () => void;
}

export interface DebugLogDeps {
  storage: SessionStorageLike;
  /** Whether the Debug window setting is on. */
  isOn(): Promise<boolean>;
}

export function createDebugLog({ storage, isOn }: DebugLogDeps): DebugLog {
  const listeners = new Set<(message: DebugLogPortMessage) => void>();
  // Round trips still running, by trip id. A service worker that restarts
  // forgets them, as it forgets the requests themselves.
  const running = new Map<string, DebugRunningEntry>();
  // Trip ids that have ended, so an update that comes late is dropped.
  const finished = new Set<string>();
  // One change at a time, so two round trips ending together are both kept.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<Stored> => {
    const raw = (await storage.get([DEBUG_LOG_KEY]))[DEBUG_LOG_KEY] as Partial<Stored> | undefined;
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const nextId =
      typeof raw?.nextId === 'number' && Number.isInteger(raw.nextId) && raw.nextId > 0
        ? raw.nextId
        : 1;
    return { nextId, entries };
  };

  // Session storage holds about 10 MB, shared with the explanation cache. If
  // the log does not fit, the oldest half is dropped until it does.
  const save = async (stored: Stored): Promise<void> => {
    for (;;) {
      try {
        await storage.set({ [DEBUG_LOG_KEY]: stored });
        return;
      } catch (error) {
        if (stored.entries.length === 0) throw error;
        stored.entries = stored.entries.slice(Math.ceil(stored.entries.length / 2));
      }
    }
  };

  const emit = (message: DebugLogPortMessage) => {
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // One listener failing must not stop the others.
      }
    }
  };

  const on = async () => {
    try {
      return await isOn();
    } catch {
      return false;
    }
  };

  return {
    add: (items) =>
      serial(async () => {
        if (items.length === 0 || !(await on())) return [];
        const stored = await load();
        const added = items.map((item) => ({ ...item, id: stored.nextId++ }) as DebugEntry);
        for (const item of items) {
          if (item.kind !== 'round-trip' || !item.trip.id) continue;
          running.delete(item.trip.id);
          if (finished.size >= DEBUG_LOG_LIMIT * 5) finished.clear();
          finished.add(item.trip.id);
        }
        stored.entries = [...stored.entries, ...added].slice(-DEBUG_LOG_LIMIT);
        await save(stored);
        for (const entry of added) emit({ type: 'entry', entry });
        return added;
      }),
    read: () => serial(async () => (await load()).entries),
    clear: () =>
      serial(async () => {
        const stored = await load();
        await save({ nextId: stored.nextId, entries: [] });
        running.clear();
        emit({ type: 'cleared' });
      }),
    // In the same queue as add, so a late update never comes after its end.
    progress: (item) =>
      serial(async () => {
        const id = item.trip.id;
        if (!id || item.trip.status !== 'running' || finished.has(id) || !(await on())) return;
        running.set(id, item);
        emit({ type: 'running', entry: item });
      }),
    snapshot: () =>
      serial(async () => ({ entries: (await load()).entries, running: [...running.values()] })),
    listen(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The debug log's cause for a round trip's cause ("page" GitHub reads belong to a click). */
function debugCause(cause: RoundTripCause): DebugCause {
  return cause === 'page' ? 'click' : cause;
}

/** The entry for a round trip the service worker made, as it runs or ends. */
export function workerEntry(
  trip: RoundTrip,
  log: Pick<RoundTripLog, 'group' | 'cause' | 'origin'>,
): DebugRunningEntry {
  return {
    kind: 'round-trip',
    group: log.group,
    cause: debugCause(log.cause),
    at: log.origin + trip.startMs,
    trip,
  };
}

// --- Checking what the content script sends ---

const MAX_TEXT = 500;
const MAX_TRIPS = 50;
const MAX_TASKS = 100;
const STATUSES = new Set<RoundTripStatus>(['running', 'done', 'failed', 'cancelled', 'refused']);
const TRIP_CAUSES = new Set<RoundTripCause>(['click', 'page', 'hover']);
const TASK_SOURCES = new Set<TraceTask['source']>(['page', 'worker', 'model']);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;

/** A GitHub round trip from the content script, or undefined when it is not one. */
function githubTrip(value: unknown): RoundTrip | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.target !== 'github') return undefined;
  const status = v.status as RoundTripStatus;
  const cause = v.cause as RoundTripCause;
  if (!STATUSES.has(status) || !TRIP_CAUSES.has(cause)) return undefined;
  const nums = [v.startMs, v.durationMs, v.bytesSent, v.bytesReceived];
  if (!nums.every(isNumber)) return undefined;
  const endpoint = text(v.endpoint);
  const purpose = text(v.purpose);
  if (endpoint === undefined || purpose === undefined) return undefined;
  const error = text(v.error);
  return {
    target: 'github',
    method: text(v.method) ?? 'GET',
    endpoint,
    purpose,
    cause,
    startMs: v.startMs as number,
    durationMs: v.durationMs as number,
    status,
    ...(isNumber(v.httpStatus) && { httpStatus: v.httpStatus }),
    ...(error !== undefined && { error }),
    bytesSent: v.bytesSent as number,
    bytesReceived: v.bytesReceived as number,
  };
}

/** A task of a click's trace, or undefined when it is not one. */
function traceTask(value: unknown): TraceTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const key = text(v.key);
  const label = text(v.label);
  const source = v.source as TraceTask['source'];
  if (key === undefined || label === undefined || !TASK_SOURCES.has(source)) return undefined;
  if (!isNumber(v.startMs) || !isNumber(v.durationMs)) return undefined;
  return {
    key,
    label,
    source,
    startMs: v.startMs,
    durationMs: v.durationMs,
    ...((v.status === 'failed' || v.status === 'skipped' || v.status === 'stopped') && {
      status: v.status,
    }),
    ...(isNumber(v.firstChunkMs) && { firstChunkMs: v.firstChunkMs }),
  };
}

/**
 * The entries for a `debugLogAdd` request from the content script: the
 * click's trace, then its GitHub round trips. Anything that is not in the
 * expected shape is left out, so a bad message cannot fill the log.
 */
export function pageEntries(payload: unknown): DebugEntryInput[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const p = payload as Record<string, unknown>;
  const group = text(p.group);
  if (!group || !isNumber(p.at)) return [];
  const at = p.at;
  const base = {
    group,
    cause: p.cause === 'hover' ? ('hover' as const) : ('click' as const),
    at,
    ...(text(p.where) !== undefined && { where: text(p.where) }),
  };
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(0, max) : []);
  const tasks = list(p.tasks, MAX_TASKS)
    .map(traceTask)
    .filter((t) => t !== undefined);
  const trips = list(p.roundTrips, MAX_TRIPS)
    .map(githubTrip)
    .filter((t) => t !== undefined);
  return [
    ...(tasks.length > 0 ? [{ ...base, kind: 'trace' as const, tasks }] : []),
    ...trips.map((trip) => ({
      ...base,
      kind: 'round-trip' as const,
      at: at + trip.startMs,
      trip,
    })),
  ];
}

// --- Wiring ---

/**
 * Sends the log as it is, then each new entry, running round trip and clear,
 * to every extension page connected on the debug log port. A GitHub page's
 * content script cannot connect: only pages of this extension (such as the
 * debug window) can.
 */
export function listenForDebugLogPorts(runtime: PortRuntime, log: DebugLog): void {
  runtime.onConnect.addListener((port: PortLike) => {
    if (port.name !== DEBUG_LOG_PORT) return;
    const url = port.sender?.url ?? '';
    if (!url.startsWith(`chrome-extension://${runtime.id}/`)) {
      port.disconnect();
      return;
    }
    let open = true;
    const send = (message: DebugLogPortMessage) => {
      if (!open) return;
      try {
        port.postMessage(message);
      } catch {
        close();
      }
    };
    // Listening first, so nothing added while the snapshot is read is
    // missed. An entry sent both ways has the same id, and the window keeps one.
    const stop = log.listen(send);
    const close = () => {
      open = false;
      stop();
    };
    port.onDisconnect.addListener(close);
    log.snapshot().then(
      (snapshot) => send({ type: 'snapshot', ...snapshot }),
      () => send({ type: 'snapshot', entries: [], running: [] }),
    );
  });
}

/** The part of chrome.storage.onChanged used here. */
export interface StorageChangedLike {
  addListener(
    listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
  ): void;
}

/** Empties the log when the Debug window setting is turned off. */
export function clearWhenTurnedOff(onChanged: StorageChangedLike, log: DebugLog): void {
  const key = storageKey('debugWindow');
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    if (changes[key]?.newValue !== true) void log.clear();
  });
}
