// Entry point for options.html: runs the settings page with the real
// chrome.storage settings and the Ollama client.
import { createLlmClient } from '../llm/createClient';
import { detectPlatform } from '../llm/describeLlmError';
import { loadMeasurements, saveMeasurement } from '../llm/speedTest';
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
  createClient: (settings) => createLlmClient(settings),
  platform: detectPlatform(navigator.userAgent),
  loadMeasurements: () => loadMeasurements(chrome.storage.local),
  saveMeasurement: (measurement) => saveMeasurement(chrome.storage.local, measurement),
  // The service worker owns the caches (PR 10.9). This talks to it with
  // chrome.runtime directly, not src/messaging/client.ts, which the content
  // script imports: code shared with it must not end up in a chunk.
  clearSavedAnswers: () => askWorker('clearSavedAnswers'),
  // The service worker owns the ratings too (PR 11.11).
  clearRatings: () => askWorker('clearRatings'),
});

// Keyboard shortcuts (PR 11.9): the keys Chrome gave the commands, and a
// button to Chrome's page for changing them.
initShortcuts(document, {
  getAll: () => chrome.commands.getAll(),
  openTab: (url) => chrome.tabs.create({ url }),
});
