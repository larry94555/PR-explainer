// The offscreen document (PR 11.13): runs Chrome's built-in model for the
// service worker, which Chrome may not give the Prompt API
// (src/llm/offscreenAi.ts). It shows nothing.
import { ChromeAiClient } from '../llm/chromeAiClient';
import { serveChromeAi } from '../llm/offscreenAi';

serveChromeAi(chrome.runtime, new ChromeAiClient());
