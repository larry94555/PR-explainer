// Service worker. Answers requests from the content script (see
// src/messaging/). All calls to the local LLM run here (see src/llm/).
import { createChatHandler } from './chat/chatHandler';
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
import {
  createExplainHandler,
  type ExplainPayload,
  type ExplainResult,
} from './explain/explainHandler';
import { buildExplainPrompt } from './explain/explainPrompt';
import { createPrefetchQueue, explainJob } from './explain/prefetchQueue';
import { SAMPLE_CONTEXT } from './explain/sampleContext';
import { createModelLookup } from './llm/contextSize';
import { createLlmClient } from './llm/createClient';
import { detectPlatform } from './llm/describeLlmError';
import { createLoadedWindowMemory } from './llm/loadedWindow';
import { createWarmup } from './llm/warmup';
import { MessageRouter } from './messaging/router';
import { listenForChatPorts, listenForExplainPorts } from './messaging/streamPort';
import type { RoundTripSink } from './net/roundTrips';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from './settings';
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
void setupDebugMenu({
  menus: chrome.contextMenus,
  onChanged: chrome.storage.onChanged,
  isOn: async () => (await getSettings()).debugWindow,
  open: () => debugWindow.open(),
});

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

// Finished explanations, each under its own key (src/explain/explainCache.ts).
const explainCache = createExplainCache(chrome.storage.session);

const explain = createExplainHandler({
  getSettings,
  createClient: createLlmClient,
  platform: detectPlatform(navigator.userAgent),
  // Finished explanations are kept for the browser session, so clicking the
  // same line again answers at once (src/explain/explainCache.ts).
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
});

// Every explanation a PR tab asks for goes through one queue (PR 10.3,
// src/explain/prefetchQueue.ts): clicks at once, Explain on hover and
// Explain ahead one at a time behind them, shared by every tab. With the
// Debug window setting on, what it does is shown in a "Queue" group, a new
// one when it starts working after being empty for QUEUE_GROUP_IDLE_MS (so
// Explain ahead's lines, one after another, share a group).
const QUEUE_GROUP_IDLE_MS = 5_000;
let queueGroup = crypto.randomUUID();
let queueIdleSince: number | undefined;
const explainQueue = createPrefetchQueue<ExplainPayload, ExplainResult>({
  run: (payload, options) => explain(payload, options),
  failed: (result) => result.status === 'failed',
  cached: (result) => result.status === 'done' && result.cached !== undefined,
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
chrome.tabs.onRemoved.addListener((tabId) => {
  warmup.forgetTab(tabId);
  // Only that tab's callers: a job shared with another tab keeps going.
  explainQueue.dropTab(tabId);
});

// Listeners must be added on the first run of the worker, before it goes idle,
// so Chrome can wake it for later messages.
new MessageRouter()
  .on('ping', () => {
    console.info('[PR Explainer] ping received');
    return { receivedAt: Date.now() };
  })
  .on('warmup', (payload, sender) => warmup.warmUp(sender.tab?.id, payload))
  // A click's GitHub round trips and trace join the debug log (PR 9.3).
  .on('debugLogAdd', async (payload) => ({
    added: (await debugLog.add(pageEntries(payload))).length,
  }))
  .on('debugLogClear', async () => {
    await debugLog.clear();
    return { cleared: true as const };
  })
  .on('openDebugWindow', async () => ({ window: await debugWindow.open() }))
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
// Chat answers (the chat panel) stream the same way, over their own port.
listenForChatPorts(
  chrome.runtime,
  createChatHandler({
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
  }),
);

// The toolbar button turns click-to-explain on and off for every tab.
setupToolbarToggle({ action: chrome.action, storage: chrome.storage.local });
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
      // Lists what the explanation cache holds, least recently used first (cleared when Chrome closes).
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
