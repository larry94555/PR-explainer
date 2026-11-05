// One Ollama status for the whole extension (PR 11.6), kept by the service
// worker: up, down (nothing answers at the URL) or model missing (Ollama
// answers but does not have the explanation model).
//
// It is learned from the result of every request (a click, a hover, Explain
// ahead, a chat question: `report`), and from a cheap check (`check`,
// GET /api/tags, which says in one request whether Ollama answers and
// whether it has the model). While Ollama is down or the model is missing,
// background work is paused (src/explain/prefetchQueue.ts) instead of
// failing line by line, and every PR tab shows one banner with the fix
// (src/statusBanner.ts). The status is kept in chrome.storage.local, which
// content scripts can read and follow, so each tab hears of a change at once.
//
// While it is not up, the worker checks again after 2, 4 and 8 seconds, and
// then every 30 seconds, but only while a PR tab is open: with none, the
// checks stop until a PR page asks again. When a check (or any request)
// finds Ollama up again, `onRecover` runs, which warms the model up (PR 8.3)
// and lets background work carry on. The banner's Try again button checks
// at once and starts the schedule again from 2 seconds.
//
// It knows nothing about Chrome: the worker passes in the check, the tab
// lookup and the storage, so the tests drive it with fakes and fake timers.

import type { LlmErrorKind } from './types';

/** unknown: not checked yet since the worker started and nothing was stored. */
export type OllamaState = 'unknown' | 'up' | 'down' | 'model-missing';

/** What a request or a check found. */
export type FoundState = Exclude<OllamaState, 'unknown'>;

export interface OllamaStatus {
  state: OllamaState;
  /** The explanation model, for "model missing". */
  model?: string;
}

/** The chrome.storage.local key holding the status, which the content script follows. */
export const OLLAMA_STATUS_KEY = 'ollamaStatus';

/** How long to wait before each check while Ollama is not up; the last repeats. */
export const CHECK_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 30_000];

/** The part of chrome.storage.local this code uses. */
export interface StatusStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface OllamaStatusDeps {
  /** One cheap request to Ollama: is it up, and does it have the model? */
  check(): Promise<{ state: FoundState; model?: string }>;
  /** Whether any tab shows a GitHub PR, so checks run only while one does. */
  prTabOpen(): Promise<boolean>;
  /** The explanation model now, to name it when a request finds it missing. */
  model(): Promise<string>;
  storage: StatusStorageLike;
  /** Hears each change of status, including one read back from storage on start. */
  onChange?(status: OllamaStatus): void;
  /** Ollama is up again after being down or missing the model. */
  onRecover?(): void;
}

export interface OllamaStatusTracker {
  current(): OllamaStatus;
  /** What a request for the explanation model found. */
  report(found: FoundState): void;
  /**
   * What a request for another model found (the Chat model, when it is not
   * the explanation model): it can say Ollama is down, or that Ollama
   * answers, but not whether the explanation model is installed (review on
   * #75). An answer while down checks at once instead of clearing it.
   */
  reportOtherModel(found: FoundState | undefined): void;
  /**
   * Checks at once (the banner's Try again, or a changed URL or model), and
   * starts the schedule again from its first wait if Ollama is still not up.
   * Two calls at once share one check.
   */
  check(): Promise<OllamaStatus>;
  /** For a PR page that opens: checks unless Ollama is known to be up. */
  ensure(): Promise<OllamaStatus>;
  /** Settles once what was stored before is read (for tests). */
  ready: Promise<void>;
}

const isFound = (value: unknown): value is FoundState =>
  value === 'up' || value === 'down' || value === 'model-missing';

/** What a failed request says about Ollama, or undefined when it says nothing. */
export function stateOfErrorKind(kind: LlmErrorKind | undefined): FoundState | undefined {
  if (kind === 'connection') return 'down';
  if (kind === 'model-not-found') return 'model-missing';
  return undefined;
}

/** The parts of an explain, hunk or chat result that say something about Ollama. */
export interface ResultLike {
  status: string;
  kind?: LlmErrorKind;
  /** An explanation from the cache, which says nothing about Ollama. */
  cached?: unknown;
  /** A hunk's lines (PR 10.5): any not from the cache means the model answered. */
  lines?: readonly { status: string }[];
}

/** What a request's result says about Ollama, or undefined when it says nothing. */
export function stateOfResult(result: ResultLike): FoundState | undefined {
  if (result.status === 'failed') return stateOfErrorKind(result.kind);
  if (result.status === 'hunk') {
    return result.lines?.some((line) => line.status !== 'cached') ? 'up' : undefined;
  }
  if (result.status === 'done') return result.cached === undefined ? 'up' : undefined;
  return undefined;
}

/** A stored status read back, or undefined when it is not one (it is checked, not trusted). */
export function toOllamaStatus(value: unknown): OllamaStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { state, model } = value as { state?: unknown; model?: unknown };
  if (!isFound(state)) return undefined;
  return { state, ...(typeof model === 'string' && model && { model }) };
}

export function createOllamaStatus(deps: OllamaStatusDeps): OllamaStatusTracker {
  let status: OllamaStatus = { state: 'unknown' };
  // Which wait comes next in CHECK_DELAYS_MS.
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<OllamaStatus> | undefined;
  // Something was heard since the worker started, so what was stored is old.
  let heard = false;
  // Goes up with each change, so a slow model-name lookup cannot undo a later one.
  let version = 0;

  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (timer !== undefined || status.state === 'up' || status.state === 'unknown') return;
    const delay = CHECK_DELAYS_MS[Math.min(attempt, CHECK_DELAYS_MS.length - 1)]!;
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      void deps.prTabOpen().then(
        (open) => {
          // No PR tab: stop until a PR page asks again (ensure).
          if (open) void run();
          else attempt = 0;
        },
        () => {
          attempt = 0;
        },
      );
    }, delay);
  };

  const set = (next: OllamaStatus) => {
    heard = true;
    version += 1;
    const previous = status;
    status = next;
    if (next.state === 'up') {
      stopTimer();
      attempt = 0;
    } else {
      schedule();
    }
    if (previous.state === next.state && previous.model === next.model) return;
    deps.storage.set({ [OLLAMA_STATUS_KEY]: next }).catch(() => {
      // Only a page opened later misses it; it checks for itself.
    });
    deps.onChange?.(next);
    if (next.state === 'up' && (previous.state === 'down' || previous.state === 'model-missing')) {
      deps.onRecover?.();
    }
  };

  const run = (): Promise<OllamaStatus> => {
    if (checking) return checking;
    stopTimer();
    checking = deps
      .check()
      .then(
        (found) => set({ state: found.state, ...(found.model && { model: found.model }) }),
        // A check that cannot even be made says nothing new.
        () => schedule(),
      )
      .then(() => status)
      .finally(() => {
        checking = undefined;
      });
    return checking;
  };

  const ready = deps.storage.get([OLLAMA_STATUS_KEY]).then(
    (stored) => {
      const kept = toOllamaStatus(stored[OLLAMA_STATUS_KEY]);
      if (!kept || heard) return;
      status = kept;
      deps.onChange?.(kept);
      // Down when the worker stopped: carry on checking.
      schedule();
    },
    () => undefined,
  );

  return {
    current: () => status,
    report(found) {
      if (found !== 'model-missing') {
        set({ state: found });
        return;
      }
      // Paused at once, keeping the name already known; the model is read
      // for the banner, and named only if nothing changed meanwhile (review on #75).
      const known = status.state === 'model-missing' ? status.model : undefined;
      set({ state: found, ...(known && { model: known }) });
      const at = version;
      void deps.model().then(
        (model) => {
          if (version === at && model && model !== known) set({ state: found, model });
        },
        () => {},
      );
    },
    reportOtherModel(found) {
      if (found === 'down') set({ state: 'down' });
      else if (found === 'up' && status.state === 'down') {
        attempt = 0;
        void run();
      }
    },
    check() {
      attempt = 0;
      stopTimer();
      return run();
    },
    async ensure() {
      await ready;
      if (status.state === 'up') return status;
      attempt = 0;
      return run();
    },
    ready,
  };
}
