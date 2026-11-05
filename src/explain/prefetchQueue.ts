// The background queue (PR 10.3): one place in the service worker that
// decides which explanation runs next, how many run at once, and what gives
// way to a click. Every explain request from a PR tab goes through it, so two
// tabs share one queue instead of each keeping the model busy.
//
// A job is one request (one line, built as a click would build it, or every
// changed line of a hunk, PR 10.5) with a priority. Jobs run highest priority first,
// then in the order their lines appear in the PR (`order`), then in the order
// they came. At most `concurrency` jobs run at once (1 by default), and no
// background job starts while a click runs.
//
// - A click always runs at once. It stops the background jobs that are
//   running (so Ollama is free for it) and puts them back at the front of
//   their priority. A click that joins a job already running does the same,
//   without stopping that job. A hovered line does the same to the lower jobs when
//   there is no room, since the pointer resting on it says a click is near
//   (as before, PR 8.7); the other priorities wait for room, so scrolling
//   never throws away work in progress.
// - A job for a request already queued or running is merged with it: it
//   gets the same answer from one request, and the job keeps the higher of
//   the two priorities. A click that joins a running job gets what the model
//   has written so far, then the rest. Regenerate never joins (the caller
//   gives it an id of its own).
// - A hunk job names the line jobs it answers (`covers`). A click, or a
//   hover, on one of those lines while the hunk job runs waits for it
//   instead of sending its own request, and is then answered from the cache.
//   The click still stops the other background jobs. Lines the hunk's answer
//   left out come back as single-line jobs (`followUps`), first in their
//   priority, kept for the tabs that asked for the hunk.
// - A job whose answer is in the cache finishes at once (the handler answers
//   it from the cache without the model) and is logged as skipped.
// - A background job that fails is tried once more after the others of its
//   priority, then given up on. A click is never tried again by itself.
// - While paused (PR 11.3: on battery, src/backgroundPause.ts), no
//   background job starts; those running finish, and the rest wait until it
//   is resumed. Clicks still run at once.
// - A job whose callers have all gone (the popup closed, the tab moved on) is
//   dropped, and stopped if it is running. Jobs can also be re-prioritised
//   and dropped by PR. Closing a tab lets go of only that tab's callers, so a
//   job another tab also waits for keeps running.
// - Chrome stops the service worker after about 30 seconds with no events
//   (PR 11.5). `onChange` hears every change, so the worker can save
//   `saved()` (the background jobs, running ones first, without answers) to
//   chrome.storage.session (src/explain/savedQueue.ts), and `restore` puts
//   them back when it starts again: a job that was running goes first in
//   its priority, and the rest keep their order. A request for a restored
//   job joins it, so nothing is done twice.
//
// It knows nothing about Chrome or Ollama: `run` does the work (the explain
// handler in src/background.ts), so the tests drive it with a fake.

import type { ExplainPayload } from './explainHandler';

/** Highest first. Only clicks start straight away. */
export const PRIORITIES = ['click', 'hovered', 'on-screen', 'near-screen', 'rest'] as const;
export type JobPriority = (typeof PRIORITIES)[number];

export const DEFAULT_CONCURRENCY = 1;

/** How many times a background job is run before it is given up on. */
export const MAX_ATTEMPTS = 2;

export const isJobPriority = (value: unknown): value is JobPriority =>
  (PRIORITIES as readonly unknown[]).includes(value);

const rank = (priority: JobPriority) => PRIORITIES.indexOf(priority);

export interface JobSpec<P> {
  /** Names the request: two jobs with the same id are merged. */
  id: string;
  /** A short name for the debug window, such as "src/a.ts:added:12". */
  label: string;
  priority: JobPriority;
  /** The tab that asked, so its jobs can be dropped when it closes. */
  tab?: number;
  /** The PR, such as "owner/repo#17". */
  pr?: string;
  /** Where the line is in the PR, for the order within a priority. Lower first. */
  order?: number;
  payload: P;
  /**
   * For a hunk job (PR 10.5): the ids of the line jobs it answers. A click on
   * one of those lines while it runs waits for it instead of running.
   */
  covers?: readonly string[];
}

export type QueueEventType =
  | 'queued'
  | 'started'
  | 'finished'
  | 'skipped'
  | 'failed'
  | 'retry'
  | 'cancelled'
  | 'joined'
  | 'dropped'
  /** The worker started again and put back the jobs it had saved (PR 11.5). */
  | 'restored';

export interface QueueEvent {
  type: QueueEventType;
  label: string;
  priority: JobPriority;
  tab?: number;
  /** For finished, skipped, failed, retry and cancelled: how long the run took. */
  elapsedMs?: number;
  /** Jobs running and waiting once this event has happened. */
  running: number;
  waiting: number;
}

export interface QueueDeps<P, R> {
  run(payload: P, options: { signal: AbortSignal; onChunk(text: string): void }): Promise<R>;
  /** True when a result is a failure (a background job is then tried once more). */
  failed?(result: R): boolean;
  /** True when a result came from the cache, so the job is logged as skipped. */
  cached?(result: R): boolean;
  /**
   * Jobs to queue once `spec` has finished with `result`: for a hunk job,
   * the lines its answer left out (PR 10.5). They take its priority.
   */
  followUps?(spec: JobSpec<P>, result: R): JobSpec<P>[];
  /**
   * How many jobs run at once. A function is read each time a job could
   * start, so a change to Requests at once (PR 10.6) applies at once.
   */
  concurrency?: number | (() => number);
  /** Hears every change to the jobs, so they can be saved (PR 11.5). */
  onChange?(): void;
  /** Clock in milliseconds. Defaults to Date.now. */
  now?(): number;
  onEvent?(event: QueueEvent): void;
}

export interface AddOptions {
  /** Pieces of the answer as they are written. Only clicks get them. */
  onChunk?(text: string): void;
  /** Aborting it means this caller has gone. */
  signal?: AbortSignal;
}

export interface PrefetchQueue<P, R> {
  /** Queues a job (or joins the one with the same id) and resolves with its answer. */
  add(spec: JobSpec<P>, options?: AddOptions): Promise<R>;
  /** Gives the waiting background jobs `match` picks a new priority. Returns how many. */
  prioritise(match: (spec: JobSpec<P>) => boolean, priority: JobPriority): number;
  /** Drops the jobs `match` picks (stopping running ones). Returns how many. */
  drop(match: (spec: JobSpec<P>) => boolean): number;
  /**
   * Lets go of everything a closed tab asked for: its callers leave their
   * jobs, and a job is dropped only when nobody else is waiting for it (a
   * job shared with another tab keeps running for that tab). Returns how
   * many jobs were dropped.
   */
  dropTab(tab: number): number;
  /**
   * Pauses or resumes background jobs (PR 11.3). While paused, only clicks
   * start; running background jobs are let finish.
   */
  setPaused(paused: boolean): void;
  /** The labels of the running and waiting jobs, in the order they would run. */
  state(): { running: string[]; waiting: string[] };
  /**
   * The background jobs to keep across a worker restart (PR 11.5): running
   * ones first, then the waiting ones in the order they would run. Clicks
   * and Regenerate are left out, as their popup's port closes with the
   * worker, and so are hovers, as the pointer has moved on by then.
   */
  saved(): SavedJob<P>[];
  /**
   * Puts back jobs saved by an earlier worker, ahead of anything queued
   * since in their priority, in the order given. A job already queued (a
   * page asked again first) is kept as it is. Returns how many were put back.
   */
  restore(saved: readonly SavedJob<P>[]): number;
}

/** A background job as it is saved across a worker restart (PR 11.5). */
export interface SavedJob<P> {
  spec: JobSpec<P>;
  /** The tabs waiting for it, so closing one still lets go of it. */
  tabs: number[];
  /** It was running when saved. */
  running?: boolean;
}

/** The priorities a saved job can have: background work a page does not wait on. */
const SAVED_PRIORITIES: readonly JobPriority[] = ['on-screen', 'near-screen', 'rest'];

interface Caller<R> {
  click: boolean;
  /** The tab that asked, so closing it lets go of only its own callers. */
  tab?: number;
  onChunk?(text: string): void;
  resolve(result: R): void;
  reject(error: unknown): void;
}

interface Job<P, R> {
  spec: JobSpec<P>;
  seq: number;
  /** Below 0 for a job put back by a click: the most recent first. */
  front: number;
  attempts: number;
  callers: Set<Caller<R>>;
  run?: { controller: AbortController; chunks: string[]; startedAt: number };
}

function abortError(): Error {
  return Object.assign(new Error('Stopped: nobody is waiting for this answer'), {
    name: 'AbortError',
  });
}

export function createPrefetchQueue<P, R>(deps: QueueDeps<P, R>): PrefetchQueue<P, R> {
  const concurrency = () => {
    const value = typeof deps.concurrency === 'function' ? deps.concurrency() : deps.concurrency;
    return Math.max(1, Math.floor(value ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY);
  };
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, Job<P, R>>();
  let seq = 0;
  let front = 0;
  let paused = false;

  const running = () => [...jobs.values()].filter((job) => job.run);
  const waiting = () =>
    [...jobs.values()]
      .filter((job) => !job.run)
      .sort(
        (a, b) =>
          rank(a.spec.priority) - rank(b.spec.priority) ||
          a.front - b.front ||
          (a.spec.order ?? Infinity) - (b.spec.order ?? Infinity) ||
          a.seq - b.seq,
      );

  const emit = (type: QueueEventType, job: Job<P, R>, elapsedMs?: number) => {
    deps.onChange?.();
    if (!deps.onEvent) return;
    const runningCount = running().length;
    deps.onEvent({
      type,
      label: job.spec.label,
      priority: job.spec.priority,
      ...(job.spec.tab !== undefined && { tab: job.spec.tab }),
      ...(elapsedMs !== undefined && { elapsedMs }),
      running: runningCount,
      waiting: jobs.size - runningCount,
    });
  };

  /** Stops a running job and puts it back at the front of its priority. */
  const putBack = (job: Job<P, R>) => {
    const { run } = job;
    if (!run) return;
    job.run = undefined;
    run.controller.abort();
    job.front = --front;
    emit('cancelled', job, now() - run.startedAt);
  };

  const settle = (job: Job<P, R>, outcome: { result: R } | { error: unknown }) => {
    jobs.delete(job.spec.id);
    for (const caller of job.callers) {
      if ('result' in outcome) caller.resolve(outcome.result);
      else caller.reject(outcome.error);
    }
    job.callers.clear();
  };

  const start = (job: Job<P, R>) => {
    const controller = new AbortController();
    const run = { controller, chunks: [] as string[], startedAt: now() };
    job.run = run;
    job.attempts += 1;
    emit('started', job);
    const ended = (outcome: { result: R } | { error: unknown }) => {
      // Stopped by a click or dropped: this run's answer is not wanted.
      if (job.run !== run) return;
      const tabs = new Set([...job.callers].map((caller) => caller.tab));
      job.run = undefined;
      const elapsedMs = now() - run.startedAt;
      const failed = 'error' in outcome || deps.failed?.(outcome.result) === true;
      if (failed && job.spec.priority !== 'click' && job.attempts < MAX_ATTEMPTS) {
        // After the others of its priority.
        job.seq = ++seq;
        job.front = 0;
        emit('retry', job, elapsedMs);
      } else {
        const type = failed
          ? 'failed'
          : 'result' in outcome && deps.cached?.(outcome.result)
            ? 'skipped'
            : 'finished';
        settle(job, outcome);
        emit(type, job, elapsedMs);
        if (!failed && 'result' in outcome) queueFollowUps(job, outcome.result, tabs);
      }
      pump();
    };
    let reply: Promise<R>;
    try {
      reply = deps.run(job.spec.payload, {
        signal: controller.signal,
        onChunk: (text) => {
          if (job.run !== run) return;
          run.chunks.push(text);
          for (const caller of job.callers) if (caller.click) caller.onChunk?.(text);
        },
      });
    } catch (error) {
      reply = Promise.reject(error);
    }
    reply.then(
      (result) => ended({ result }),
      (error: unknown) => ended({ error }),
    );
  };

  /**
   * Queues the jobs `deps.followUps` gives for a finished job, first in its
   * priority, in the order given, each kept for the tabs that asked for it.
   */
  const queueFollowUps = (done: Job<P, R>, result: R, tabs: Set<number | undefined>) => {
    const specs = (deps.followUps?.(done.spec, result) ?? []).filter((s) => !jobs.has(s.id));
    front -= specs.length;
    specs.forEach((spec, i) => {
      const job: Job<P, R> = {
        spec: { ...spec, priority: done.spec.priority },
        seq: ++seq,
        front: front + i,
        attempts: 0,
        // Nobody waits for the answer, which goes to the cache; closing the
        // tab lets go of it.
        callers: new Set(
          [...tabs].map((tab) => ({
            click: false,
            ...(tab !== undefined && { tab }),
            resolve: () => {},
            reject: () => {},
          })),
        ),
      };
      jobs.set(spec.id, job);
      emit('queued', job);
    });
  };

  /** A running job that answers `job` as part of a hunk (PR 10.5). */
  const coveredBy = (job: Job<P, R>) =>
    running().find((other) => other !== job && other.spec.covers?.includes(job.spec.id));

  /** Stops the background jobs in a click's way, except `keep`. */
  const makeRoom = (keep: Job<P, R>) => {
    for (const other of running()) {
      if (other !== keep && other.spec.priority !== 'click') putBack(other);
    }
  };

  /** Starts a click at once, stopping the background jobs in its way. */
  const startClick = (job: Job<P, R>) => {
    makeRoom(job);
    if (!job.run) start(job);
  };

  /** A running background job of lower priority than `job`, the lowest first. */
  const lowerRunning = (job: Job<P, R>) =>
    running()
      .filter((other) => rank(other.spec.priority) > rank(job.spec.priority))
      .sort((a, b) => rank(b.spec.priority) - rank(a.spec.priority))[0];

  /** A click is running, or waiting for the hunk job that answers it. */
  const clickActive = () => [...jobs.values()].some((job) => job.spec.priority === 'click');

  /** Starts waiting jobs while there is room. */
  function pump(): void {
    for (const job of waiting()) {
      const cover = coveredBy(job);
      if (job.spec.priority === 'click') {
        // The hunk job answering this line goes on alone; then the click
        // finds the answer in the cache.
        if (cover) makeRoom(cover);
        else startClick(job);
      }
      // While a click runs, the background waits, so the click has Ollama to itself.
      else if (clickActive()) continue;
      // On battery (PR 11.3): nothing new starts until it is resumed.
      else if (paused) continue;
      // A line being answered as part of a hunk waits for it.
      else if (cover) continue;
      else if (running().length < concurrency()) start(job);
      else if (job.spec.priority === 'hovered') {
        const lower = lowerRunning(job);
        if (lower) {
          putBack(lower);
          start(job);
        }
      }
    }
  }

  const remove = (job: Job<P, R>) => {
    const { run } = job;
    job.run = undefined;
    run?.controller.abort();
    settle(job, { error: abortError() });
    emit('dropped', job, run && now() - run.startedAt);
  };

  /**
   * Takes `caller` off `job` (rejecting it), and drops the job when nobody
   * else waits for it. True when the job was dropped.
   */
  const leave = (job: Job<P, R>, caller: Caller<R>): boolean => {
    if (!job.callers.delete(caller)) return false;
    caller.reject(abortError());
    if (job.callers.size > 0 || jobs.get(job.spec.id) !== job) return false;
    remove(job);
    return true;
  };

  const add = (spec: JobSpec<P>, options: AddOptions = {}): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const click = spec.priority === 'click';
      const caller: Caller<R> = {
        click,
        ...(spec.tab !== undefined && { tab: spec.tab }),
        onChunk: options.onChunk,
        resolve,
        reject,
      };
      let job = jobs.get(spec.id);
      if (job) {
        if (rank(spec.priority) < rank(job.spec.priority)) {
          job.spec = { ...job.spec, priority: spec.priority, label: spec.label };
        }
        job.callers.add(caller);
        emit('joined', job);
        // What the model has written so far, then the rest as it comes.
        const soFar = job.run?.chunks.join('');
        if (click && soFar) options.onChunk?.(soFar);
        // A click joining a running job keeps it going and stops the other
        // background jobs, as a new click would.
        if (click && job.run) startClick(job);
      } else {
        job = { spec, seq: ++seq, front: 0, attempts: 0, callers: new Set([caller]) };
        jobs.set(spec.id, job);
        emit('queued', job);
      }
      const joined = job;
      options.signal?.addEventListener(
        'abort',
        () => {
          if (leave(joined, caller)) pump();
        },
        { once: true },
      );
      pump();
    });

  /** A caller that waits for nothing: the answer goes to the cache. */
  const placeholder = (tab?: number): Caller<R> => ({
    click: false,
    ...(tab !== undefined && { tab }),
    resolve: () => {},
    reject: () => {},
  });

  const saved = (): SavedJob<P>[] => {
    const keep = (job: Job<P, R>) => SAVED_PRIORITIES.includes(job.spec.priority);
    const save = (job: Job<P, R>): SavedJob<P> => {
      const tabs = [...job.callers].flatMap((caller) =>
        caller.tab === undefined ? [] : [caller.tab],
      );
      return {
        spec: job.spec,
        tabs: [...new Set(tabs)],
        ...(job.run && { running: true }),
      };
    };
    return [...running().filter(keep).map(save), ...waiting().filter(keep).map(save)];
  };

  const restore = (list: readonly SavedJob<P>[]): number => {
    const fresh = list.filter(
      (item) => SAVED_PRIORITIES.includes(item.spec.priority) && !jobs.has(item.spec.id),
    );
    // Ahead of the jobs queued since, in the order saved.
    front -= fresh.length;
    fresh.forEach((item, i) => {
      const callers = item.tabs.length
        ? item.tabs.map((tab) => placeholder(tab))
        : [placeholder(item.spec.tab)];
      jobs.set(item.spec.id, {
        spec: item.spec,
        seq: ++seq,
        front: front + i,
        attempts: 0,
        callers: new Set(callers),
      });
    });
    const runningCount = running().length;
    deps.onChange?.();
    deps.onEvent?.({
      type: 'restored',
      label: `${fresh.length} job${fresh.length === 1 ? '' : 's'} restored`,
      priority: fresh[0]?.spec.priority ?? 'rest',
      running: runningCount,
      waiting: jobs.size - runningCount,
    });
    pump();
    return fresh.length;
  };

  return {
    add,
    saved,
    restore,
    prioritise(match, priority) {
      let changed = 0;
      for (const job of jobs.values()) {
        if (job.run || job.spec.priority === 'click' || !match(job.spec)) continue;
        job.spec = { ...job.spec, priority };
        changed += 1;
      }
      if (changed) {
        deps.onChange?.();
        pump();
      }
      return changed;
    },
    drop(match) {
      const picked = [...jobs.values()].filter((job) => match(job.spec));
      for (const job of picked) remove(job);
      if (picked.length) pump();
      return picked.length;
    },
    dropTab(tab) {
      let dropped = 0;
      for (const job of [...jobs.values()]) {
        for (const caller of [...job.callers]) {
          if (caller.tab === tab && leave(job, caller)) dropped += 1;
        }
      }
      if (dropped) pump();
      return dropped;
    },
    setPaused(value) {
      if (value === paused) return;
      paused = value;
      if (!paused) pump();
    },
    state: () => ({
      running: running().map((job) => job.spec.label),
      waiting: waiting().map((job) => job.spec.label),
    }),
  };
}

/** The queue's priority for why a request was made. */
export function priorityFor(cause: ExplainPayload['cause']): JobPriority {
  return cause === 'hover' ? 'hovered' : cause === 'ahead' ? 'on-screen' : 'click';
}

let freshCount = 0;

/**
 * The job for an explain request from a tab. The same code in the same PR
 * is the same job, so a click on a line being explained ahead or on hover
 * joins it. Regenerate (`fresh`) always gets a job of its own. A hunk
 * request covers the job of each of its lines, so a click on one of them
 * waits for it.
 */
export function explainJob(payload: ExplainPayload, tab?: number): JobSpec<ExplainPayload> {
  // A hunk is only ever background work.
  const base = payload.hunk && payload.cause !== 'hover' ? 'on-screen' : priorityFor(payload.cause);
  // Prefetching the whole PR (PR 10.6) says how near the screen its code is.
  const asked = payload.job?.priority;
  const priority = base === 'on-screen' && asked && rank(asked) >= rank('on-screen') ? asked : base;
  const lineId = (context: string) => `${payload.pr ?? ''}\n${context}`;
  // A hunk (PR 10.5) is named by its lines, and answers each line's job.
  const covers = payload.hunk?.lines.map((line) => lineId(line.context));
  return {
    id:
      payload.fresh === true
        ? `fresh:${++freshCount}`
        : covers
          ? `hunk:${covers.join('\n\u0000')}`
          : lineId(payload.context),
    ...(covers && { covers }),
    label: payload.job?.label ?? (priority === 'click' ? 'clicked code' : 'a line'),
    priority,
    ...(tab !== undefined && { tab }),
    ...(payload.pr !== undefined && { pr: payload.pr }),
    ...(payload.job?.order !== undefined && { order: payload.job.order }),
    payload,
  };
}
