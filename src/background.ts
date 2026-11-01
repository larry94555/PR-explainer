// Service worker. Answers requests from the content script (see
// src/messaging/). Milestone 2 adds the calls to the local LLM.
import { MessageRouter } from './messaging/router';

console.info('[PR Explainer] service worker started');

// Listeners must be added on the first run of the worker, before it goes idle,
// so Chrome can wake it for later messages.
new MessageRouter()
  .on('ping', () => {
    console.info('[PR Explainer] ping received');
    return { receivedAt: Date.now() };
  })
  .listen();
