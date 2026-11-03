// The shape of the debug log (PR 9.3): every round trip to GitHub and the
// local LLM, with the trace of the click that made it, kept by the service
// worker (src/debug/debugLog.ts) for the debug window (PR 9.4).
//
// Types only, so the content script, the service worker and the debug window
// can all use them without sharing any code (see src/content.ts and PR 7.4).

import type { RoundTrip, TraceTask } from '../trace/types';

/** What a group of entries was made for: a click, Explain on hover, the warm-up or the chat. */
export type DebugCause = 'click' | 'hover' | 'warmup' | 'chat';

interface DebugEntryBase {
  /** Counts up from 1 in the order entries were added, and never repeats in a browser session. */
  id: number;
  /** Ties together the round trips and the trace of one click (or warm-up, hover or chat question). */
  group: string;
  cause: DebugCause;
  /** When it started (Date.now()). */
  at: number;
  /** The file and lines clicked, such as "src/app.ts:12-18". */
  where?: string;
}

/** One round trip, timed from the start of its group (`startMs`). */
export interface DebugRoundTripEntry extends DebugEntryBase {
  kind: 'round-trip';
  trip: RoundTrip;
}

/** A click's tasks (PR 9.1), timed from the click. */
export interface DebugTraceEntry extends DebugEntryBase {
  kind: 'trace';
  tasks: TraceTask[];
}

export type DebugEntry = DebugRoundTripEntry | DebugTraceEntry;

/** An entry before the log gives it its id. */
export type DebugEntryInput = Omit<DebugRoundTripEntry, 'id'> | Omit<DebugTraceEntry, 'id'>;

/**
 * What the content script sends when a click's answer is shown: its GitHub
 * round trips and the click's whole trace. The service worker records its
 * own round trips to Ollama under the same group.
 */
export interface DebugLogPayload {
  group: string;
  cause?: 'click' | 'hover';
  /** When the click came (Date.now()). */
  at: number;
  where?: string;
  /** Timed from the click; only GitHub ones are kept. */
  roundTrips: RoundTrip[];
  tasks: TraceTask[];
}

/**
 * The debug log port (chrome.runtime.connect from an extension page, such as
 * the debug window). The service worker sends each new entry as it is added,
 * and `cleared` when the log is emptied.
 */
export type DebugLogPortName = 'pr-explainer:debugLog';

/**
 * A round trip of the service worker's that has not ended yet (PR 9.4): its
 * reply so far and its time so far. It is never stored; once it ends, the
 * finished entry (with the same `trip.id`) takes its place.
 */
export type DebugRunningEntry = Omit<DebugRoundTripEntry, 'id'>;

/**
 * `snapshot` is sent once when the window connects: the whole log and the
 * round trips still running. Then `entry` for each new entry, `running` as a
 * round trip starts and as its reply grows, and `cleared` when the log is
 * emptied.
 */
export type DebugLogPortMessage =
  | { type: 'snapshot'; entries: DebugEntry[]; running: DebugRunningEntry[] }
  | { type: 'entry'; entry: DebugEntry }
  | { type: 'running'; entry: DebugRunningEntry }
  | { type: 'cleared' };
