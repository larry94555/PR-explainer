// Service worker. Answers requests from the content script (see
// src/messaging/). Milestone 2 adds the calls to the local LLM.
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

// Dev builds (`npm run dev`) expose the settings module in the service worker
// console for manual testing. Production builds leave this out.
if (import.meta.env.MODE === 'development') {
  Object.assign(globalThis, {
    debugSettings: { defaults: DEFAULT_SETTINGS, get: getSettings, save: saveSettings },
  });
  console.info('[PR Explainer] dev build: debugSettings is available in this console');
}
