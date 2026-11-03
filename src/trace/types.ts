// The shape of a click's trace (PR 9.1): the tasks a click ran, each with
// when it started and how long it took. The content script records its own
// tasks (src/trace/clickTrace.ts) and the service worker records its tasks in
// src/explain/explainHandler.ts and returns them with the result.
//
// Types only, so the content script and the service worker can both use it
// without sharing any code (see src/content.ts and PR 7.4).

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
  /** Left out when the task finished normally. */
  status?: 'failed' | 'skipped';
  /** For the model's task: when the first piece of the reply arrived, from the task's start. */
  firstChunkMs?: number;
}

/** The service worker's tasks for one request, timed from when it got the request. */
export interface WorkerTrace {
  tasks: TraceTask[];
  /** From getting the request to sending the result. */
  totalMs: number;
}
