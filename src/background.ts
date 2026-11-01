// Service worker. Answers requests from the content script (see
// src/messaging/). All calls to the local LLM run here (see src/llm/).
import { createLlmClient } from './llm/createClient';
import { MessageRouter } from './messaging/router';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from './settings';

console.info('[PR Explainer] service worker started');

// Listeners must be added on the first run of the worker, before it goes idle,
// so Chrome can wake it for later messages.
new MessageRouter()
  .on('ping', () => {
    console.info('[PR Explainer] ping received');
    return { receivedAt: Date.now() };
  })
  .listen();

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
    },
  });
  console.info(
    '[PR Explainer] dev build: debugSettings and debugLlm are available in this console',
  );
}
