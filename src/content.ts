// Content script, injected on every github.com page (see public/manifest.json)
// because GitHub moves between pages without a reload (PR 7.1). On PR pages
// it shows the "PR Explainer active" badge and checks that the service worker
// answers; on a PR's Files changed and commit pages it explains diff lines
// when they are clicked. Elsewhere it only waits for a move to a PR.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
// Type-only imports (such as src/messaging/protocol.ts) are fine.
import {
  createPauseReporter,
  holdsPause,
  trackBackgroundPause,
  type BatteryNavigatorLike,
} from './batteryState';
import { setBadgeEnabled, setBadgeStatus, syncBadge } from './badge';
import { createWorkerPort } from './workerPort';
import {
  bannerPlatform,
  findStatusBanner,
  followOllamaStatus,
  removeStatusBanner,
  showStatusBanner,
} from './statusBanner';
import { chatSessionFor, CurrentChat, startChat } from './chat/chatFlow';
import { openChatFromShortcut } from './chat/chatShortcut';
import {
  currentChatPanel,
  openChatPanel,
  type ChatPanel,
  type ChatSubject,
} from './chat/chatPanel';
import { ChatSessions, type ChatSession } from './chat/chatSession';
import { createChatOpener, createSidePanelLink, trackChatPlace } from './chat/sidePanelChat';
import { resolveTheme, watchTheme } from './theme';
import { createClickHandler, listenForClicks, type ClickHandlerDeps } from './clickHandler';
import { trackEnabled } from './enabledState';
import {
  openAfter,
  openChatStream,
  openExplainStream,
  openHunkStream,
  sendRequest,
} from './messaging/client';
import { closeDetached, DiffPageFeatures, showsDiffs, watchNavigation } from './navigation';
import { closeAllPopups, openPopup, openPopups, popupWorking } from './popup/popup';
import { buildWaterfall } from './popup/latencyBreakdown';
import { traceLine } from './trace/clickTrace';
import { createFileContextLoader, headShaFromPage, type CodeSpan } from './fileContext';
import { aheadLines, createPatchRequestLoader, describePatchResult } from './patchRequests';
import type { FileContext } from './explain/explainPrompt';
import {
  createPrefetcher,
  hoverWaitOf,
  HOVER_WAIT_KEY,
  trackHoverSetting,
  type PrefetchEvent,
} from './prefetch';
import {
  createExplainAhead,
  trackAheadSetting,
  trackRequestsSetting,
  visibleAddedLines,
  type AheadEvent,
  type ExplainAheadDeps,
} from './explainAhead';
import { createPrMetadataLoader, type PrMetadata } from './prMetadata';
import {
  createGitattributesLoader,
  skipPatternsOf,
  skipReason,
  SKIP_SETTING_KEY,
} from './skipFiles';
import { parsePrUrl } from './prUrl';
import { installSelection, type InstalledSelection } from './selection';
import { listenForTabCommands, trackContextTarget } from './tabCommands';
import { createGithubFetch, createGithubRoundTrips } from './net/githubFetch';
import { trackDebugSetting } from './debug/debugSetting';
import { trackStreamSetting } from './streamSetting';
import { trackSyncValue } from './syncFlag';

// Every request the content script makes goes through this, and it only
// reaches GitHub (PR 7.4). Each one is recorded as a round trip, so a click
// can list the ones it waited on (PR 9.2).
const githubTrips = createGithubRoundTrips();
const githubFetch = createGithubFetch(undefined, undefined, githubTrips);

/** "owner/repo#17" for the PR on this page, or undefined (no caching). */
function prName(url: string): string | undefined {
  const pr = parsePrUrl(url);
  return pr ? `${pr.owner}/${pr.repo}#${pr.number}` : undefined;
}

// The PR's title and description (PR 6.1), read from the page or fetched
// from its Conversation tab once per PR, with the user's GitHub cookies.
const prMetadata = createPrMetadataLoader({
  doc: document,
  fetchHtml: async (path, signal) => {
    const response = await githubFetch(
      path,
      { credentials: 'same-origin', signal },
      'PR description',
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.text();
  },
});

/** Starts reading the current PR's title and description, if on a PR. */
function loadPrMetadata(): Promise<PrMetadata | undefined> {
  const pr = parsePrUrl(location.href);
  return pr ? prMetadata.load(pr) : Promise.resolve(undefined);
}

// The function or block around clicked code, from the full file at the PR's
// head (PR 6.3). Files are fetched once per page, from the page's own raw
// URL (signed in, so private repos work) or raw.githubusercontent.com.
const fileContexts = createFileContextLoader({
  doc: document,
  fetchText: async (url, signal) => {
    const response = await githubFetch(url, { credentials: 'same-origin', signal }, 'file at head');
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.text();
  },
});

/** Starts reading the block around `code`, if on a PR and it is in the new file. */
function loadFileContext(code: CodeSpan | undefined): Promise<FileContext | undefined> {
  const pr = parsePrUrl(location.href);
  return pr && code ? fileContexts.load(pr, code) : Promise.resolve(undefined);
}

// Every changed line's request, built from the PR's diff on GitHub's API
// rather than the page (PR 10.4), read once per PR and head commit. Explain
// ahead's Whole PR sends them (PR 10.6); with the Debug window setting on, the
// list is also read as the page opens, so the debug window can show it.
const patchRequests = createPatchRequestLoader({
  fetchJson: async (url, signal) => {
    const response = await githubFetch(
      url,
      { credentials: 'omit', signal, headers: { Accept: 'application/vnd.github+json' } },
      'PR files',
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  },
  headSha: (pr) => headShaFromPage(document, pr),
});

// The repository's .gitattributes at the PR's head (PR 11.4), read once per
// PR and head commit from raw.githubusercontent.com, without your sign-in,
// for the files it marks generated or vendored. Explain ahead leaves those
// and the Skip in background setting's patterns alone (src/skipFiles.ts).
const gitattributes = createGitattributesLoader({
  fetchText: async (url, signal) => {
    const response = await githubFetch(url, { credentials: 'omit', signal }, 'gitattributes');
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.text();
  },
  headSha: (pr) => headShaFromPage(document, pr),
});

/**
 * With the Debug window setting on, reads the PR's diff from GitHub's API as
 * a Files changed page opens, and adds its round trips to the page's group in
 * the debug log, named with how many files and changed lines it found.
 */
function readPatchAhead(): void {
  const pr = parsePrUrl(location.href);
  if (!pr || !showsDiffs(location.href) || !debugSetting.current()) return;
  const { id, at, tripsFrom } = pageOpen;
  void patchRequests.load(pr).then((result) => {
    const summary = describePatchResult(result);
    console.info(`[PR Explainer] PR diff from GitHub: ${summary}`);
    // Only the reads this load started; a list read before is not sent again.
    const roundTrips = githubTrips
      .since(tripsFrom)
      .filter((trip) => trip.purpose === 'PR files' && trip.cause === 'click')
      .map((trip) => ({ ...trip, purpose: `PR files: ${summary}` }));
    if (roundTrips.length === 0) return;
    sendRequest('debugLogAdd', { group: id, cause: 'warmup', at, roundTrips, tasks: [] }).catch(
      () => {
        // Only the debug log misses it.
      },
    );
  });
}

// In a dev build, `prExplainerDebug.patchRequests()` in the page's DevTools
// console (with "PR Explainer" picked in its context menu, where the content
// script runs) lists the requests built from the PR's diff.
if (import.meta.env.MODE === 'development') {
  (globalThis as { prExplainerDebug?: unknown }).prExplainerDebug = {
    patchRequests: async () => {
      const pr = parsePrUrl(location.href);
      if (!pr) return 'Not on a PR page.';
      const result = await patchRequests.load(pr);
      if (result.status !== 'done') return describePatchResult(result);
      console.table(
        result.lines.map(({ key, hunk, request }) => ({ key, hunk, code: request.code?.text })),
      );
      return result;
    },
  };
}

let workerStatus = 'Service worker: checking…';
// The chat in Chrome's side panel (PR 11.8, src/chat/sidePanelChat.ts): the
// side panel connects to this tab while it is the active one, and draws its
// chat. The conversation stays here either way.
const sidePanel = createSidePanelLink({
  runtime: chrome.runtime,
  theme: () => resolveTheme(document),
  onPr: () => prName(location.href) !== undefined,
});
watchTheme(document, (theme) => sidePanel.themeChanged(theme));
/** The open chat, on the page or in the side panel. */
const openChat = (): ChatPanel | null => currentChatPanel() ?? sidePanel.current();
// The chat panel opened last; clicks on other code in its PR go to it while
// it is open (PR 5.4).
const currentChat = new CurrentChat();
// The toolbar button turns click-to-explain on and off for every tab (see
// src/toolbarToggle.ts). Until the saved state is read, clicks are ignored
// and the badge keeps its default look.
const enabled = trackEnabled(chrome.storage.local, chrome.storage.onChanged, (value) => {
  // Turning it off also closes an open popup or chat; a late answer is then
  // ignored.
  if (!value) {
    closeAllPopups();
    openChat()?.close();
    prefetcher.cancel();
    onClick.cancelPress();
    ahead.cancel();
  } else if (features.attached) {
    ahead.restart();
  }
  update();
  // A tab turned off lets go of the pause; turned on, it may hold it again.
  reportPause();
  // Turned off, the Ollama banner goes too (PR 11.6).
  showBanner();
});

let pinged = false;
/** Checks once, on the first PR page, that the service worker answers. */
function pingWorker(): void {
  if (pinged) return;
  pinged = true;
  sendRequest('ping', undefined).then(
    () => {
      workerStatus = 'Service worker: connected';
      update();
    },
    (error: Error) => {
      workerStatus = `Service worker: not connected (${error.message})`;
      console.warn('[PR Explainer]', error);
      update();
    },
  );
}

// Loading a model can take longer than a normal request's timeout.
const WARMUP_TIMEOUT_MS = 120_000;
// Warm-ups this tab sent that have not answered yet.
let warmupsRunning = 0;

/**
 * Asks the service worker to load the model while the user reads the diffs,
 * so the first click does not wait for it (PR 8.3). The worker does this once
 * per tab and PR and skips it if the model is already loaded; a failure is
 * only logged there, so it is ignored here.
 */
function warmUpModel(): void {
  const pr = prName(location.href);
  if (!pr || !showsDiffs(location.href) || enabled.current() !== true) return;
  // Explain on hover waits until the model is loaded (PR 11.2).
  warmupsRunning += 1;
  sendRequest('warmup', { pr, debugId: pageOpen.id }, { timeoutMs: WARMUP_TIMEOUT_MS })
    .catch(() => {})
    .finally(() => {
      warmupsRunning -= 1;
    });
}

/**
 * Asks the service worker to load the Chat model as the chat opens (PR
 * 9.14), so the first question does not wait for it. The worker does nothing
 * when chat uses the same model as explanations, and loads it once per tab,
 * PR and Chat model.
 */
function warmUpChatModel(pr: string | undefined): void {
  if (!pr) return;
  sendRequest('warmup', { pr, for: 'chat' }, { timeoutMs: WARMUP_TIMEOUT_MS }).catch(() => {});
}

// The page's own round trips before any click (PR 9.7): the warm-up and the
// PR description read ahead share one group in the debug log, so it shows
// what opening the page cost and that the first click did not wait for it.
const newPageGroup = () => ({
  id: crypto.randomUUID(),
  at: Date.now(),
  tripsFrom: githubTrips.now(),
});
let pageOpen = newPageGroup();

/**
 * Reads the PR description as the page opens, so the first click does not
 * wait for it (PR 6.1). With the Debug window setting on, its GitHub round
 * trip joins the warm-up's group.
 */
function readDescriptionAhead(): void {
  const { id, at, tripsFrom } = pageOpen;
  void loadPrMetadata().then(() => {
    if (!debugSetting.current()) return;
    // Only the ones this read started; a click's own are in its group.
    const roundTrips = githubTrips
      .since(tripsFrom)
      .filter((trip) => trip.purpose === 'PR description' && trip.cause === 'click');
    if (roundTrips.length === 0) return;
    sendRequest('debugLogAdd', { group: id, cause: 'warmup', at, roundTrips, tasks: [] }).catch(
      () => {
        // Only the debug log misses it.
      },
    );
  });
}

function update(): void {
  // Moving to another PR (or off PRs) without a reload closes its chat.
  currentChat.leave(prName(location.href));
  sidePanel.pageChanged();
  if (!syncBadge(document, location.href)) return;
  pingWorker();
  warmUpModel();
  setBadgeStatus(document, workerStatus);
  const value = enabled.current();
  if (value !== null) setBadgeEnabled(document, value);
}

// Click a diff line to explain it: a popup opens next to the line and the
// model's answer streams into it (see src/clickHandler.ts). There is no
// timeout: the popup's Stop button ends a request that takes too long.
// One chat per PR, kept for as long as the tab is open (never stored).
const chats = new ChatSessions();
// The PR names the cache entry, so the same code in two PRs is asked
// separately (src/explain/explainCache.ts). The PR's title and description
// go with the code, so the answer can say why the PR needs it (PR 6.1).
// The block around the code in the full file goes too (PR 6.3). Each step is
// a task in the click's trace (PR 9.1); the two reads run at the same time.
const askWorker: ClickHandlerDeps['explain'] = (context, onChunk, options) => {
  const { fresh, code, trace, cause = 'click', job } = options;
  // A click's trace names its debug log group; Explain ahead passes its own.
  const debugId = trace?.id ?? options.debugId;
  const pr = prName(location.href);
  // The click, on the round trips' clock (both are performance.now()).
  const clickAt = trace ? githubTrips.now() - trace.now() : undefined;
  // If the click is stopped before the request is sent, the debug log still
  // gets the GitHub round trips it was waiting on (PR 9.3).
  if (trace && clickAt !== undefined) trace.pageRoundTrips(() => githubTrips.since(clickAt));
  const description = loadPrMetadata();
  const file = loadFileContext(code);
  if (trace) {
    const onPr = Boolean(parsePrUrl(location.href));
    const record = (key: string, label: string, work: Promise<unknown>, ran: boolean) =>
      ran ? void trace.time(key, label, work) : trace.skip(key, label);
    record('pr-description', 'Read the PR description', description, onPr);
    // Removed lines are not in the file at the PR's head.
    record('file-at-head', 'Fetch the file at head', file, onPr && code !== undefined);
  }
  const ready = Promise.all([description, file]);
  return openAfter(ready, ([prInfo, fileContext]) => {
    if (import.meta.env.MODE === 'development') {
      if (prInfo) {
        console.log(
          `[PR Explainer] PR title for the model: ${prInfo.title || '(none)'}\n` +
            `PR description for the model:\n${prInfo.description || '(none)'}`,
        );
      }
      console.log(
        '[PR Explainer] full file context for the model: ' +
          (fileContext
            ? `${fileContext.kind}, lines ${fileContext.startLine} to ` +
              `${fileContext.startLine + fileContext.lines.length - 1}`
            : '(none)'),
      );
    }
    // The GitHub round trips this click waited on (PR 9.2).
    if (trace && clickAt !== undefined) trace.addRoundTrips(githubTrips.since(clickAt));
    trace?.markSent();
    const sent = trace?.start('send', 'Send the request');
    const stream = openExplainStream(
      {
        context,
        pr,
        fresh,
        prInfo,
        fileContext,
        cause,
        ...(debugId && { debugId }),
        ...(job && { job }),
      },
      onChunk,
    );
    sent?.();
    return stream;
  });
};

// Every line of one hunk in one request (PR 10.5), for Explain ahead. Each
// line carries what a click on it would send, so the service worker saves
// its answer under the key that click looks up.
const askWorkerHunk: NonNullable<ExplainAheadDeps['explainHunk']> = (request, { debugId, job }) => {
  const pr = prName(location.href);
  const ready = Promise.all([
    loadPrMetadata(),
    Promise.all(request.lines.map((line) => loadFileContext(line.request.code))),
  ]);
  return openAfter(ready, ([prInfo, files]) =>
    openHunkStream({
      context: request.text,
      pr,
      fresh: false,
      prInfo,
      cause: 'ahead',
      debugId,
      // Whole PR (PR 10.6) says how near the screen the hunk is.
      job: { label: request.label, ...job },
      hunk: {
        text: request.text,
        lines: request.lines.map((line, i) => ({
          label: line.label,
          context: line.request.text,
          line: line.line,
          code: line.code,
          ...(files[i] && { fileContext: files[i] }),
        })),
      },
    }),
  );
};

// Background work on battery (PR 11.3): on battery, with the setting on
// Pause (the default), Explain on hover and Explain ahead send nothing new,
// and the service worker's queue starts no background job (it hears from
// every PR tab, src/backgroundPause.ts). A running request is let finish.
// Clicks and chat questions are never paused.
const backgroundPause = trackBackgroundPause({
  nav: navigator as Navigator & BatteryNavigatorLike,
  storage: chrome.storage.sync,
  events: chrome.storage.onChanged,
  onChange: (paused) => {
    console.info(`[PR Explainer] background work ${paused ? 'paused: on battery' : 'resumed'}`);
    reportPause();
    // Plugged in: Explain ahead looks at the lines on screen again.
    if (!paused && features.attached) ahead.restart();
  },
});
// Tells the service worker whether this tab holds the pause: only while it
// shows a PR's diffs with click-to-explain on and some background work
// turned on, so a tab that moved off a PR or was turned off never pauses the
// other tabs (review on #71). The icon then shows the pause only while
// something is held back.
const pauseReporter = createPauseReporter({
  wanted: () =>
    holdsPause({
      paused: backgroundPause.paused(),
      onDiffs: features.attached,
      enabled: enabled.current(),
      backgroundOn: hoverSetting.current() || aheadSetting.current() !== 'off',
    }),
  send: (paused) => sendRequest('backgroundPaused', { paused }),
});
const reportPause = () => pauseReporter.update();

// Explain on hover (PR 8.7): with the setting on, resting the pointer on a
// line starts its explanation, and a click joins it in the service worker's
// queue (src/prefetch.ts, PR 10.3).
const hoverSetting = trackHoverSetting(chrome.storage.sync, chrome.storage.onChanged, (on) => {
  if (!on) prefetcher.cancel();
  reportPause();
});
// Hover wait (PR 11.2): how long the pointer rests on a line first.
const hoverWait = trackSyncValue(
  HOVER_WAIT_KEY,
  chrome.storage.sync,
  chrome.storage.onChanged,
  hoverWaitOf,
);
function describePrefetch(event: PrefetchEvent): string {
  const seconds = 'elapsedMs' in event ? ` after ${(event.elapsedMs / 1000).toFixed(1)} s` : '';
  if (event.type === 'finished') {
    return `prefetch of ${event.key} ${event.status === 'done' ? 'finished' : 'failed'}${seconds}`;
  }
  return `prefetch of ${event.key} ${event.type}`;
}
// Explain ahead (PR 9.10): with the setting on, once the page has been still
// for 2 seconds the added lines on screen are explained one at a time, so a
// click on them is answered from the cache (src/explainAhead.ts). The service
// worker's queue (PR 10.3) stops it for a moment for a click or a hover on
// other code, and joins a click on the same line to it.
// Whole PR (PR 10.6) works through every changed line of the PR from its
// diff on GitHub's API, the code on screen first, up to 500 lines per PR and
// head commit in this tab (each tab keeps its own count; lines another tab
// already explained are cache hits and do not count); Requests at once sets how many requests it sends together.
const aheadSetting = trackAheadSetting(chrome.storage.sync, chrome.storage.onChanged, (mode) => {
  if (mode === 'off') ahead.cancel();
  else if (features.attached) ahead.restart();
  reportPause();
});
const requestsSetting = trackRequestsSetting(chrome.storage.sync, chrome.storage.onChanged);
// Skip in background (PR 11.4): a save takes effect at the next wait.
const skipSetting = trackSyncValue(
  SKIP_SETTING_KEY,
  chrome.storage.sync,
  chrome.storage.onChanged,
  skipPatternsOf,
  () => {
    if (features.attached && aheadSetting.current() !== 'off') ahead.restart();
  },
);
/** The PR and its head commit, for Whole PR's per-PR limit. */
function aheadPage(): { pr: string; head: string | null } | undefined {
  const pr = parsePrUrl(location.href);
  const name = prName(location.href);
  return pr && name ? { pr: name, head: headShaFromPage(document, pr) } : undefined;
}
function describeAhead(event: AheadEvent): string {
  if (event.type === 'skipped') {
    const n = event.files.length;
    return `explain ahead skipped ${n} generated or vendored file${n === 1 ? '' : 's'}: ${event.files.join(', ')}`;
  }
  if (event.type === 'limit') {
    return `explain ahead stopped at ${event.count} lines ${event.wholePr ? 'for this PR' : 'on this page'}`;
  }
  const seconds = 'elapsedMs' in event ? ` after ${(event.elapsedMs / 1000).toFixed(1)} s` : '';
  if (event.type === 'finished') {
    const how =
      event.status === 'failed' ? 'failed' : event.cached ? 'was in the cache' : 'finished';
    return `explain ahead of ${event.key} ${how}${seconds}`;
  }
  return `explain ahead of ${event.key} ${event.type}`;
}
const ahead = createExplainAhead({
  explain: askWorker,
  explainHunk: askWorkerHunk,
  isOn: () => aheadSetting.current() !== 'off',
  wholePr: () => aheadSetting.current() === 'pr',
  prLines: async () => {
    const pr = parsePrUrl(location.href);
    const result = pr ? await patchRequests.load(pr) : undefined;
    if (result?.status !== 'done') {
      if (result) console.info(`[PR Explainer] Whole PR: ${describePatchResult(result)}`);
      return null;
    }
    return aheadLines(result);
  },
  // Generated and vendored files, and the Skip in background patterns.
  skipFile: async () => {
    const pr = parsePrUrl(location.href);
    const rules = pr ? await gitattributes.load(pr) : [];
    const patterns = skipSetting.current();
    return (filePath) => skipReason(filePath, patterns, rules) !== null;
  },
  pageKey: aheadPage,
  concurrency: () => requestsSetting.current(),
  isEnabled: () => enabled.current() === true,
  isPaused: () => backgroundPause.paused(),
  // One request at a time: not while a click's or a chat answer is being
  // written, not while Explain on hover runs, and not in a hidden tab.
  isBusy: () => {
    return (
      popupWorking() ||
      openChat()?.isBusy === true ||
      prefetcher.running() !== undefined ||
      document.visibilityState === 'hidden'
    );
  },
  lines: () => visibleAddedLines(document),
  onEvent: (event) => {
    console.info(`[PR Explainer] ${describeAhead(event)}`);
    // Work started: keep the service worker running while it lasts (PR 11.5).
    if (event.type === 'started') workerPort.update();
  },
  // Whole PR's progress on the toolbar icon, for this tab (PR 10.7).
  onProgress: (progress) => {
    sendRequest('aheadProgress', progress).catch(() => {});
  },
});

// While Explain ahead has work, a port to the service worker keeps Chrome
// from stopping it (PR 11.5, src/workerPort.ts). If Chrome stops it anyway,
// the worker puts its queue back when it starts again, and Explain ahead
// carries on at once instead of waiting for a click or a scroll.
// Tells the service worker which PR this tab shows when that changes, so
// its queue lets go of jobs it holds for this tab and another PR (review on
// #74). A full page load does the same in the worker by itself.
let reportedPr: string | null | undefined;
function reportPr(): void {
  const pr = prName(location.href) ?? null;
  if (pr === reportedPr) return;
  const first = reportedPr === undefined;
  reportedPr = pr;
  // A new page held nothing yet; only a move away from a PR needs saying.
  if (first) return;
  sendRequest('tabPr', { pr }).catch(() => {});
}

const workerPort = createWorkerPort({
  runtime: chrome.runtime,
  // The Ollama banner (PR 11.6) also keeps the worker running, so its
  // checks go on until Ollama is back.
  hasWork: () =>
    ahead.runningAll().length > 0 ||
    ahead.queued().length > 0 ||
    findStatusBanner(document) !== null,
  onRestart: (restored) => {
    console.info(`[PR Explainer] worker restarted, ${restored} jobs restored`);
    if (features.attached) ahead.restart();
  },
});

// The Ollama status banner (PR 11.6, src/statusBanner.ts). The service
// worker keeps one status for every tab in chrome.storage.local; while
// Ollama is not running or lacks the model, a PR's diffs show one banner
// with the fix and Try again, and it goes when the worker finds Ollama back.
const ollamaStatus = followOllamaStatus(chrome.storage.onChanged, () => showBanner());
// Checking takes one request to Ollama, which may not answer quickly.
const OLLAMA_STATUS_TIMEOUT_MS = 30_000;
function askOllamaStatus(retry = false): Promise<void> {
  return sendRequest('ollamaStatus', retry ? { retry: true } : undefined, {
    timeoutMs: OLLAMA_STATUS_TIMEOUT_MS,
  }).then(
    (status) => {
      ollamaStatus.set(status);
      // Shown even when the status is the same, for diffs that just opened.
      showBanner();
    },
    () => {},
  );
}
/** Shows, updates or removes the banner: only on a PR's diffs with click-to-explain on. */
function showBanner(): void {
  if (!features.attached || enabled.current() !== true) {
    removeStatusBanner(document);
    return;
  }
  showStatusBanner(document, ollamaStatus.current(), {
    platform: bannerPlatform(navigator.userAgent),
    onRetry: () => askOllamaStatus(true),
  });
  workerPort.update();
}

const prefetcher = createPrefetcher({
  // The service worker's queue puts a hover ahead of the line explained ahead.
  explain: askWorker,
  isOn: () => hoverSetting.current(),
  delayMs: () => hoverWait.current(),
  isEnabled: () => enabled.current() === true,
  isPaused: () => backgroundPause.paused(),
  // Not while the model is still loading (PR 8.3), nor in a hidden tab (PR 11.2).
  isWarmingUp: () => warmupsRunning > 0,
  isHidden: () => document.visibilityState === 'hidden',
  // One request at a time: not while a click's answer is still coming, and
  // not while the chat is open (a click then goes to the chat).
  isBusy: () => popupWorking() || openChat() !== null,
  // Every build logs prefetches, like the timing of each explanation below.
  onEvent: (event) => console.info(`[PR Explainer] ${describePrefetch(event)}`),
});

// The Debug window setting (PR 9.3), for the popup's Debug button.
// Turning it on also reads the PR's diff for the debug window (PR 10.4).
const debugSetting = trackDebugSetting(chrome.storage.sync, chrome.storage.onChanged, (on) => {
  if (on) readPatchAhead();
});
// Chat opens in (PR 11.8): the side panel (the default) or the page.
const chatPlace = trackChatPlace(chrome.storage.sync, chrome.storage.onChanged);
const placeChat = createChatOpener({
  place: () => chatPlace.current(),
  sidePanelShown: () => sidePanel.shown,
  openSidePanel: () => sendRequest('openSidePanel', undefined),
});
// Show answers as they are written (PR 9.6): off, the popup and the chat show
// each answer whole once it is ready. Read again for each popup and chat.
const streamSetting = trackStreamSetting(chrome.storage.sync, chrome.storage.onChanged);

// What each PR's chat was first about, so the Open chat shortcut (PR 11.9)
// can open it on the page again.
const chatSubjects = new Map<string, ChatSubject>();
/** Opens the chat for `session` in `place`, closing any other, with an optional note. */
function showChat(
  place: 'sidepanel' | 'page',
  pr: string | undefined,
  session: ChatSession,
  subject: ChatSubject,
  note?: string,
): void {
  if (pr !== undefined) chatSubjects.set(pr, subject);
  // One chat at a time, wherever it is.
  openChat()?.close();
  const chat = startChat(
    {
      ask: (messages, onChunk) => openChatStream({ messages }, onChunk),
      openPanel: (options) => {
        const withSetting = { ...options, streamAnswers: streamSetting.current() };
        return place === 'sidepanel' ? sidePanel.open(withSetting) : openChatPanel(withSetting);
      },
    },
    session,
    subject,
  );
  if (note) chat.addNote(note);
  currentChat.set(chat, pr);
  chat.focus();
}

const explainDeps: ClickHandlerDeps = {
  isEnabled: () => enabled.current() === true,
  // A press sends nothing while the chat is open: the click goes to the chat (PR 11.1).
  isChatOpen: () => openChat() !== null,
  // A click joins a running prefetch of the same line instead of asking again.
  explain: prefetcher.explain,
  // With the Debug window setting on, the popup's Debug button opens the
  // debug window (PR 9.4).
  openPopup: (anchor, options) =>
    openPopup(anchor, {
      ...options,
      streamAnswers: streamSetting.current(),
      ...(debugSetting.current() && {
        onDebug: () => {
          sendRequest('openDebugWindow', undefined).catch((error: unknown) => {
            console.warn('[PR Explainer] could not open the debug window', error);
          });
        },
      }),
    }),
  // The popup's Ask a question button: chat about the explained code, with
  // answers streamed from the service worker (src/chat/chatFlow.ts).
  // With Chat opens in on Side panel (PR 11.8), the side panel is asked for
  // at once, from the click; if Chrome refuses, the chat opens on the page.
  openChat: ({ subject, regenerated, ...seed }) => {
    const pr = prName(location.href);
    warmUpChatModel(pr);
    placeChat((place, note) => {
      // The page may have moved on while the side panel opened.
      if (prName(location.href) !== pr) return;
      showChat(place, pr, chatSessionFor(chats, pr, seed, { regenerated }), subject, note);
    });
  },
  // 👍 and 👎 on an answer (PR 11.11): the service worker keeps them in
  // chrome.storage.local. Never the code or the answer.
  rate: (update) => {
    sendRequest('rateAnswer', update).catch((error: unknown) => {
      console.warn('[PR Explainer] could not save the rating', error);
    });
  },
  // A click that failed while Ollama is down can switch to Chrome's built-in model (PR 11.13).
  useBuiltInModel: async () => {
    await sendRequest('useBuiltInModel', undefined);
  },
  // While the chat is open, clicked code in its PR joins the conversation (PR 5.4).
  addToChat: ({ text, subject }) => currentChat.addCode(prName(location.href), text, subject),
  // Dev builds also log the context block sent to the model.
  onContext:
    import.meta.env.MODE === 'development'
      ? (context) => console.log(`[PR Explainer] context for the model:\n${context}`)
      : undefined,
  // Every build logs how long each explanation took, to track the local
  // model's latency.
  onTiming: ({
    elapsedMs,
    status,
    model,
    firstChunkMs,
    cached,
    timings,
    tasks,
    reply,
    thinking,
    debug,
  }) => {
    // The click's GitHub round trips and trace join the debug log (PR 9.3).
    // Sent only when the Debug window setting is on (PR 9.4).
    if (debug && tasks?.length && debugSetting.current()) {
      sendRequest('debugLogAdd', {
        ...debug,
        roundTrips: debug.roundTrips.filter((trip) => trip.target === 'github'),
        tasks,
      }).catch(() => {
        // Only the debug log misses it.
      });
    }
    const verb = { done: 'explained', failed: 'failed', stopped: 'stopped' }[status];
    // Every task, as the popup's Details shows it (PR 9.1).
    const waterfall = tasks?.length ? buildWaterfall(tasks, timings, reply, thinking) : undefined;
    const details = [
      model,
      firstChunkMs === undefined ? '' : `first text after ${(firstChunkMs / 1000).toFixed(1)} s`,
      cached ? 'from cache' : '',
      waterfall ? `tasks: ${traceLine(waterfall.rows)}` : '',
    ].filter(Boolean);
    console.info(
      `[PR Explainer] ${verb} in ${(elapsedMs / 1000).toFixed(1)} s` +
        (details.length ? ` (${details.join(', ')})` : ''),
    );
  },
};
// The request starts when the mouse goes down on a line, and the popup opens
// on the click (PR 11.1).
const onClick = createClickHandler(explainDeps);
// Selected blocks, while a PR's diffs are shown (below).
let selection: InstalledSelection | null = null;
// The Explain and Open chat shortcuts, which can be changed on
// chrome://extensions/shortcuts, and Explain with PR Explainer in the
// right-click menu (PR 11.9). The service worker sends them to this tab.
const contextTarget = trackContextTarget(document);
listenForTabCommands(chrome.runtime, {
  explain: () => {
    if (!selection?.explainFocused()) {
      console.info('[PR Explainer] Explain: no line has focus or the text cursor');
    }
  },
  explainAtPointer: () => {
    const at = contextTarget.current();
    selection?.explainAt(at?.target ?? null, at?.point);
  },
  // The Open chat shortcut: this PR's conversation, in the side panel Chrome
  // just opened or on the page (src/chat/chatShortcut.ts).
  openChat: (options) => {
    const outcome = openChatFromShortcut(
      {
        pr: () => prName(location.href),
        sessions: chats,
        subjects: chatSubjects,
        openChat: (place) => (place === 'sidepanel' ? sidePanel.current() : currentChatPanel()),
        show: (place, pr, session, subject, note) => {
          warmUpChatModel(pr);
          showChat(place, pr, session, subject, note);
        },
      },
      options,
    );
    if (outcome === 'nothing')
      console.info('[PR Explainer] Open chat: no conversation on this PR yet');
  },
});
// Click-to-explain is attached only while a PR's diffs are shown, once
// however often GitHub re-renders the page, and taken off when the user
// moves elsewhere (PR 7.1).
const features = new DiffPageFeatures(() => {
  const removeClicks = listenForClicks(onClick);
  document.addEventListener('mouseover', prefetcher.onMouseOver);
  document.addEventListener('mousedown', prefetcher.onMouseDown);
  // Scrolling starts Explain ahead's wait again, for the lines then on screen.
  window.addEventListener('scroll', ahead.restart, { passive: true });
  ahead.restart();
  // Drag across lines, or click one and Shift-click another, to explain the
  // block as a whole (src/selection.ts).
  const removeSelection = installSelection(explainDeps);
  selection = removeSelection;
  // Is Ollama up? The worker checks unless it knows (PR 11.6).
  void askOllamaStatus();
  return () => {
    removeStatusBanner(document);
    removeClicks();
    document.removeEventListener('mouseover', prefetcher.onMouseOver);
    document.removeEventListener('mousedown', prefetcher.onMouseDown);
    window.removeEventListener('scroll', ahead.restart);
    prefetcher.cancel();
    ahead.cancel();
    removeSelection();
    selection = null;
    // Closing a popup also stops its request. Pinned ones close too: the
    // user has left the PR's diffs (PR 11.10).
    closeAllPopups();
  };
});

update();
features.sync(location.href);
reportPause();
reportPr();
// Read the description ahead of the first click, so it does not wait.
readDescriptionAhead();

// GitHub changes pages without a full reload (Turbo, or pushState in its
// React views), so this script keeps running when the user moves from a PR
// to, say, an issue, or from the Conversation tab to Files changed. Each move
// to another page updates the badge and attaches or removes click-to-explain.
// It may also come back from editing the PR's title or description, or Turbo
// may redraw the same page after an edit or a push, so the description and
// the files are read again (PR 6.1, 6.3).
// The PR the open popups are about.
let popupsPr = prName(location.href);
function onPageChanged(url: string): void {
  // A popup or chat whose part of the page GitHub replaced is closed, so
  // its request stops and clicks do not go to it.
  closeDetached([...openPopups(), currentChatPanel()]);
  // Pinned popups belong to their PR: moving to another PR closes them (PR 11.10).
  const pr = prName(url);
  if (pr !== popupsPr) closeAllPopups();
  popupsPr = pr;
  // A new page is a new group in the debug log (its warm-up and description).
  pageOpen = newPageGroup();
  // A redraw can also drop the badge.
  update();
  features.sync(url);
  // Off a PR's diffs, the tab lets go of the pause (review on #71).
  reportPause();
  // Off this PR, the queue lets go of work held for it (review on #74).
  reportPr();
  prMetadata.forget();
  fileContexts.forget();
  patchRequests.forget();
  gitattributes.forget();
  // A prefetch or wait from before the move is for code that may be gone.
  prefetcher.pageChanged();
  onClick.cancelPress();
  ahead.pageChanged();
  if (features.attached) ahead.restart();
  readDescriptionAhead();
  readPatchAhead();
}
watchNavigation(window, onPageChanged, { onRedraw: onPageChanged });
