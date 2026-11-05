// Keeps the background queue (PR 10.3, src/explain/prefetchQueue.ts) across
// a service worker restart (PR 11.5). In Manifest V3 Chrome stops the worker
// after about 30 seconds with no events, which can happen between two
// background jobs or while a long prompt is read. The queue lives in the
// worker's memory, so without this a whole-PR prefetch would stop partway.
//
// Every change to the queue saves its background jobs (the request, its
// priority, the tabs and PR, never the answers, which are in the cache) to
// chrome.storage.session, which Chrome keeps in memory until it closes. When
// the worker starts and finds them, it is a restart: it puts them back, the
// one that was running first, leaving out jobs whose tabs have all closed or
// no longer show the job's PR (review on #74). After that, a tab that leaves
// its PR lets go of them (PrefetchQueue.releaseTab, from src/background.ts).
// A job whose answer is now in the cache finishes at once without the model
// when it comes up (the handler checks the cache first), and is logged as
// skipped. Nothing is saved until what was kept has been put back, so a new
// worker never overwrites it with its empty queue.

import { isJobPriority, type JobSpec, type PrefetchQueue, type SavedJob } from './prefetchQueue';

/** The chrome.storage.session key holding the saved jobs. */
export const SAVED_QUEUE_KEY = 'prefetchQueue.saved';

/** The part of chrome.storage.session this code uses. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SavedQueueDeps {
  storage: SessionStorageLike;
  /**
   * The tabs open now (chrome.tabs.query). `url` is there only for the
   * extension's own sites, so a tab without one is not on GitHub.
   */
  openTabs(): Promise<{ id: number; url?: string }[]>;
}

export interface RestartInfo {
  /** A worker of this browser session ran before this one. */
  restarted: boolean;
  /** How many jobs were put back. */
  restored: number;
}

export interface SavedQueue<P> {
  /** For the queue's onChange: saves its jobs (once start has put back the old ones). */
  changed(): void;
  /** Puts back what an earlier worker saved, then saves from now on. */
  start(queue: Pick<PrefetchQueue<P, unknown>, 'saved' | 'restore'>): Promise<RestartInfo>;
  /** Settles once the latest change is written (for tests). */
  flushed(): Promise<void>;
}

/**
 * Whether `url` is a page of `pr` ("owner/repo#17"): its Conversation, Files
 * changed or Commits tab. A job with no PR goes with any open tab.
 */
export function showsPr(url: string | undefined, pr: string | undefined): boolean {
  if (pr === undefined) return true;
  if (url === undefined) return false;
  const match = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(pr);
  if (!match) return false;
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return false;
    path = parsed.pathname.toLowerCase();
  } catch {
    return false;
  }
  const [, owner, repo, number] = match;
  const base = `/${owner!.toLowerCase()}/${repo!.toLowerCase()}/pull/${number}`;
  return path === base || path.startsWith(`${base}/`);
}

const isTabList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((tab) => typeof tab === 'number');

/** One saved job read back, or undefined when it is not one (it is checked, not trusted). */
function toSavedJob<P>(value: unknown): SavedJob<P> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { spec, tabs, running } = value as { spec?: unknown; tabs?: unknown; running?: unknown };
  if (typeof spec !== 'object' || spec === null || !isTabList(tabs)) return undefined;
  const { id, label, priority, payload } = spec as Partial<JobSpec<unknown>>;
  if (typeof id !== 'string' || typeof label !== 'string' || !isJobPriority(priority)) {
    return undefined;
  }
  if (payload === undefined || payload === null) return undefined;
  return { spec: spec as JobSpec<P>, tabs, ...(running === true && { running: true }) };
}

export function createSavedQueue<P>(deps: SavedQueueDeps): SavedQueue<P> {
  let source: Pick<PrefetchQueue<P, unknown>, 'saved'> | undefined;
  let scheduled = false;
  let writing: Promise<void> = Promise.resolve();

  const write = () => {
    scheduled = false;
    if (!source) return;
    const jobs = source.saved();
    writing = writing
      .then(() => deps.storage.set({ [SAVED_QUEUE_KEY]: jobs }))
      .catch(() => {
        // Too big or storage gone: only a restart misses it.
      });
  };

  const changed = () => {
    if (!source || scheduled) return;
    // One write for a burst of changes (a job finishing starts the next).
    scheduled = true;
    queueMicrotask(write);
  };

  const start: SavedQueue<P>['start'] = async (queue) => {
    let kept: unknown;
    try {
      kept = (await deps.storage.get([SAVED_QUEUE_KEY]))[SAVED_QUEUE_KEY];
    } catch {
      kept = undefined;
    }
    let info: RestartInfo = { restarted: false, restored: 0 };
    if (Array.isArray(kept)) {
      const open = new Map(
        (await deps.openTabs().catch(() => [])).map((tab) => [tab.id, tab.url] as const),
      );
      const jobs = kept.flatMap((value) => {
        const job = toSavedJob<P>(value);
        if (!job) return [];
        // Only the tabs still open on the job's PR; a job no such tab waits for is dropped.
        const tabs = job.tabs.filter((tab) => open.has(tab) && showsPr(open.get(tab), job.spec.pr));
        return tabs.length ? [{ ...job, tabs }] : [];
      });
      // The job that was running goes first.
      jobs.sort((a, b) => Number(b.running === true) - Number(a.running === true));
      info = { restarted: true, restored: queue.restore(jobs) };
    }
    source = queue;
    write();
    return info;
  };

  const flushed = async () => {
    // A change waits a microtask before it is written.
    await Promise.resolve();
    await writing;
  };

  return { changed, start, flushed };
}
