// Entry point for options.html: runs the settings page with the real
// chrome.storage settings and the Ollama client.
import { createLlmClient } from '../llm/createClient';
import { getSettings, saveSettings } from '../settings';
import { initOptionsPage } from './optionsPage';

void initOptionsPage(document, {
  getSettings: () => getSettings(),
  saveSettings: (update) => saveSettings(update),
  createClient: (settings) => createLlmClient(settings),
});
