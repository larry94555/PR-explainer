// Entry point for options.html: runs the settings page with the real
// chrome.storage settings and the Ollama client.
import { builtInAvailability, downloadBuiltIn, promptApi } from '../llm/chromeAiClient';
import { createLlmClient } from '../llm/createClient';
import { detectPlatform } from '../llm/describeLlmError';
import { loadMeasurements, saveMeasurement } from '../llm/speedTest';
import { parseRatings, RATINGS_KEY } from '../ratings';
import { getSettings, saveSettings } from '../settings';
import { initOptionsPage } from './optionsPage';
import { initShortcuts } from './shortcuts';

/** Sends a request with no payload to the service worker, failing if it does not say ok. */
async function askWorker(type: 'clearSavedAnswers' | 'clearRatings'): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    source: 'pr-explainer',
    type,
    payload: undefined,
  })) as { ok?: boolean; error?: { message?: string } } | undefined;
  if (!response?.ok) throw new Error(response?.error?.message ?? 'No answer from the extension.');
}

void initOptionsPage(document, {
  getSettings: () => getSettings(),
  saveSettings: (update) => saveSettings(update),
  // The page's own Speed test, Measure and Test connection talk to Ollama.
  createClient: (settings) => createLlmClient({ llmUrl: settings.llmUrl }),
  // Chrome's built-in model (PR 11.13), asked from this page, which has the
  // Prompt API and the button press Chrome needs to start the download.
  builtIn: {
    availability: () => builtInAvailability(promptApi()),
    download: async (onProgress) => {
      const api = promptApi();
      if (!api) throw new Error('This version of Chrome has no built-in model for extensions.');
      await downloadBuiltIn(api, onProgress);
    },
  },
  platform: detectPlatform(navigator.userAgent),
  loadMeasurements: () => loadMeasurements(chrome.storage.local),
  saveMeasurement: (measurement) => saveMeasurement(chrome.storage.local, measurement),
  // The service worker owns the caches (PR 10.9). This talks to it with
  // chrome.runtime directly, not src/messaging/client.ts, which the content
  // script imports: code shared with it must not end up in a chunk.
  clearSavedAnswers: () => askWorker('clearSavedAnswers'),
  // The service worker owns the ratings too (PR 11.11).
  clearRatings: () => askWorker('clearRatings'),
  // Reading needs no queue, so the page reads the ratings itself (PR 11.12).
  loadRatings: async () =>
    parseRatings((await chrome.storage.local.get([RATINGS_KEY]))[RATINGS_KEY]),
  saveFile: (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    // Chrome has started the download by the time the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
});

// Keyboard shortcuts (PR 11.9): the keys Chrome gave the commands, and a
// button to Chrome's page for changing them.
initShortcuts(document, {
  getAll: () => chrome.commands.getAll(),
  openTab: (url) => chrome.tabs.create({ url }),
});
