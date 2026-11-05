// Service worker. Answers requests from the content script (see
// src/messaging/). All calls to the local LLM run here (see src/llm/).
import { createBackgroundPause, forgetTabOnLoad } from './backgroundPause';
import { createChatHandler } from './chat/chatHandler';
import { setupCommands, setupExplainMenu } from './commands';
import {
  clearWhenTurnedOff,
  createDebugLog,
  listenForDebugLogPorts,
  pageEntries,
  workerEntry,
} from './debug/debugLog';
import {
  createDebugWindowOpener,
  followDebugSetting,
  setupDebugMenu,
} from './debug/debugWindowOpener';
import { createExplainCache } from './explain/explainCache';
import { createLayeredCache, createPersistentCache } from './explain/persistentCache';
import {
  createExplainHandler,
  type ExplainDeps,
  type ExplainPayload,
  type ExplainResult,
} from './explain/explainHandler';
import { createHunkExplainHandler, linePayload, type HunkResult } from './explain/hunkHandler';
import { buildExplainPrompt } from './explain/explainPrompt';
import { createPrefetchQueue, explainJob } from './explain/prefetchQueue';
import { createSavedQueue } from './explain/savedQueue';
import { SAMPLE_CONTEXT } from './explain/sampleContext';
import { createModelLookup } from './llm/contextSize';
import { createLlmClient } from './llm/createClient';
import { detectPlatform, llmErrorKind } from './llm/describeLlmError';
import { createLoadedWindowMemory } from './llm/loadedWindow';
import {
  createOllamaStatus,
  stateOfErrorKind,
  stateOfResult,
  type ResultLike,
} from './llm/ollamaStatus';
import { isSameModel } from './llm/types';
import { createWarmup } from './llm/warmup';
import { MessageRouter } from './messaging/router';
import { listenForChatPorts, listenForExplainPorts } from './messaging/streamPort';
import { listenForWorkerPorts } from './messaging/workerPort';
import type { RoundTripSink } from './net/roundTrips';
import {
  DEFAULT_SETTINGS,
  followChatPlace,
  hasOwnChatModel,
  followRequestsAtOnce,
  getSettings,
  saveSettings,
  storageKey,
} from './settings';
import { openSidePanel, setupChatMenu } from './sidePanelOpener';
import { setupToolbarToggle } from './toolbarToggle';

console.info('[PR Explainer] service worker started');

// With the Debug window setting on, every round trip is kept for the browser
// session, for the debug window (src/debug/debugLog.ts, PR 9.3).
const debugLog = createDebugLog({
  storage: chrome.storage.session,
  isOn: async () => (await getSettings()).debugWindow,
});
// A round trip still running goes to the debug window only (PR 9.4); it is
// kept in the log once it ends.
const recordRoundTrip: RoundTripSink = (trip, log) => {
  const entry = workerEntry(trip, log);
  if (trip.status === 'running') void debugLog.progress(entry);
  else void debugLog.add([entry]);
};
clearWhenTurnedOff(chrome.storage.onChanged, debugLog);
// With the setting off (the default), requests get no sink at all, so
// nothing about their prompt or reply is copied, parsed or sent (PR 9.4).
// Until the setting is read, the sink is given and the log itself checks.
const debugSetting = followDebugSetting(chrome.storage.sync, chrome.storage.onChanged);
const roundTripSink = (): RoundTripSink | undefined =>
  debugSetting.current() === false ? undefined : recordRoundTrip;

// The debug window (PR 9.4): the popup's Debug button and the toolbar
// button's right-click menu open it, one at a time.
const debugWindow = createDebugWindowOpener({
  windows: chrome.windows,
  storage: chrome.storage.session,
  url: chrome.runtime.getURL('debug.html'),
});
const debugMenu = setupDebugMenu({
  menus: chrome.contextMenus,
  onChanged: chrome.storage.onChanged,
  isOn: async () => (await getSettings()).debugWindow,
  open: () => debugWindow.open(),
});
// The chat in Chrome's side panel (PR 11.8): the toolbar button's menu gets
// Open chat while Chat opens in is Side panel, made after the debug item.
const chatMenu = setupChatMenu({
  menus: chrome.contextMenus,
  sidePanel: chrome.sidePanel,
  onChanged: chrome.storage.onChanged,
  isOn: async () => (await getSettings()).chatOpensIn === 'sidepanel',
  after: debugMenu,
});
// Keyboard shortcuts you can change on chrome://extensions/shortcuts, and
// Explain with PR Explainer in a PR page's right-click menu (PR 11.9,
// src/commands.ts). Both go to the PR tab, which knows what to explain.
setupCommands({
  commands: chrome.commands,
  tabs: chrome.tabs,
  sidePanel: chrome.sidePanel,
  chatPlace: followChatPlace(chrome.storage.sync, chrome.storage.onChanged).current,
});
void setupExplainMenu({ menus: chrome.contextMenus, tabs: chrome.tabs, after: chatMenu });

// The model's context window, and whether it can think (PR 9.5), from one
// lookup per model (src/llm/contextSize.ts).
const { contextTokens, thinking } = createModelLookup(createLlmClient);

// The window the model was last run with, so a warm click does not ask
// /api/ps first (PR 9.7). Every request to the model updates it.
const loadedWindow = createLoadedWindowMemory();

// Loads the model when a PR's diffs open, before the first click (PR 8.3).
// It loads it with the window the first click will ask for (PR 8.5).
const warmup = createWarmup({
  getSettings,
  createClient: createLlmClient,
  contextTokens,
  loadedWindow,
  // Read when each request starts, so turning the setting on or off applies to the next one.
  get onRoundTrip() {
    return roundTripSink();
  },
});

// Finished explanations, each under its own key (src/explain/explainCache.ts),
// and a copy on disk that outlives Chrome for Keep answers for days (PR 10.9,
// src/explain/persistentCache.ts). Reads try the session cache first.
const sessionCache = createExplainCache(chrome.storage.session);
const savedAnswers = createPersistentCache({
  indexedDB,
  keepDays: async () => (await getSettings()).keepAnswersDays,
});
const explainCache = createLayeredCache(sessionCache, savedAnswers);
// Old answers go when the worker starts, and at once when the setting is
// lowered (0 removes them all).
void savedAnswers.prune();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && Object.hasOwn(changes, storageKey('keepAnswersDays'))) {
    void savedAnswers.prune();
  }
});

const explainDeps: ExplainDeps = {
  getSettings,
  createClient: createLlmClient,
  platform: detectPlatform(navigator.userAgent),
  // Finished explanations are kept, so clicking the same line again answers
  // at once, even after Chrome restarts (PR 10.9).
  cache: explainCache,
  contextTokens,
  thinking,
  loadedWindow,
  // A click while the model is still loading lists the warm-up's round trips (PR 9.2).
  warmupRoundTrips: () => warmup.inFlight(),
  // Read when each request starts, so turning the setting on or off applies to the next one.
  get onRoundTrip() {
    return roundTripSink();
  },
};
const explain = createExplainHandler(explainDeps);
// Every changed line of a hunk in one request (PR 10.5), for background work.
const explainHunk = createHunkExplainHandler(explainDeps);

// Every explanation a PR tab asks for goes through one queue (PR 10.3,
// src/explain/prefetchQueue.ts): clicks at once, Explain on hover and
// Explain ahead one at a time behind them, shared by every tab. With the
// Debug window setting on, what it does is shown in a "Queue" group, a new
// one when it starts working after being empty for QUEUE_GROUP_IDLE_MS (so
// Explain ahead's lines, one after another, share a group).
const QUEUE_GROUP_IDLE_MS = 5_000;
let queueGroup = crypto.randomUUID();
let queueIdleSince: number | undefined;
// Requests at once (PR 10.6): how many jobs run together, read as each job
// could start, so a save applies at once.
const requestsAtOnce = followRequestsAtOnce(chrome.storage.sync, chrome.storage.onChanged);
// The queue's background jobs are saved to chrome.storage.session on each
// change, and put back when Chrome stops this worker and starts it again
// (PR 11.5, src/explain/savedQueue.ts).
const savedQueue = createSavedQueue<ExplainPayload>({
  storage: chrome.storage.session,
  openTabs: async () =>
    (await chrome.tabs.query({})).flatMap((tab) =>
      tab.id === undefined ? [] : [{ id: tab.id, ...(tab.url !== undefined && { url: tab.url }) }],
    ),
});
const explainQueue = createPrefetchQueue<ExplainPayload, ExplainResult | HunkResult>({
  concurrency: () => requestsAtOnce.current(),
  onChange: () => savedQueue.changed(),
  // Every answer and failure says whether Ollama is up (PR 11.6).
  run: async (payload, options) =>
    noteResult(await (payload.hunk ? explainHunk(payload, options) : explain(payload, options))),
  failed: (result) => result.status === 'failed',
  cached: (result) =>
    result.status === 'hunk'
      ? result.lines.every((line) => line.status === 'cached')
      : result.status === 'done' && result.cached !== undefined,
  // The lines a hunk's answer left out go back one by one.
  followUps: (spec, result) =>
    result.status === 'hunk' && spec.payload.hunk
      ? result.lines.flatMap((line, i) =>
          line.status === 'missing'
            ? [explainJob(linePayload(spec.payload, spec.payload.hunk!.lines[i]!), spec.tab)]
            : [],
        )
      : [],
  onEvent: (event) => {
    const at = Date.now();
    if (queueIdleSince !== undefined && at - queueIdleSince > QUEUE_GROUP_IDLE_MS) {
      queueGroup = crypto.randomUUID();
    }
    queueIdleSince = event.running === 0 && event.waiting === 0 ? at : undefined;
    if (debugSetting.current() !== false) {
      void debugLog.add([{ kind: 'queue', group: queueGroup, cause: 'queue', at, event }]);
    }
  },
});
// The toolbar button turns click-to-explain on and off for every tab, and
// shows Whole PR's progress in a tab (PR 10.7).
const toolbar = setupToolbarToggle({ action: chrome.action, storage: chrome.storage.local });
// Background work on battery (PR 11.3): while a tab says the laptop is on
// battery with the setting on Pause, the queue starts no new background job
// and the toolbar icon shows the pause. Kept across worker restarts.
const backgroundPause = createBackgroundPause({
  storage: chrome.storage.session,
  onChange: (paused) => {
    explainQueue.setPaused(paused);
    void toolbar.showPaused(paused);
  },
});
/** Whether any tab shows a GitHub PR (a tab's URL is read for GitHub only). */
async function prTabOpen(): Promise<boolean> {
  return (await chrome.tabs.query({ url: 'https://github.com/*/*/pull/*' })).length > 0;
}
// The Ollama status (PR 11.6, src/llm/ollamaStatus.ts): up, down or model
// missing, from every request's result and a cheap check. While it is not
// up, background work is paused and each PR tab shows one banner with the
// fix (src/statusBanner.ts); the worker checks again after 2, 4 and 8
// seconds, then every 30, while a PR tab is open. When Ollama is back, the
// model is warmed up and background work carries on.
const ollamaStatus = createOllamaStatus({
  storage: chrome.storage.local,
  model: async () => (await getSettings()).model,
  prTabOpen,
  check: async () => {
    const settings = await getSettings();
    try {
      // /api/tags: one request says whether Ollama answers and has the model.
      const models = await createLlmClient(settings).listModels();
      const { model } = settings;
      return !model || models.some((listed) => isSameModel(listed.name, model))
        ? { state: 'up' as const }
        : { state: 'model-missing' as const, model };
    } catch (error) {
      const found = stateOfErrorKind(llmErrorKind(error));
      // Ollama answered, with another problem a click explains (such as a
      // blocked origin): the banner is not for that.
      if (!found && llmErrorKind(error) !== undefined) return { state: 'up' as const };
      if (!found) throw error;
      return { state: found };
    }
  },
  onChange: (status) => {
    explainQueue.setPaused(status.state === 'down' || status.state === 'model-missing', 'ollama');
  },
  onRecover: () => {
    console.info('[PR Explainer] Ollama is back: warming up the model');
    void warmup.warmUp(undefined, { pr: '' });
  },
});
/** Tells the Ollama status what a request found, and hands its result on. */
function noteResult<R extends ResultLike>(result: R): R {
  const found = stateOfResult(result);
  if (found) ollamaStatus.report(found);
  return result;
}
/**
 * The same for a chat answer. A Chat model of its own says only whether
 * Ollama answers, not whether the explanation model is installed (review on #75).
 */
async function noteChatResult<R extends ResultLike>(result: R): Promise<R> {
  if (!hasOwnChatModel(await getSettings())) return noteResult(result);
  ollamaStatus.reportOtherModel(stateOfResult(result));
  return result;
}
// A new URL or model may fix it, or break it: check again, if a PR tab is open.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (!Object.hasOwn(changes, storageKey('llmUrl')) && !Object.hasOwn(changes, storageKey('model')))
    return;
  void prTabOpen().then((open) => {
    if (open) void ollamaStatus.check();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  warmup.forgetTab(tabId);
  toolbar.forgetTab(tabId);
  backgroundPause.forgetTab(tabId);
  // Only that tab's callers: a job shared with another tab keeps going.
  explainQueue.dropTab(tabId);
});
// A tab that loads a new page (a reload, or leaving GitHub) lets go of the
// pause; its new page says again if it holds it (review on #71).
forgetTabOnLoad(chrome.tabs.onUpdated, backgroundPause);
// A tab that loads a new page lets go of the jobs the queue holds for it
// with no page port (restored ones, PR 11.5, and hunk follow-ups); its new
// page asks again for what it wants (review on #74).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') explainQueue.releaseTab(tabId);
});
// Put back the jobs from before a restart (PR 11.5), once the battery pause
// kept from before is read, so they do not start while it holds. The debug
// window shows "worker restarted, N jobs restored".
const restart = backgroundPause.ready.then(() => savedQueue.start(explainQueue));
void restart.then(({ restarted, restored }) => {
  if (restarted) console.info(`[PR Explainer] worker restarted, ${restored} jobs restored`);
});

// Listeners must be added on the first run of the worker, before it goes idle,
// so Chrome can wake it for later messages.
new MessageRouter()
  .on('ping', () => {
    console.info('[PR Explainer] ping received');
    return { receivedAt: Date.now() };
  })
  .on('warmup', async (payload, sender) => {
    const result = await warmup.warmUp(sender.tab?.id, payload);
    // A model loaded, or found loaded, means Ollama is up (PR 11.6). A chat
    // warm-up loads the Chat model, which says nothing of the explanation
    // model (a chat warm-up with the same model does nothing: same-model).
    if (result.outcome === 'loaded' || result.outcome === 'already-loaded') {
      if (payload?.for === 'chat') ollamaStatus.reportOtherModel('up');
      else ollamaStatus.report('up');
    }
    return result;
  })
  // The banner's status, checked unless known to be up; Try again checks at once (PR 11.6).
  .on('ollamaStatus', (payload) =>
    payload?.retry === true ? ollamaStatus.check() : ollamaStatus.ensure(),
  )
  // A click's GitHub round trips and trace join the debug log (PR 9.3).
  .on('debugLogAdd', async (payload) => ({
    added: (await debugLog.add(pageEntries(payload))).length,
  }))
  .on('debugLogClear', async () => {
    await debugLog.clear();
    return { cleared: true as const };
  })
  // The settings page's Clear saved answers button (PR 10.9).
  .on('clearSavedAnswers', async () => {
    await explainCache.clear();
    return { cleared: true as const };
  })
  .on('openDebugWindow', async () => ({ window: await debugWindow.open() }))
  // The popup's Ask a question button (PR 11.8). Not async: Chrome opens the
  // side panel only if open() is called before anything is awaited.
  .on('openSidePanel', (_payload, sender) =>
    openSidePanel(
      chrome.sidePanel,
      sender.tab?.id !== undefined ? { tabId: sender.tab.id } : undefined,
    ),
  )
  .on('backgroundPaused', (payload, sender) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) backgroundPause.report(tabId, payload.paused);
    return { paused: backgroundPause.paused() };
  })
  // GitHub's own page changes load no page: the tab says which PR it shows
  // now, and work held for another one goes (review on #74).
  .on('tabPr', (payload, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { released: 0 };
    const pr = typeof payload?.pr === 'string' ? payload.pr : null;
    return { released: explainQueue.releaseTab(tabId, pr) };
  })
  .on('aheadProgress', async (payload, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { shown: false };
    await toolbar.showProgress(tabId, payload);
    return { shown: true };
  })
  .listen();
// The debug window follows the log live over its own port.
listenForDebugLogPorts(chrome.runtime, debugLog);
// Explanations stream over a port, so the popup can show the reply as it
// arrives and stop it midway (see src/messaging/streamPort.ts).
// They go through the queue, which joins a click to the same line's
// background job and stops the others while it runs.
listenForExplainPorts(chrome.runtime, (payload, { tab, ...options }) =>
  explainQueue.add(explainJob(payload, tab), options),
);
// Pages with background work keep a port open, which keeps this worker
// running, and hear from it when it has restarted (PR 11.5).
listenForWorkerPorts(chrome.runtime, {
  worker: crypto.randomUUID(),
  restored: async () => (await restart).restored,
});
// Chat answers (the chat panel) stream the same way, over their own port.
// Each answer or failure also says whether Ollama is up (PR 11.6).
const chat = createChatHandler({
  getSettings,
  createClient: createLlmClient,
  platform: detectPlatform(navigator.userAgent),
  contextTokens,
  thinking,
  loadedWindow,
  // Read when each request starts, so turning the setting on or off applies to the next one.
  get onRoundTrip() {
    return roundTripSink();
  },
});
listenForChatPorts(chrome.runtime, async (payload, options) =>
  noteChatResult(await chat(payload, options)),
);

// Chrome clears the icon badge when the browser restarts. Having a startup
// listener makes Chrome start this worker then, which redraws the badge above.
chrome.runtime.onStartup.addListener(() => {});

// Dev builds (`npm run dev`) expose the settings module and the LLM client in
// the service worker console for manual testing. Production builds leave this
// out. Each debugLlm call reads the settings again, so saving a new URL or
// model with debugSettings takes effect on the next call.
if (import.meta.env.MODE === 'development') {
  const client = async () => createLlmClient(await getSettings());
  Object.assign(globalThis, {
    debugSettings: { defaults: DEFAULT_SETTINGS, get: getSettings, save: saveSettings },
    debugLlm: {
      listModels: async () => (await client()).listModels(),
      chat: async (prompt: string) => {
        const settings = await getSettings();
        return createLlmClient(settings).chat([{ role: 'user', content: prompt }], {
          model: settings.model,
          temperature: settings.temperature,
          maxResponseTokens: settings.maxResponseTokens,
          keepAliveMinutes: settings.keepAliveMinutes,
        });
      },
      // Streams the sample explanation, piece by piece:
      //   for await (const c of debugLlm.streamSample()) console.log(c)
      // Pass an AbortSignal to stop it early.
      streamSample: async function* (signal?: AbortSignal) {
        const settings = await getSettings();
        return yield* createLlmClient(settings).chatStream(buildExplainPrompt(SAMPLE_CONTEXT), {
          model: settings.model,
          temperature: settings.temperature,
          maxResponseTokens: settings.maxResponseTokens,
          keepAliveMinutes: settings.keepAliveMinutes,
          signal,
        });
      },
      // Runs the same code as an `explain` request from a GitHub page.
      explain: (context: string) => explain({ context }),
      // Lists what the session cache holds, least recently used first (cleared when Chrome
      // closes; the copy on disk, PR 10.9, is in IndexedDB "pr-explainer").
      cache: () => explainCache.list(),
      explainSample: () => explain({ context: SAMPLE_CONTEXT }),
      // Lists the debug log (PR 9.3), oldest first.
      log: () => debugLog.read(),
      // The background queue's running and waiting jobs (PR 10.3).
      queue: () => explainQueue.state(),
    },
  });
  console.info(
    '[PR Explainer] dev build: debugSettings and debugLlm are available in this console',
  );
} else {
  // Says why the helpers are missing if someone tries them on a production build.
  console.info('[PR Explainer] production build: debug helpers are off (use `npm run dev`)');
}
