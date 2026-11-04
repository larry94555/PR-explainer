// The settings page: the Ollama URL, a model dropdown filled from the server,
// temperature, max response length, context size, how long to keep the model
// loaded (PR 8.3), Explain on hover (PR 8.7), Explain ahead (PR 9.10), Let the
// model think (PR 9.5), the Debug section (Show prompt, PR 6.2, and Debug
// window, PR 9.3), Save, and Test connection. Under the model, a line says
// whether it is a reasoning model and whether its thinking is on (PR 9.5). The
// Speed section (PR 8.6) says whether the picked model runs on the GPU, and its
// Speed test times each coding model and lets the user pick the fastest
// (src/llm/speedTest.ts). Chat model (PR 9.14) picks another model for chat
// questions, "Same as explanations" by default, with a note on the memory two
// loaded models need when another one is picked.
//
// All page logic lives here and takes its dependencies as parameters, so the
// tests can run it against options.html in jsdom with fakes. main.ts wires in
// the real settings module and LLM client.
//
// The page talks to the LLM directly instead of through the service worker.
// It is an extension page, so it has the same host permissions as the worker,
// and calling the client here keeps the typed LlmError (its `kind`), which
// describeLlmError turns into a message and a fix. Content scripts still never
// call the LLM.

import { describeLlmError, type ErrorContext, type Platform } from '../llm/describeLlmError';
import { gpuStatus } from '../llm/gpuStatus';
import { MIN_NUM_CTX } from '../llm/numCtx';
import {
  fastestUnderGoal,
  rankResults,
  runSpeedTest,
  speedTestModels,
  type SpeedResult,
} from '../llm/speedTest';
import { thinkOption } from '../llm/contextSize';
import {
  LATENCY_GOAL_MS,
  LATENCY_GOAL_SECONDS,
  SMALL_CODING_MODEL,
  TINY_CODING_MODEL,
} from '../llm/latencyGoal';
import { isSameModel, thinkingSupport, type LlmClient, type ThinkingSupport } from '../llm/types';
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  validateSettings,
  hasOwnChatModel,
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
  /** Picks the right commands in error fixes. Defaults to "other". */
  platform?: Platform;
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
  /** Shows whether the picked model runs on the GPU (PR 8.6). */
  checkGpu(): Promise<void>;
  /** Shows whether the picked model is a reasoning model and its thinking is on (PR 9.5). */
  checkThinking(): Promise<void>;
  /** Runs the Speed test (PR 8.6). Resolves when it finishes or is stopped. */
  speedTest(): Promise<void>;
  /** Stops a running Speed test. */
  stopSpeedTest(): void;
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
  const chatModelSelect = el<HTMLSelectElement>(doc, 'chatModel');
  const chatModelNote = el(doc, 'chat-model-note');
  const temperatureInput = el<HTMLInputElement>(doc, 'temperature');
  const temperatureValue = el<HTMLOutputElement>(doc, 'temperature-value');
  const maxTokensInput = el<HTMLInputElement>(doc, 'maxResponseTokens');
  const contextInput = el<HTMLInputElement>(doc, 'contextTokens');
  const keepAliveInput = el<HTMLInputElement>(doc, 'keepAliveMinutes');
  const hoverInput = el<HTMLInputElement>(doc, 'explainOnHover');
  const aheadInput = el<HTMLInputElement>(doc, 'explainAhead');
  const thinkInput = el<HTMLInputElement>(doc, 'letModelThink');
  const streamInput = el<HTMLInputElement>(doc, 'streamAnswers');
  const thinkingLine = el(doc, 'thinking-status');
  const showPromptInput = el<HTMLInputElement>(doc, 'showPrompt');
  const debugWindowInput = el<HTMLInputElement>(doc, 'debugWindow');
  const refreshButton = el<HTMLButtonElement>(doc, 'refresh-models');
  const testButton = el<HTMLButtonElement>(doc, 'test-connection');
  const saveButton = el<HTMLButtonElement>(doc, 'save');
  const modelsStatus = el(doc, 'models-status');
  const saveStatus = el(doc, 'save-status');
  const testStatus = el(doc, 'test-status');
  const gpuLine = el(doc, 'gpu-status');
  const speedButton = el<HTMLButtonElement>(doc, 'speed-test');
  const stopButton = el<HTMLButtonElement>(doc, 'speed-stop');
  const speedStatus = el(doc, 'speed-status');
  const speedTable = el<HTMLTableElement>(doc, 'speed-results');

  // --- Reading and writing the form ---

  function fillForm(settings: Settings): void {
    urlInput.value = settings.llmUrl;
    setModelOptions(null, settings.model);
    setChatModelOptions(null, settings.chatModel);
    temperatureInput.value = String(settings.temperature);
    temperatureValue.textContent = String(settings.temperature);
    maxTokensInput.value = String(settings.maxResponseTokens);
    // Automatic (0) shows as an empty box with "Automatic" as its placeholder.
    contextInput.value = settings.contextTokens > 0 ? String(settings.contextTokens) : '';
    keepAliveInput.value = String(settings.keepAliveMinutes);
    hoverInput.checked = settings.explainOnHover;
    aheadInput.checked = settings.explainAhead;
    thinkInput.checked = settings.letModelThink;
    streamInput.checked = settings.streamAnswers;
    showPromptInput.checked = settings.showPrompt;
    debugWindowInput.checked = settings.debugWindow;
  }

  function readForm(): Settings {
    const maxTokens = maxTokensInput.value.trim();
    const contextTokens = contextInput.value.trim();
    const keepAlive = keepAliveInput.value.trim();
    return {
      llmUrl: urlInput.value.trim().replace(/\/+$/, ''),
      model: modelSelect.value,
      chatModel: chatModelSelect.value,
      temperature: Number(temperatureInput.value),
      // An empty box becomes NaN so validation reports it instead of using 0.
      maxResponseTokens: maxTokens === '' ? NaN : Number(maxTokens),
      // An empty box means automatic.
      contextTokens: contextTokens === '' ? 0 : Number(contextTokens),
      keepAliveMinutes: keepAlive === '' ? NaN : Number(keepAlive),
      explainOnHover: hoverInput.checked,
      explainAhead: aheadInput.checked,
      letModelThink: thinkInput.checked,
      streamAnswers: streamInput.checked,
      showPrompt: showPromptInput.checked,
      debugWindow: debugWindowInput.checked,
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

  // The Chat model list (PR 9.14): "Same as explanations" first, then the
  // same models as Model, keeping a saved one the server does not have.
  function setChatModelOptions(names: string[] | null, selected: string): void {
    const options = [new Option(SAME_AS_EXPLANATIONS, '')];
    for (const name of names ?? []) options.push(new Option(name, name));
    if (selected && !names?.includes(selected)) {
      const label = names ? `${selected} (not installed)` : selected;
      options.push(new Option(label, selected));
    }
    chatModelSelect.replaceChildren(...options);
    chatModelSelect.value = selected;
    showChatModelNote();
  }

  // The note under Chat model: what two loaded models cost, only while chat
  // has a model of its own.
  function showChatModelNote(): void {
    const model = modelSelect.value;
    const chatModel = chatModelSelect.value;
    const own = model !== '' && hasOwnChatModel({ model, chatModel });
    chatModelNote.hidden = !own;
    chatModelNote.textContent = own ? chatModelNoteText(model, chatModel) : '';
  }

  // Shows "<prefix> <message>" and, on its own line, the fix, with `commands`
  // as code so they are easy to spot and copy.
  function showLlmError(
    target: HTMLElement,
    prefix: string,
    error: unknown,
    context: ErrorContext,
  ): void {
    const { message, fix } = describeLlmError(error, { ...context, platform: deps.platform });
    const fixLine = doc.createElement('span');
    fixLine.className = 'fix';
    fixLine.append(...withCode(doc, fix));
    target.replaceChildren(`${prefix} ${message} `, fixLine);
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
      const names = models.map((m) => m.name);
      setModelOptions(names, modelSelect.value);
      setChatModelOptions(names, chatModelSelect.value);
      modelsStatus.textContent =
        models.length === 0
          ? 'No models installed. Run `ollama pull qwen2.5-coder:7b`, then click Refresh.'
          : `${models.length} model${models.length === 1 ? '' : 's'} found.`;
      await Promise.all([checkGpu(), checkThinking()]);
    } catch (error) {
      if (thisRefresh !== refreshCount) return;
      showLlmError(modelsStatus, 'Could not load models.', error, { url: values.llmUrl });
    }
  }

  async function save(): Promise<void> {
    saveStatus.textContent = '';
    saveButton.disabled = true;
    try {
      const saved = await deps.saveSettings(readForm());
      showIssues([]);
      urlInput.value = saved.llmUrl;
      contextInput.value = saved.contextTokens > 0 ? String(saved.contextTokens) : '';
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
    const values = validForm(['llmUrl', 'temperature', 'maxResponseTokens', 'keepAliveMinutes']);
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
        keepAliveMinutes: values.keepAliveMinutes,
      });
      const ms = Math.round(now() - started);
      testStatus.textContent = `Reply from ${reply.model} in ${ms} ms: "${shorten(reply.content)}"`;
    } catch (error) {
      showLlmError(testStatus, 'Test failed.', error, {
        url: values.llmUrl,
        model: values.model,
      });
    } finally {
      testButton.disabled = false;
    }
  }

  // Each check gets a number so a slow, older reply cannot overwrite a newer one.
  let gpuCount = 0;
  async function checkGpu(): Promise<void> {
    const thisCheck = ++gpuCount;
    const values = validForm(['llmUrl']);
    const model = modelSelect.value;
    if (!values || !model) {
      gpuLine.replaceChildren();
      return;
    }
    let text: string, fix: string, className: string;
    try {
      const running = await deps.createClient(values).runningModels();
      const found = running.find((m) => isSameModel(m.name, model));
      if (!found) {
        text = `${model} is not loaded right now, so it is not known whether it runs on the GPU.`;
        fix = 'Click Speed test, or open a PR, to load it.';
        className = '';
      } else {
        const status = gpuStatus(found);
        text = `Runs on: ${status.processor}. ${status.message}`;
        fix = status.fix;
        className = status.kind === 'gpu' ? 'gpu-ok' : 'gpu-warn';
      }
    } catch {
      // Test connection and the model list already explain a server that is down.
      text = '';
      fix = '';
      className = '';
    }
    if (thisCheck !== gpuCount) return;
    gpuLine.className = className;
    const fixLine = doc.createElement('span');
    fixLine.className = 'fix';
    fixLine.append(...withCode(doc, fix));
    gpuLine.replaceChildren(text, ...(fix ? [fixLine] : []));
  }

  // Whether each model can think, by server and model, so ticking the box
  // does not ask again. Only answers the server gave are kept.
  const thinkingKnown = new Map<string, ThinkingSupport | null | undefined>();
  let thinkingCount = 0;
  async function checkThinking(): Promise<void> {
    const thisCheck = ++thinkingCount;
    const values = validForm(['llmUrl']);
    const model = modelSelect.value;
    if (!values || !model) {
      thinkingLine.replaceChildren();
      return;
    }
    const key = `${values.llmUrl} ${model}`;
    let thinks: ThinkingSupport | null | undefined;
    if (thinkingKnown.has(key)) thinks = thinkingKnown.get(key);
    else {
      try {
        thinks = thinkingSupport(await deps.createClient(values).modelContext(model));
        thinkingKnown.set(key, thinks);
      } catch {
        // Test connection and the model list already explain a server that is down.
        if (thisCheck === thinkingCount) thinkingLine.replaceChildren();
        return;
      }
    }
    if (thisCheck !== thinkingCount) return;
    thinkingLine.textContent = thinkingText(model, thinks, thinkInput.checked);
  }

  let speedRun: AbortController | null = null;
  let lastResults: SpeedResult[] = [];

  // The fastest is only marked once every model has been timed, not while the
  // test runs or after it is stopped.
  let resultsFinal = false;
  function showResults(results: readonly SpeedResult[], final = resultsFinal): void {
    lastResults = [...results];
    resultsFinal = final;
    const pick = final ? fastestUnderGoal(results) : undefined;
    const rows = rankResults(results).map((result) => {
      const row = doc.createElement('tr');
      const name = doc.createElement('td');
      name.textContent = result.model;
      if (result.model === pick) {
        row.className = 'pick';
        const badge = doc.createElement('span');
        badge.className = 'badge';
        badge.textContent = `Fastest under ${LATENCY_GOAL_SECONDS} s`;
        name.append(badge);
      }
      row.append(name);
      if (result.status === 'done') {
        row.append(
          cell(doc, `${(result.totalMs / 1000).toFixed(1)} s`, 'num'),
          cell(doc, result.tokensPerSecond?.toFixed(1) ?? '–', 'num'),
          cell(doc, result.gpu?.processor ?? '–'),
        );
        if (result.gpu && result.gpu.kind !== 'gpu') row.cells[3]!.title = result.gpu.message;
        const action = doc.createElement('td');
        if (result.model === modelSelect.value) {
          action.textContent = 'In use';
        } else {
          const use = doc.createElement('button');
          use.type = 'button';
          use.textContent = 'Use this model';
          use.addEventListener('click', () => void useModel(result.model));
          action.append(use);
        }
        row.append(action);
      } else {
        const why = cell(doc, result.status === 'failed' ? `Failed: ${result.message}` : 'Stopped');
        why.colSpan = 4;
        row.append(why);
      }
      return row;
    });
    speedTable.tBodies[0]!.replaceChildren(...rows);
    speedTable.hidden = rows.length === 0;
  }

  // Saves only the model, so other unsaved changes in the form stay unsaved,
  // then loads it the way the warm-up does (PR 8.3), since the test unloaded
  // every model but the one picked before.
  async function useModel(model: string): Promise<void> {
    let saved: Settings;
    try {
      saved = await deps.saveSettings({ model });
    } catch (error) {
      speedStatus.textContent = `Could not switch to ${model}: ${errorMessage(error)}`;
      return;
    }
    if (![...modelSelect.options].some((o) => o.value === model)) {
      modelSelect.append(new Option(model, model));
    }
    modelSelect.value = model;
    speedStatus.textContent = `Now using ${model}. Saved.`;
    showResults(lastResults);
    if (saved.keepAliveMinutes > 0) {
      try {
        await deps.createClient(saved).loadModel(model, {
          keepAliveMinutes: saved.keepAliveMinutes,
          contextTokens: saved.contextTokens > 0 ? saved.contextTokens : MIN_NUM_CTX,
        });
      } catch {
        // The first click loads it instead.
      }
    }
    await Promise.all([checkGpu(), checkThinking()]);
  }

  function summary(
    results: readonly SpeedResult[],
    stopped: boolean,
    picked: { model: string; thinks: boolean } | undefined,
  ): string {
    const ranked = rankResults(results);
    const fastest = ranked[0];
    if (stopped) return 'Stopped.';
    // Every model failed, often out of memory on a laptop: a small model may still fit.
    if (fastest?.status !== 'done')
      return `No model answered. See the table for why. ${smallModelSuggestion(results)}`;
    const time = `${(fastest.totalMs / 1000).toFixed(1)} s`;
    if (fastest.totalMs < LATENCY_GOAL_MS)
      return `Fastest under ${LATENCY_GOAL_SECONDS} seconds: ${fastest.model} (${time}).`;
    const reasoning = picked?.thinks
      ? ` ${picked.model}, the model picked above, is a reasoning model: even with thinking off ` +
        'it is bigger and slower than a small coding model.'
      : '';
    return (
      `No model answered in under ${LATENCY_GOAL_SECONDS} seconds; the fastest was ${fastest.model} at ${time}. ` +
      `${smallModelSuggestion(results)}${reasoning}`
    );
  }

  // Whether the model picked in the settings is a reasoning model, from what
  // the line under the model already looked up (PR 9.5); no extra request.
  function pickedModel(llmUrl: string, model: string): { model: string; thinks: boolean } {
    const thinks = thinkingKnown.get(`${llmUrl} ${model}`);
    return { model, thinks: Boolean(thinks) };
  }

  async function speedTest(): Promise<void> {
    if (speedRun) return;
    const values = validForm([
      'llmUrl',
      'temperature',
      'maxResponseTokens',
      'contextTokens',
      'keepAliveMinutes',
    ]);
    if (!values) {
      speedStatus.textContent = 'Fix the problems above, then try again.';
      return;
    }
    const run = new AbortController();
    speedRun = run;
    speedButton.disabled = true;
    stopButton.hidden = false;
    showResults([], false);
    speedStatus.textContent = 'Listing models…';
    try {
      const client = deps.createClient(values);
      let models: string[];
      try {
        models = speedTestModels(await client.listModels({ signal: run.signal }));
      } catch (error) {
        if (run.signal.aborted) {
          speedStatus.textContent = 'Stopped.';
        } else {
          showLlmError(speedStatus, 'Could not list models.', error, { url: values.llmUrl });
        }
        return;
      }
      if (models.length === 0) {
        speedStatus.replaceChildren(
          ...withCode(
            doc,
            `No models installed. Run \`ollama pull ${SMALL_CODING_MODEL}\`, then try again.`,
          ),
        );
        return;
      }
      const results = await runSpeedTest({
        client,
        models,
        current: values.model,
        temperature: values.temperature,
        maxResponseTokens: values.maxResponseTokens,
        keepAliveMinutes: values.keepAliveMinutes,
        contextTokens: values.contextTokens,
        signal: run.signal,
        now,
        onProgress: (sofar, next) => {
          showResults(sofar, false);
          if (next && !run.signal.aborted) {
            speedStatus.textContent = `Timing ${next} (${sofar.length + 1} of ${models.length})…`;
          }
        },
      });
      showResults(results, !run.signal.aborted);
      speedStatus.replaceChildren(
        ...withCode(
          doc,
          summary(results, run.signal.aborted, pickedModel(values.llmUrl, values.model)),
        ),
      );
    } finally {
      speedRun = null;
      speedButton.disabled = false;
      stopButton.hidden = true;
    }
    await checkGpu();
  }

  function stopSpeedTest(): void {
    speedRun?.abort();
  }

  // --- Start up ---

  temperatureInput.addEventListener('input', () => {
    temperatureValue.textContent = temperatureInput.value;
  });
  urlInput.addEventListener('change', () => void refreshModels());
  refreshButton.addEventListener('click', () => void refreshModels());
  testButton.addEventListener('click', () => void testConnection());
  modelSelect.addEventListener('change', () => {
    showResults(lastResults);
    showChatModelNote();
    void checkGpu();
    void checkThinking();
  });
  chatModelSelect.addEventListener('change', showChatModelNote);
  thinkInput.addEventListener('change', () => void checkThinking());
  speedButton.addEventListener('click', () => void speedTest());
  stopButton.addEventListener('click', stopSpeedTest);
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

  return {
    refreshModels,
    save,
    testConnection,
    checkGpu,
    checkThinking,
    speedTest,
    stopSpeedTest,
  };
}

/**
 * The line under the model (PR 9.5): whether `model` is a reasoning model
 * (`thinks`, null when it is not and undefined when Ollama does not say) and
 * whether it will think, from the `think` that requests will send.
 */
export function thinkingText(
  model: string,
  thinks: ThinkingSupport | null | undefined,
  letThink: boolean,
): string {
  if (thinks === undefined) {
    return `Ollama does not say whether ${model} is a reasoning model. Update Ollama to 0.9 or later so thinking can be turned off.`;
  }
  if (!thinks) return `${model} is not a reasoning model, so it answers without thinking.`;
  const think = thinkOption(thinks, letThink);
  if (letThink) return `${model} is a reasoning model. Thinking is on, so answers take longer.`;
  if (think === false)
    return `${model} is a reasoning model. Thinking is off, so it answers sooner.`;
  // Such as gpt-oss, which only takes "low", "medium" or "high" (PR 9.5).
  return typeof think === 'string'
    ? `${model} is a reasoning model that cannot turn thinking off, so it thinks as little as it can ("${think}").`
    : `${model} is a reasoning model that cannot turn thinking off.`;
}

/** The first choice under Chat model (PR 9.14): chat uses Model. */
export const SAME_AS_EXPLANATIONS = 'Same as explanations';

/**
 * The note under Chat model when chat has a model of its own (PR 9.14): two
 * models loaded at once need memory for both, and when Ollama holds only one,
 * every switch between explaining and chatting loads a model again.
 */
export function chatModelNoteText(model: string, chatModel: string): string {
  return (
    `Explanations use ${model} and chat uses ${chatModel}, so Ollama keeps both in memory ` +
    'and needs room for both. If it can hold only one (OLLAMA_MAX_LOADED_MODELS is 1, or there ' +
    'is too little memory), every switch between explaining and chatting loads a model again, ' +
    'which on a CPU can take 10 seconds or more.'
  );
}

/**
 * What to install when no model met the goal (PR 9.9): a small coding model by
 * name, with the command to get it, unless it was already timed.
 */
export function smallModelSuggestion(results: readonly SpeedResult[]): string {
  const timed = (name: string) => results.some((r) => isSameModel(r.model, name));
  if (!timed(SMALL_CODING_MODEL)) {
    return (
      `A small coding model is much faster: run \`ollama pull ${SMALL_CODING_MODEL}\` ` +
      `(or \`ollama pull ${TINY_CODING_MODEL}\` on a slow CPU), then run the Speed test again.`
    );
  }
  if (!timed(TINY_CODING_MODEL)) {
    return (
      `Try an even smaller one: run \`ollama pull ${TINY_CODING_MODEL}\`, then run the Speed test again. ` +
      'A model fully on the GPU would also be faster.'
    );
  }
  return 'A model fully on the GPU would be faster.';
}

function cell(doc: Document, text: string, className?: string): HTMLTableCellElement {
  const td = doc.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Splits text on backticks: odd pieces become <code>, the rest stays text.
function withCode(doc: Document, text: string): (string | HTMLElement)[] {
  return text.split('`').map((piece, i) => {
    if (i % 2 === 0) return piece;
    const code = doc.createElement('code');
    code.textContent = piece;
    return code;
  });
}

function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_REPLY_CHARS ? `${trimmed.slice(0, MAX_REPLY_CHARS)}…` : trimmed;
}
