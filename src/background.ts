// Service worker. Answers requests from the content script (see
// src/messaging/). All calls to the local LLM run here (see src/llm/).
import { CACHE_STORAGE_KEY, createExplainCache } from './explain/explainCache';
import { createExplainHandler } from './explain/explainHandler';
import { buildExplainPrompt } from './explain/explainPrompt';
import { SAMPLE_CONTEXT } from './explain/sampleContext';
import { createLlmClient } from './llm/createClient';
import { detectPlatform } from './llm/describeLlmError';
import { MessageRouter } from './messaging/router';
import { listenForExplainPorts } from './messaging/streamPort';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from './settings';
import { setupToolbarToggle } from './toolbarToggle';

console.info('[PR Explainer] service worker started');

const explain = createExplainHandler({
  getSettings,
  createClient: createLlmClient,
  platform: detectPlatform(navigator.userAgent),
  // Finished explanations are kept for the browser session, so clicking the
  // same line again answers at once (src/explain/explainCache.ts).
  cache: createExplainCache(chrome.storage.session),
});

// Listeners must be added on the first run of the worker, before it goes idle,
// so Chrome can wake it for later messages.
new MessageRouter()
  .on('ping', () => {
    console.info('[PR Explainer] ping received');
    return { receivedAt: Date.now() };
  })
  .listen();
// Explanations stream over a port, so the popup can show the reply as it
// arrives and stop it midway (see src/messaging/streamPort.ts).
listenForExplainPorts(chrome.runtime, explain);

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
          signal,
        });
      },
      // Runs the same code as an `explain` request from a GitHub page.
      explain: (context: string) => explain({ context }),
      // Lists what the explanation cache holds (cleared when Chrome closes).
      cache: async () =>
        (await chrome.storage.session.get([CACHE_STORAGE_KEY]))[CACHE_STORAGE_KEY] ?? [],
      explainSample: () => explain({ context: SAMPLE_CONTEXT }),
    },
  });
  console.info(
    '[PR Explainer] dev build: debugSettings and debugLlm are available in this console',
  );
} else {
  // Says why the helpers are missing if someone tries them on a production build.
  console.info('[PR Explainer] production build: debug helpers are off (use `npm run dev`)');
}
