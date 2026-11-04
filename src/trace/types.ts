// The shape of a click's trace (PR 9.1): the tasks a click ran, each with
// when it started and how long it took. The content script records its own
// tasks (src/trace/clickTrace.ts) and the service worker records its tasks in
// src/explain/explainHandler.ts and returns them with the result.
//
// Types only, so the content script and the service worker can both use it
// without sharing any code (see src/content.ts and PR 7.4).

import type { LlmTimings } from '../llm/types';

/** Who ran a task: the GitHub page, the service worker, or the model. */
export type TaskSource = 'page' | 'worker' | 'model';

export interface TraceTask {
  /** Names the task, such as "fit-prompt". */
  key: string;
  /** What the popup's Details and the console call it. */
  label: string;
  source: TaskSource;
  /** When it started, in milliseconds from the trace's start. */
  startMs: number;
  durationMs: number;
  /**
   * Left out when the task finished normally. "stopped": still running when
   * the click was stopped or its request failed (PR 9.3).
   */
  status?: 'failed' | 'skipped' | 'stopped';
  /** For the model's task: when the first piece of the reply arrived, from the task's start. */
  firstChunkMs?: number;
}

/** The service worker's tasks for one request, timed from when it got the request. */
export interface WorkerTrace {
  tasks: TraceTask[];
  /** From getting the request to sending the result. */
  totalMs: number;
  /** The service worker's round trips to Ollama (PR 9.2), timed like the tasks. */
  roundTrips?: RoundTrip[];
}

/** Where a round trip went (PR 9.2). */
export type RoundTripTarget = 'github' | 'ollama';

/**
 * What a round trip was made for (PR 9.2). Only a click's own round trips
 * count against it. The others are shown with their cause:
 * - page: read when the page opened, still running when the click came.
 * - hover: Explain on hover (PR 8.7) asked first, and the click joined it.
 * - ahead: Explain ahead (PR 9.10) asked first, and the click joined it.
 * - warmup: the model was still loading for the PR (PR 8.3).
 * - chat: a question in the chat panel (recorded for the debug log, PR 9.3).
 */
export type RoundTripCause = 'click' | 'page' | 'hover' | 'ahead' | 'warmup' | 'chat';

export type RoundTripStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'refused';

/** One request to GitHub or Ollama and its reply (PR 9.2). */
export interface RoundTrip {
  target: RoundTripTarget;
  method: string;
  /** Host and path, such as "localhost:11434/api/chat" (no query). */
  endpoint: string;
  /** Why it was made, such as "explanation" or "file at head". */
  purpose: string;
  cause: RoundTripCause;
  /** When it started, in milliseconds from the trace's start (negative: before it). */
  startMs: number;
  /** Until the whole reply was read, or until now while running. */
  durationMs: number;
  status: RoundTripStatus;
  /** The HTTP status, when an answer arrived. */
  httpStatus?: number;
  /** What went wrong, for a failed, cancelled or refused request. */
  error?: string;
  bytesSent: number;
  bytesReceived: number;
  /** For /api/chat: the messages sent. */
  messages?: { role: string; content: string }[];
  /** For /api/chat: the `think` sent (PR 9.5), on, off or a level, when one was. */
  think?: boolean | string;
  /** For /api/chat: the reply's text as the model wrote it, thinking included. */
  reply?: string;
  /** For /api/chat: thinking Ollama returned in its own field. */
  thinking?: string;
  /** For /api/chat: where Ollama says its time went, from the reply's last line (PR 9.4). */
  timings?: LlmTimings;
  /**
   * Names one of the service worker's round trips while it runs and once it
   * ends, so the debug window can replace a running row with the finished
   * one (PR 9.4).
   */
  id?: string;
}
