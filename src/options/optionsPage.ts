// The settings page: the Ollama URL, a model dropdown filled from the server,
// temperature, max response length, Save, and Test connection.
//
// All page logic lives here and takes its dependencies as parameters, so the
// tests can run it against options.html in jsdom with fakes. main.ts wires in
// the real settings module and LLM client.
//
// The page talks to the LLM directly instead of through the service worker.
// It is an extension page, so it has the same host permissions as the worker,
// and calling the client here keeps the typed LlmError (its `kind`) that PR 2.4
// turns into friendly messages. Content scripts still never call the LLM.

import type { LlmClient } from '../llm/types';
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  validateSettings,
  type Settings,
  type SettingsField,
  type SettingsIssue,
} from '../settings';

export interface OptionsPageDeps {
  getSettings(): Promise<Settings>;
  saveSettings(update: Partial<Settings>): Promise<Settings>;
  createClient(settings: Pick<Settings, 'llmUrl'>): LlmClient;
  /** Milliseconds, for timing the test reply. Defaults to performance.now. */
  now?: () => number;
}

export const TEST_PROMPT = 'Reply with OK';
// A test reply is only a sign of life; a short limit keeps it fast.
const TEST_MAX_TOKENS = 32;
// Long replies are cut so the status line stays readable.
const MAX_REPLY_CHARS = 200;

export interface OptionsPage {
  refreshModels(): Promise<void>;
  save(): Promise<void>;
  testConnection(): Promise<void>;
}

function el<T extends HTMLElement>(doc: Document, id: string): T {
  const found = doc.getElementById(id);
  if (!found) throw new Error(`options.html is missing #${id}`);
  return found as T;
}

/** Loads the saved settings into the form, fills the model list, and wires up the buttons. */
export async function initOptionsPage(doc: Document, deps: OptionsPageDeps): Promise<OptionsPage> {
  const now = deps.now ?? (() => performance.now());
  const form = el<HTMLFormElement>(doc, 'settings-form');
  const urlInput = el<HTMLInputElement>(doc, 'llmUrl');
  const modelSelect = el<HTMLSelectElement>(doc, 'model');
  const temperatureInput = el<HTMLInputElement>(doc, 'temperature');
  const temperatureValue = el<HTMLOutputElement>(doc, 'temperature-value');
  const maxTokensInput = el<HTMLInputElement>(doc, 'maxResponseTokens');
  const refreshButton = el<HTMLButtonElement>(doc, 'refresh-models');
  const testButton = el<HTMLButtonElement>(doc, 'test-connection');
  const saveButton = el<HTMLButtonElement>(doc, 'save');
  const modelsStatus = el(doc, 'models-status');
  const saveStatus = el(doc, 'save-status');
  const testStatus = el(doc, 'test-status');

  // --- Reading and writing the form ---

  function fillForm(settings: Settings): void {
    urlInput.value = settings.llmUrl;
    setModelOptions(null, settings.model);
    temperatureInput.value = String(settings.temperature);
    temperatureValue.textContent = String(settings.temperature);
    maxTokensInput.value = String(settings.maxResponseTokens);
  }

  function readForm(): Settings {
    const maxTokens = maxTokensInput.value.trim();
    return {
      llmUrl: urlInput.value.trim().replace(/\/+$/, ''),
      model: modelSelect.value,
      temperature: Number(temperatureInput.value),
      // An empty box becomes NaN so validation reports it instead of using 0.
      maxResponseTokens: maxTokens === '' ? NaN : Number(maxTokens),
    };
  }

  function showIssues(issues: SettingsIssue[]): void {
    for (const p of doc.querySelectorAll<HTMLElement>('[data-error-for]')) {
      const field = p.dataset.errorFor as SettingsField;
      p.textContent = issues.find((i) => i.field === field)?.message ?? '';
    }
  }

  // Checks the form without saving. Returns the values, or null after showing
  // the problems.
  function validForm(fields: SettingsField[]): Settings | null {
    const values = readForm();
    const issues = validateSettings(values).filter((i) => fields.includes(i.field));
    showIssues(issues);
    return issues.length === 0 ? values : null;
  }

  // Lists `names` (null while the server's list is unknown), keeping `selected`
  // chosen. A saved model the server does not have stays in the list, marked,
  // so it is not silently replaced.
  function setModelOptions(names: string[] | null, selected: string): void {
    const options: HTMLOptionElement[] = [];
    if (!selected) options.push(new Option('Choose a model', ''));
    for (const name of names ?? []) options.push(new Option(name, name));
    if (selected && !names?.includes(selected)) {
      const label = names ? `${selected} (not installed)` : selected;
      options.push(new Option(label, selected));
    }
    modelSelect.replaceChildren(...options);
    modelSelect.value = selected;
  }

  // --- Actions ---

  // Each refresh gets a number so a slow, older reply cannot overwrite a newer one.
  let refreshCount = 0;
  async function refreshModels(): Promise<void> {
    // Counted before validating, so a bad URL also makes a pending load stale.
    const thisRefresh = ++refreshCount;
    const values = validForm(['llmUrl']);
    if (!values) {
      modelsStatus.textContent = 'Fix the URL to load models.';
      return;
    }
    modelsStatus.textContent = `Loading models from ${values.llmUrl}…`;
    try {
      const models = await deps.createClient(values).listModels();
      if (thisRefresh !== refreshCount) return;
      // Read the selection now, in case the user changed it while loading.
      setModelOptions(
        models.map((m) => m.name),
        modelSelect.value,
      );
      modelsStatus.textContent =
        models.length === 0
          ? 'No models installed. Run `ollama pull qwen2.5-coder:7b`, then click Refresh.'
          : `${models.length} model${models.length === 1 ? '' : 's'} found.`;
    } catch (error) {
      if (thisRefresh !== refreshCount) return;
      modelsStatus.textContent = `Could not load models: ${errorMessage(error)}`;
    }
  }

  async function save(): Promise<void> {
    saveStatus.textContent = '';
    saveButton.disabled = true;
    try {
      const saved = await deps.saveSettings(readForm());
      showIssues([]);
      urlInput.value = saved.llmUrl;
      saveStatus.textContent = 'Saved.';
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        showIssues(error.issues);
        saveStatus.textContent = 'Not saved. Fix the problems above.';
      } else {
        saveStatus.textContent = `Not saved: ${errorMessage(error)}`;
      }
    } finally {
      saveButton.disabled = false;
    }
  }

  // Uses what is in the form, saved or not, so a setup can be tried before saving.
  async function testConnection(): Promise<void> {
    const values = validForm(['llmUrl', 'temperature', 'maxResponseTokens']);
    if (!values) {
      testStatus.textContent = 'Fix the problems above, then test again.';
      return;
    }
    if (!values.model) {
      testStatus.textContent = 'Choose a model first.';
      return;
    }
    testButton.disabled = true;
    testStatus.textContent = `Asking ${values.model}…`;
    const started = now();
    try {
      const reply = await deps.createClient(values).chat([{ role: 'user', content: TEST_PROMPT }], {
        model: values.model,
        temperature: values.temperature,
        maxResponseTokens: Math.min(values.maxResponseTokens, TEST_MAX_TOKENS),
      });
      const ms = Math.round(now() - started);
      testStatus.textContent = `Reply from ${reply.model} in ${ms} ms: "${shorten(reply.content)}"`;
    } catch (error) {
      testStatus.textContent = `Test failed: ${errorMessage(error)}`;
    } finally {
      testButton.disabled = false;
    }
  }

  // --- Start up ---

  temperatureInput.addEventListener('input', () => {
    temperatureValue.textContent = temperatureInput.value;
  });
  urlInput.addEventListener('change', () => void refreshModels());
  refreshButton.addEventListener('click', () => void refreshModels());
  testButton.addEventListener('click', () => void testConnection());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save();
  });

  let settings: Settings;
  try {
    settings = await deps.getSettings();
  } catch (error) {
    settings = { ...DEFAULT_SETTINGS };
    saveStatus.textContent = `Could not load saved settings: ${errorMessage(error)}`;
  }
  fillForm(settings);
  await refreshModels();

  return { refreshModels, save, testConnection };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_REPLY_CHARS ? `${trimmed.slice(0, MAX_REPLY_CHARS)}…` : trimmed;
}
