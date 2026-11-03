// A click's trace (PR 9.1): every task a click runs, with when it started
// and how long it took, measured from the click. The content script records
// its own tasks here (finding the code, reading the PR description, fetching
// the file, sending the request, showing the answer). The service worker
// records its own and returns them with the result (src/explain/
// explainHandler.ts); addWorker lines them up with the content script's by
// the moment the request was sent, so the two sides share no code (PR 7.4).
//
// The popup's Details (src/popup/latencyBreakdown.ts) and the console line
// (traceLine, below) both show the result.
//
// The trace also gathers the click's round trips (PR 9.2): the content
// script's to GitHub (addRoundTrips) and the service worker's to Ollama,
// which come with its tasks and are lined up the same way.

import type { RoundTrip, TraceTask, WorkerTrace } from './types';

export interface ClickTrace {
  /** Names this click in the debug log (PR 9.3), shared with its request to the service worker. */
  readonly id: string;
  /** When the click came (Date.now()). */
  readonly startedAt: number;
  /** Milliseconds since the trace started (the click). */
  now(): number;
  /** Starts a task on the page; call the returned function when it ends. */
  start(key: string, label: string): (status?: 'failed' | 'skipped') => void;
  /** Records `work` as a task: failed when it rejects, otherwise done. Returns `work`. */
  time<T>(key: string, label: string, work: Promise<T>): Promise<T>;
  /** Records a task that did not need to run, such as a fetch for removed lines. */
  skip(key: string, label: string): void;
  /** Notes that the request was sent to the service worker now. */
  markSent(): void;
  /**
   * Adds the service worker's tasks, lined up with the moment the request
   * was sent. When this click did not send it (it joined a hover prefetch,
   * PR 8.7), they are lined up so they end now, and any part from before the
   * click is cut off.
   */
  addWorker(trace: WorkerTrace | undefined): void;
  /** Adds the Show answer task: from the service worker's last task to now. */
  finish(): void;
  /** The tasks so far, in the order they started. */
  tasks(): TraceTask[];
  /** Adds the page's round trips, already timed from the click. */
  addRoundTrips(trips: readonly RoundTrip[]): void;
  /** The round trips so far, in the order they started. */
  roundTrips(): RoundTrip[];
}

export function createClickTrace(
  clock: () => number = () => performance.now(),
  wallClock: () => number = Date.now,
): ClickTrace {
  const origin = clock();
  const startedAt = wallClock();
  const now = () => clock() - origin;
  const list: TraceTask[] = [];
  const trips: RoundTrip[] = [];
  let sentAt: number | undefined;
  // Where the service worker's last task ended, for Show answer.
  let workerEnd: number | undefined;

  const add = (task: Omit<TraceTask, 'source'> & { source?: TraceTask['source'] }) =>
    list.push({ source: 'page', ...task });

  const start: ClickTrace['start'] = (key, label) => {
    const startMs = now();
    let ended = false;
    return (status) => {
      if (ended) return;
      ended = true;
      add({ key, label, startMs, durationMs: now() - startMs, ...(status && { status }) });
    };
  };

  return {
    id: crypto.randomUUID(),
    startedAt,
    now,
    start,
    time(key, label, work) {
      const end = start(key, label);
      work.then(
        () => end(),
        () => end('failed'),
      );
      return work;
    },
    skip(key, label) {
      add({ key, label, startMs: now(), durationMs: 0, status: 'skipped' });
    },
    markSent() {
      sentAt = now();
    },
    addWorker(trace) {
      if (!trace) return;
      const offset = sentAt ?? now() - trace.totalMs;
      for (const task of trace.tasks) {
        let startMs = offset + task.startMs;
        let durationMs = task.durationMs;
        if (startMs < 0) {
          // Before the click (a joined prefetch): keep only the part after it.
          durationMs += startMs;
          startMs = 0;
          if (durationMs <= 0) continue;
        }
        const firstChunk =
          task.firstChunkMs === undefined
            ? undefined
            : offset + task.startMs + task.firstChunkMs - startMs;
        list.push({
          ...task,
          startMs,
          durationMs,
          ...(firstChunk !== undefined && { firstChunkMs: Math.max(0, firstChunk) }),
        });
      }
      // Round trips keep a start before the click: it says they began earlier.
      for (const trip of trace.roundTrips ?? []) {
        trips.push({ ...trip, startMs: offset + trip.startMs });
      }
      workerEnd = Math.max(0, offset + trace.totalMs);
    },
    finish() {
      const end = now();
      const startMs = Math.min(end, workerEnd ?? end);
      add({ key: 'show', label: 'Show answer', startMs, durationMs: end - startMs });
    },
    tasks: () => [...list].sort((a, b) => a.startMs - b.startMs),
    addRoundTrips(page) {
      trips.push(...page);
    },
    roundTrips: () => [...trips].sort((a, b) => a.startMs - b.startMs),
  };
}

/** "45 ms" under a second, then "1.2 s". */
export function formatMs(ms: number): string {
  const value = Math.max(0, ms);
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/** A task as the console line shows it. */
export interface TraceLineTask {
  label: string;
  durationMs: number;
  status?: 'failed' | 'skipped';
  /** True when the time is an estimate (Think and Write answer, PR 9.1). */
  estimated?: boolean;
}

/** The tasks on one line, for the console: "Find the code 2 ms, Think ~20.1 s, …". */
export function traceLine(tasks: readonly TraceLineTask[]): string {
  return tasks
    .map((t) => {
      const time = `${t.estimated ? '~' : ''}${formatMs(t.durationMs)}`;
      if (t.status === 'skipped') return `${t.label} skipped`;
      return `${t.label} ${t.status === 'failed' ? `failed after ${time}` : time}`;
    })
    .join(', ');
}
