import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addMeasurement, type Measurement } from '../src/llm/speedTest';
import { LlmError, type LlmClient, type ModelInfo } from '../src/llm/types';
import { initOptionsPage, TEST_PROMPT, type OptionsPageDeps } from '../src/options/optionsPage';
import {
  EXPLAIN_NOT_SET_NOTE,
  initShortcuts,
  NOT_SET,
  SHORTCUT_ROWS,
  SHORTCUTS_URL,
  type CommandInfo,
} from '../src/options/shortcuts';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SKIP_PATTERNS,
  SettingsValidationError,
  validateSettings,
  type Settings,
} from '../src/settings';

const html = readFileSync(resolve(import.meta.dirname, '../src/options.html'), 'utf8');

const SAVED: Settings = {
  llmUrl: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
  chatModel: '',
  chatOpensIn: 'sidepanel',
  temperature: 0.4,
  maxResponseTokens: 512,
  contextTokens: 0,
  keepAliveMinutes: 30,
  explainOnHover: false,
  hoverWaitMs: 300,
  explainAhead: 'off',
  requestsAtOnce: 1,
  backgroundOnBattery: 'pause',
  skipInBackground: DEFAULT_SETTINGS.skipInBackground,
  keepAnswersDays: 7,
  letModelThink: false,
  streamAnswers: false,
  showPrompt: false,
  debugWindow: false,
};

const MODELS: ModelInfo[] = [{ name: 'llama3.2:3b' }, { name: 'qwen2.5-coder:7b' }];

function fakeClient(overrides: Partial<LlmClient> = {}): LlmClient {
  return {
    listModels: vi.fn(async () => MODELS),
    modelContext: vi.fn(async () => ({})),
    loadedModels: vi.fn(async () => []),
    loadedContextTokens: vi.fn(async () => undefined),
    runningModels: vi.fn(async () => []),
    loadModel: vi.fn(async () => {}),
    chat: vi.fn(async (_messages, options) => ({ content: 'OK', model: options.model })),
    chatStream: vi.fn(),
    ...overrides,
  };
}

// Like the real saveSettings: rejects invalid fields, otherwise returns the
// stored settings.
function fakeDeps(client: LlmClient, saved: Settings = SAVED, kept: Measurement[] = []) {
  let stored = { ...saved };
  let measured = [...kept];
  const deps = {
    getSettings: vi.fn(async () => ({ ...stored })),
    saveSettings: vi.fn(async (update: Partial<Settings>) => {
      const next = { ...stored, ...update };
      const issues = validateSettings(next);
      if (issues.length > 0) throw new SettingsValidationError(issues);
      stored = next;
      return { ...stored };
    }),
    createClient: vi.fn<OptionsPageDeps['createClient']>(() => client),
    now: vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1250),
    clearSavedAnswers: vi.fn<OptionsPageDeps['clearSavedAnswers']>(async () => {}),
    clearRatings: vi.fn<OptionsPageDeps['clearRatings']>(async () => {}),
    loadMeasurements: vi.fn<OptionsPageDeps['loadMeasurements']>(async () => [...measured]),
    saveMeasurement: vi.fn<OptionsPageDeps['saveMeasurement']>(async (m) => {
      measured = addMeasurement(measured, m);
      return [...measured];
    }),
  } satisfies OptionsPageDeps;
  return deps;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string) => $(id).textContent ?? '';
const errorFor = (field: string) =>
  document.querySelector(`[data-error-for="${field}"]`)?.textContent ?? '';
const modelOptions = () =>
  [...$<HTMLSelectElement>('model').options].map((o) => [o.value, o.textContent]);

beforeEach(() => {
  document.documentElement.innerHTML = html;
});

describe('options page', () => {
  it('loads the saved settings into the form', async () => {
    await initOptionsPage(document, fakeDeps(fakeClient()));

    expect($<HTMLInputElement>('llmUrl').value).toBe('http://localhost:11434');
    expect($<HTMLSelectElement>('model').value).toBe('qwen2.5-coder:7b');
    expect($<HTMLInputElement>('temperature').value).toBe('0.4');
    expect(text('temperature-value')).toBe('0.4');
    expect($<HTMLInputElement>('maxResponseTokens').value).toBe('512');
    // Automatic shows as an empty box with a placeholder.
    expect($<HTMLInputElement>('contextTokens').value).toBe('');
    expect($<HTMLInputElement>('contextTokens').placeholder).toBe('Automatic');
    expect($<HTMLInputElement>('keepAliveMinutes').value).toBe('30');
    expect($<HTMLInputElement>('explainOnHover').checked).toBe(false);
    expect($<HTMLInputElement>('showPrompt').checked).toBe(false);
  });

  it('loads and saves Explain on hover (PR 8.7)', async () => {
    const deps = fakeDeps(fakeClient());
    await deps.saveSettings({ explainOnHover: true });
    const page = await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('explainOnHover').checked).toBe(true);

    $<HTMLInputElement>('explainOnHover').checked = false;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ explainOnHover: false });
    $<HTMLInputElement>('explainOnHover').checked = true;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ explainOnHover: true });
  });

  it('shows Explain on hover ticked and a 300 ms Hover wait for someone who never saved them (PR 11.2)', async () => {
    await initOptionsPage(document, fakeDeps(fakeClient(), { ...DEFAULT_SETTINGS }));
    expect($<HTMLInputElement>('explainOnHover').checked).toBe(true);
    expect($<HTMLInputElement>('hoverWaitMs').value).toBe('300');
    expect(document.querySelector('label[for="hoverWaitMs"]')!.textContent!.trim()).toBe(
      'Hover wait (ms)',
    );
    const input = $<HTMLInputElement>('hoverWaitMs');
    expect([input.min, input.max]).toEqual(['150', '2000']);
  });

  it('loads and saves Hover wait, and rejects values out of range (PR 11.2)', async () => {
    const deps = fakeDeps(fakeClient());
    await deps.saveSettings({ hoverWaitMs: 600 });
    const page = await initOptionsPage(document, deps);
    const input = $<HTMLInputElement>('hoverWaitMs');
    expect(input.value).toBe('600');

    input.value = '1000';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ hoverWaitMs: 1000 });

    for (const bad of ['100', '2500', '', '300.5']) {
      input.value = bad;
      await page.save();
      expect(errorFor('hoverWaitMs')).toBe('Hover wait must be a whole number from 150 to 2000.');
      expect(text('save-status')).toBe('Not saved. Fix the problems above.');
    }
    expect(await deps.getSettings()).toMatchObject({ hoverWaitMs: 1000 });
  });

  it('loads and saves Skip in background, the default patterns first (PR 11.4)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const box = $<HTMLTextAreaElement>('skipInBackground');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.value.split('\n')).toEqual([...DEFAULT_SKIP_PATTERNS]);
    expect(document.querySelector('label[for="skipInBackground"]')!.textContent!.trim()).toBe(
      'Skip in background',
    );
    const hint = box.closest('.field')!.querySelector('.hint')!.textContent!;
    expect(hint).toMatch(/linguist-generated/);
    expect(hint).toMatch(/clicking a line in one still explains it/i);

    // Remove the lockfiles and add a pattern (settings.test.ts checks that
    // saving drops spaces and blank lines).
    box.value = '*.min.js\ngenerated/\n!keep.min.js';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({
      skipInBackground: '*.min.js\ngenerated/\n!keep.min.js',
    });
    await initOptionsPage(document, deps);
    expect($<HTMLTextAreaElement>('skipInBackground').value).toBe(
      '*.min.js\ngenerated/\n!keep.min.js',
    );

    // Too long for chrome.storage.sync is refused.
    $<HTMLTextAreaElement>('skipInBackground').value = 'a'.repeat(4001);
    await page.save();
    expect(errorFor('skipInBackground')).toBe(
      'Skip in background must be at most 4000 characters.',
    );
  });

  it('loads and saves Background work on battery: Pause by default, or Keep going (PR 11.3)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const select = $<HTMLSelectElement>('backgroundOnBattery');
    expect(select.value).toBe('pause');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['pause', 'Pause'],
      ['keep', 'Keep going'],
    ]);
    expect(document.querySelector('label[for="backgroundOnBattery"]')!.textContent!.trim()).toBe(
      'Background work on battery',
    );
    const hint = select.closest('.field')!.querySelector('.hint')!.textContent!;
    expect(hint).toMatch(/clicks and chat questions always run/i);

    select.value = 'keep';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ backgroundOnBattery: 'keep' });
    await initOptionsPage(document, deps);
    expect($<HTMLSelectElement>('backgroundOnBattery').value).toBe('keep');

    $<HTMLSelectElement>('backgroundOnBattery').value = 'pause';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ backgroundOnBattery: 'pause' });
  });

  it('loads and saves Explain ahead: Off by default, Lines on screen or Whole PR (PR 10.6)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const select = $<HTMLSelectElement>('explainAhead');
    expect(select.value).toBe('off');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['off', 'Off'],
      ['screen', 'Lines on screen'],
      ['pr', 'Whole PR'],
    ]);
    expect(document.querySelector('label[for="explainAhead"]')!.textContent!.trim()).toBe(
      'Explain ahead',
    );
    const hint = select.closest('.field')!.querySelector('.hint')!.textContent!;
    expect(hint).toMatch(/at most 30 lines\s+per\s+page/i);
    expect(hint).toMatch(/at most 500 lines\s+per\s+PR/i);

    select.value = 'pr';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ explainAhead: 'pr' });
    await initOptionsPage(document, deps);
    expect($<HTMLSelectElement>('explainAhead').value).toBe('pr');

    $<HTMLSelectElement>('explainAhead').value = 'screen';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ explainAhead: 'screen' });
  });

  it('loads and saves Requests at once, 1 by default, and rejects other values (PR 10.6)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const input = $<HTMLInputElement>('requestsAtOnce');
    expect(input.value).toBe('1');
    expect([input.min, input.max, input.step]).toEqual(['1', '4', '1']);
    expect(input.closest('.field')!.querySelector('.hint')!.textContent).toMatch(
      /only helps when Ollama is\s+set to run several.*GPU/s,
    );

    input.value = '2';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ requestsAtOnce: 2 });
    await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('requestsAtOnce').value).toBe('2');

    for (const bad of ['5', '0', '1.5', '']) {
      $<HTMLInputElement>('requestsAtOnce').value = bad;
      await page.save();
      expect(text('save-status')).not.toBe('Saved.');
      expect(document.querySelector('[data-error-for="requestsAtOnce"]')!.textContent).toBe(
        'Requests at once must be a whole number from 1 to 4.',
      );
    }
    expect(await deps.getSettings()).toMatchObject({ requestsAtOnce: 2 });
  });

  it('loads and saves Keep answers for, 7 days by default, and rejects other values (PR 10.9)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const input = $<HTMLInputElement>('keepAnswersDays');
    expect(input.value).toBe('7');
    expect([input.min, input.max, input.step]).toEqual(['0', '365', '1']);
    expect(document.querySelector('label[for="keepAnswersDays"]')!.textContent!.trim()).toBe(
      'Keep answers for (days)',
    );
    const hint = input.closest('.field')!.querySelector('.hint')!.textContent!;
    expect(hint).toMatch(/after Chrome closes/);
    expect(hint).toMatch(/0 keeps them only until Chrome closes/);

    input.value = '0';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ keepAnswersDays: 0 });
    await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('keepAnswersDays').value).toBe('0');

    for (const bad of ['-1', '366', '2.5', '']) {
      $<HTMLInputElement>('keepAnswersDays').value = bad;
      await page.save();
      expect(text('save-status')).not.toBe('Saved.');
      expect(errorFor('keepAnswersDays')).toBe(
        'Keep answers for must be a whole number from 0 to 365.',
      );
    }
    expect(await deps.getSettings()).toMatchObject({ keepAnswersDays: 0 });
  });

  it('Clear saved answers asks the service worker to empty the caches and says so (PR 10.9)', async () => {
    const deps = fakeDeps(fakeClient());
    await initOptionsPage(document, deps);
    const button = $<HTMLButtonElement>('clear-answers');
    expect(button.textContent).toBe('Clear saved answers');
    expect(button.type).toBe('button');

    let finish!: () => void;
    deps.clearSavedAnswers.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    button.click();
    expect(button.disabled).toBe(true);
    expect(text('clear-status')).toBe('Clearing…');
    finish();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(deps.clearSavedAnswers).toHaveBeenCalledTimes(1);
    expect(text('clear-status')).toBe(
      'Saved answers cleared. The next click on a line asks the model.',
    );
    // It does not save the form.
    expect(deps.saveSettings).not.toHaveBeenCalled();

    deps.clearSavedAnswers.mockRejectedValueOnce(new Error('No answer from the extension.'));
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(text('clear-status')).toBe(
      'Could not clear saved answers: No answer from the extension.',
    );
  });

  it('Clear ratings asks the service worker to remove every rating and says so (PR 11.11)', async () => {
    const deps = fakeDeps(fakeClient());
    await initOptionsPage(document, deps);
    const button = $<HTMLButtonElement>('clear-ratings');
    expect(button.textContent).toBe('Clear ratings');
    expect(button.type).toBe('button');

    let finish!: () => void;
    deps.clearRatings.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    button.click();
    expect(button.disabled).toBe(true);
    expect(text('clear-ratings-status')).toBe('Clearing…');
    finish();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(deps.clearRatings).toHaveBeenCalledTimes(1);
    expect(text('clear-ratings-status')).toBe('Ratings cleared.');
    // Neither the form nor the saved answers are touched.
    expect(deps.saveSettings).not.toHaveBeenCalled();
    expect(deps.clearSavedAnswers).not.toHaveBeenCalled();

    deps.clearRatings.mockRejectedValueOnce(new Error('No answer from the extension.'));
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(text('clear-ratings-status')).toBe(
      'Could not clear ratings: No answer from the extension.',
    );
  });

  it('loads and saves Let the model think (PR 9.5)', async () => {
    const deps = fakeDeps(fakeClient());
    await deps.saveSettings({ letModelThink: true });
    const page = await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('letModelThink').checked).toBe(true);

    $<HTMLInputElement>('letModelThink').checked = false;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ letModelThink: false });
  });

  it('loads and saves Show answers as they are written, off by default (PR 9.6)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const box = $<HTMLInputElement>('streamAnswers');
    expect(box.checked).toBe(false);
    expect(box.closest('label')!.textContent!.trim()).toBe('Show answers as they are written');

    box.checked = true;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ streamAnswers: true });
    await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('streamAnswers').checked).toBe(true);
  });

  describe('reasoning model line (PR 9.5)', () => {
    const capabilities: Record<string, string[] | undefined> = {
      'deepseek-r1:7b': ['completion', 'thinking'],
      'qwen2.5-coder:7b': ['completion', 'insert'],
      'gpt-oss:20b': ['completion', 'thinking'],
      'old:1b': undefined,
    };
    const client = () =>
      fakeClient({
        listModels: vi.fn(async () => Object.keys(capabilities).map((name) => ({ name }))),
        modelContext: vi.fn(async (model: string) => {
          const found = capabilities[model];
          if (!found) return {};
          return model.startsWith('gpt-oss')
            ? { capabilities: found, thinkValues: ['low', 'medium', 'high'] }
            : { capabilities: found };
        }),
      });
    const pick = async (model: string) => {
      $<HTMLSelectElement>('model').value = model;
      $<HTMLSelectElement>('model').dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(text('thinking-status')).toContain(model));
    };

    it('says a reasoning model thinks only when the box is ticked', async () => {
      const llm = client();
      await initOptionsPage(document, fakeDeps(llm));
      await pick('deepseek-r1:7b');
      expect(text('thinking-status')).toBe(
        'deepseek-r1:7b is a reasoning model. Thinking is off, so it answers sooner.',
      );
      const box = $<HTMLInputElement>('letModelThink');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(text('thinking-status')).toContain('Thinking is on'));
      // Ticking the box does not ask the server again.
      expect(llm.modelContext).toHaveBeenCalledTimes(2);
    });

    it('says when a reasoning model cannot turn thinking off', async () => {
      await initOptionsPage(document, fakeDeps(client()));
      await pick('gpt-oss:20b');
      expect(text('thinking-status')).toBe(
        'gpt-oss:20b is a reasoning model that cannot turn thinking off, so it thinks as little as it can ("low").',
      );
    });

    it('says when a model is not a reasoning model, or Ollama does not say', async () => {
      await initOptionsPage(document, fakeDeps(client()));
      await vi.waitFor(() =>
        expect(text('thinking-status')).toBe(
          'qwen2.5-coder:7b is not a reasoning model, so it answers without thinking.',
        ),
      );
      await pick('old:1b');
      expect(text('thinking-status')).toContain('Update Ollama to 0.9 or later');
    });

    it('says nothing when the server cannot be asked', async () => {
      await initOptionsPage(
        document,
        fakeDeps(
          fakeClient({
            modelContext: vi.fn(async () => {
              throw new LlmError('connection', 'down');
            }),
          }),
        ),
      );
      expect(text('thinking-status')).toBe('');
    });
  });

  it('loads and saves how long to keep the model loaded (PR 8.3)', async () => {
    const deps = fakeDeps(fakeClient());
    await deps.saveSettings({ keepAliveMinutes: 90 });
    const page = await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('keepAliveMinutes').value).toBe('90');

    $<HTMLInputElement>('keepAliveMinutes').value = '0';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ keepAliveMinutes: 0 });
  });

  it.each(['', '-1', '1441', '2.5'])(
    'shows a bad keep-loaded time "%s" next to its box and does not save',
    async (value) => {
      const deps = fakeDeps(fakeClient());
      const page = await initOptionsPage(document, deps);
      $<HTMLInputElement>('keepAliveMinutes').value = value;
      await page.save();
      expect(errorFor('keepAliveMinutes')).toBe(
        'Keep model loaded must be a whole number from 0 to 1440.',
      );
      expect(text('save-status')).toBe('Not saved. Fix the problems above.');
      expect(await deps.getSettings()).toMatchObject({ keepAliveMinutes: 30 });
    },
  );

  it('loads and saves Debug window, in the Debug section with Show prompt (PR 9.3)', async () => {
    const deps = fakeDeps(fakeClient());
    let page = await initOptionsPage(document, deps);
    const box = $<HTMLInputElement>('debugWindow');
    expect(box.checked).toBe(false);
    const section = box.closest('fieldset');
    expect(section?.querySelector('legend')?.textContent).toBe('Debug');
    expect(section?.contains($('showPrompt'))).toBe(true);

    box.checked = true;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ debugWindow: true });

    // Opening the page again shows it ticked.
    document.documentElement.innerHTML = html;
    page = await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('debugWindow').checked).toBe(true);
    $<HTMLInputElement>('debugWindow').checked = false;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ debugWindow: false });
  });

  it('loads and saves a set context size and Show prompt (PR 6.2)', async () => {
    const deps = fakeDeps(fakeClient());
    await deps.saveSettings({ contextTokens: 8192, showPrompt: true });
    const page = await initOptionsPage(document, deps);
    expect($<HTMLInputElement>('contextTokens').value).toBe('8192');
    expect($<HTMLInputElement>('showPrompt').checked).toBe(true);

    $<HTMLInputElement>('contextTokens').value = '2048';
    $<HTMLInputElement>('showPrompt').checked = false;
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ contextTokens: 2048, showPrompt: false });

    // An empty box goes back to automatic.
    $<HTMLInputElement>('contextTokens').value = '';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ contextTokens: 0 });
  });

  it('shows a bad context size next to its box and does not save', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    $<HTMLInputElement>('contextTokens').value = '100';
    await page.save();
    expect(errorFor('contextTokens')).toContain('or 0 for automatic');
    expect(text('save-status')).toBe('Not saved. Fix the problems above.');
  });

  it('fills the model dropdown from the server', async () => {
    const deps = fakeDeps(fakeClient());
    await initOptionsPage(document, deps);

    expect(deps.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ llmUrl: 'http://localhost:11434' }),
    );
    expect(modelOptions()).toEqual([
      ['llama3.2:3b', 'llama3.2:3b'],
      ['qwen2.5-coder:7b', 'qwen2.5-coder:7b'],
    ]);
    expect(text('models-status')).toBe('2 models found.');
  });

  it('asks for a choice when no model is saved yet', async () => {
    await initOptionsPage(document, fakeDeps(fakeClient(), { ...DEFAULT_SETTINGS }));

    expect(modelOptions()[0]).toEqual(['', 'Choose a model']);
    expect($<HTMLSelectElement>('model').value).toBe('');
  });

  it('keeps a saved model the server does not have, marked as not installed', async () => {
    await initOptionsPage(document, fakeDeps(fakeClient(), { ...SAVED, model: 'gone:1b' }));

    expect(modelOptions()).toContainEqual(['gone:1b', 'gone:1b (not installed)']);
    expect($<HTMLSelectElement>('model').value).toBe('gone:1b');
  });

  it('loads and saves Chat opens in, Side panel by default (PR 11.8)', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);
    const select = $<HTMLSelectElement>('chatOpensIn');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['sidepanel', 'Side panel'],
      ['page', 'On the page'],
    ]);
    expect(select.value).toBe('sidepanel');
    select.value = 'page';
    await page.save();
    expect(await deps.getSettings()).toMatchObject({ chatOpensIn: 'page' });
    await initOptionsPage(document, deps);
    expect($<HTMLSelectElement>('chatOpensIn').value).toBe('page');
  });

  describe('Chat model (PR 9.14)', () => {
    const chatOptions = () =>
      [...$<HTMLSelectElement>('chatModel').options].map((o) => [o.value, o.textContent]);
    const note = () => $('chat-model-note');

    it('lists "Same as explanations" first, then the installed models', async () => {
      await initOptionsPage(document, fakeDeps(fakeClient()));
      expect(chatOptions()).toEqual([
        ['', 'Same as explanations'],
        ['llama3.2:3b', 'llama3.2:3b'],
        ['qwen2.5-coder:7b', 'qwen2.5-coder:7b'],
      ]);
      expect($<HTMLSelectElement>('chatModel').value).toBe('');
      expect(note().hidden).toBe(true);
    });

    it('loads and saves a Chat model, and goes back to "Same as explanations"', async () => {
      const deps = fakeDeps(fakeClient());
      const page = await initOptionsPage(document, deps);
      $<HTMLSelectElement>('chatModel').value = 'llama3.2:3b';
      await page.save();
      expect(await deps.getSettings()).toMatchObject({
        model: 'qwen2.5-coder:7b',
        chatModel: 'llama3.2:3b',
      });

      await initOptionsPage(document, deps);
      expect($<HTMLSelectElement>('chatModel').value).toBe('llama3.2:3b');
      $<HTMLSelectElement>('chatModel').value = '';
      await page.save();
      expect(await deps.getSettings()).toMatchObject({ chatModel: '' });
    });

    it('keeps a saved Chat model the server does not have, marked as not installed', async () => {
      await initOptionsPage(document, fakeDeps(fakeClient(), { ...SAVED, chatModel: 'gone:1b' }));
      expect(chatOptions()).toContainEqual(['gone:1b', 'gone:1b (not installed)']);
      expect($<HTMLSelectElement>('chatModel').value).toBe('gone:1b');
    });

    it('notes the memory two models need only while chat has a model of its own', async () => {
      await initOptionsPage(
        document,
        fakeDeps(fakeClient(), { ...SAVED, chatModel: 'llama3.2:3b' }),
      );
      expect(note().hidden).toBe(false);
      expect(note().textContent).toContain(
        'Explanations use qwen2.5-coder:7b and chat uses llama3.2:3b',
      );
      expect(note().textContent).toContain('OLLAMA_MAX_LOADED_MODELS');
      expect(note().textContent).toMatch(/10 seconds or more/);

      // Picking the same model as Model, or "Same as explanations", hides it.
      const model = $<HTMLSelectElement>('model');
      model.value = 'llama3.2:3b';
      model.dispatchEvent(new Event('change'));
      expect(note().hidden).toBe(true);
      model.value = 'qwen2.5-coder:7b';
      model.dispatchEvent(new Event('change'));
      expect(note().hidden).toBe(false);
      const chat = $<HTMLSelectElement>('chatModel');
      chat.value = '';
      chat.dispatchEvent(new Event('change'));
      expect(note().hidden).toBe(true);
      expect(note().textContent).toBe('');
    });
  });

  it('says how to get a model when none are installed', async () => {
    await initOptionsPage(document, fakeDeps(fakeClient({ listModels: async () => [] })));

    expect(text('models-status')).toContain('ollama pull');
  });

  it('shows the error when the models cannot be loaded, keeping the saved model', async () => {
    const listModels = async () => {
      throw new LlmError('connection', 'Could not connect to http://localhost:11434.');
    };
    await initOptionsPage(document, fakeDeps(fakeClient({ listModels })));

    expect(text('models-status')).toContain(
      'Could not load models. Ollama is not running at http://localhost:11434.',
    );
    expect($('models-status').querySelector('.fix code')?.textContent).toBe('ollama serve');
    expect(modelOptions()).toEqual([['qwen2.5-coder:7b', 'qwen2.5-coder:7b']]);
  });

  it('reloads the models from a new URL when the URL changes', async () => {
    const deps = fakeDeps(fakeClient());
    await initOptionsPage(document, deps);

    const url = $<HTMLInputElement>('llmUrl');
    url.value = 'http://127.0.0.1:8080/';
    url.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(deps.createClient).toHaveBeenLastCalledWith(
        expect.objectContaining({ llmUrl: 'http://127.0.0.1:8080' }),
      ),
    );
  });

  it('ignores an older model list that arrives after a newer one', async () => {
    let finishSlow: (models: ModelInfo[]) => void = () => {};
    const slow = new Promise<ModelInfo[]>((r) => (finishSlow = r));
    const listModels = vi
      .fn<() => Promise<ModelInfo[]>>()
      .mockResolvedValueOnce(MODELS)
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce([{ name: 'newest:1b' }]);
    const page = await initOptionsPage(document, fakeDeps(fakeClient({ listModels })));

    const older = page.refreshModels();
    await page.refreshModels();
    finishSlow([{ name: 'stale:1b' }]);
    await older;

    expect(modelOptions().map(([value]) => value)).toContain('newest:1b');
    expect(modelOptions().map(([value]) => value)).not.toContain('stale:1b');
  });

  it('ignores a pending model list once the URL is changed to an invalid one', async () => {
    let finishSlow: (models: ModelInfo[]) => void = () => {};
    const slow = new Promise<ModelInfo[]>((r) => (finishSlow = r));
    const listModels = vi
      .fn<() => Promise<ModelInfo[]>>()
      .mockResolvedValueOnce(MODELS)
      .mockReturnValueOnce(slow);
    const page = await initOptionsPage(document, fakeDeps(fakeClient({ listModels })));

    const pending = page.refreshModels();
    $<HTMLInputElement>('llmUrl').value = 'http://example.com';
    await page.refreshModels();
    finishSlow([{ name: 'stale:1b' }]);
    await pending;

    expect(text('models-status')).toBe('Fix the URL to load models.');
    expect(modelOptions().map(([value]) => value)).not.toContain('stale:1b');
  });

  it('shows a validation error for a bad URL and does not load models', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);

    $<HTMLInputElement>('llmUrl').value = 'http://example.com';
    await page.refreshModels();

    expect(errorFor('llmUrl')).toContain('must point to this computer');
    expect(text('models-status')).toBe('Fix the URL to load models.');
    // Only the first load, its GPU check and its thinking check.
    expect(deps.createClient).toHaveBeenCalledTimes(3);
  });

  it('saves the form and clears old errors', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);

    $<HTMLSelectElement>('model').value = 'llama3.2:3b';
    $<HTMLInputElement>('temperature').value = '1.5';
    $<HTMLInputElement>('maxResponseTokens').value = '2048';
    await page.save();

    expect(deps.saveSettings).toHaveBeenCalledWith({
      llmUrl: 'http://localhost:11434',
      model: 'llama3.2:3b',
      chatModel: '',
      chatOpensIn: 'sidepanel',
      temperature: 1.5,
      maxResponseTokens: 2048,
      contextTokens: 0,
      keepAliveMinutes: 30,
      explainOnHover: false,
      hoverWaitMs: 300,
      explainAhead: 'off',
      requestsAtOnce: 1,
      backgroundOnBattery: 'pause',
      skipInBackground: DEFAULT_SETTINGS.skipInBackground,
      keepAnswersDays: 7,
      letModelThink: false,
      streamAnswers: false,
      showPrompt: false,
      debugWindow: false,
    });
    expect(text('save-status')).toBe('Saved.');
    expect(await deps.getSettings()).toMatchObject({ model: 'llama3.2:3b' });
  });

  it('saves when the form is submitted with the Save button', async () => {
    const deps = fakeDeps(fakeClient());
    await initOptionsPage(document, deps);

    $<HTMLButtonElement>('save').click();

    await vi.waitFor(() => expect(text('save-status')).toBe('Saved.'));
    expect(deps.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('shows each invalid field and saves nothing', async () => {
    const deps = fakeDeps(fakeClient());
    const page = await initOptionsPage(document, deps);

    $<HTMLInputElement>('llmUrl').value = 'http://example.com';
    $<HTMLInputElement>('maxResponseTokens').value = '';
    await page.save();

    expect(errorFor('llmUrl')).toContain('must point to this computer');
    expect(errorFor('maxResponseTokens')).toContain('whole number');
    expect(errorFor('temperature')).toBe('');
    expect(text('save-status')).toBe('Not saved. Fix the problems above.');
    expect(await deps.getSettings()).toEqual(SAVED);
  });

  it('tests the connection with the form values and shows the reply and time', async () => {
    const client = fakeClient();
    const page = await initOptionsPage(document, fakeDeps(client));

    $<HTMLSelectElement>('model').value = 'llama3.2:3b';
    await page.testConnection();

    expect(client.chat).toHaveBeenCalledWith([{ role: 'user', content: TEST_PROMPT }], {
      model: 'llama3.2:3b',
      temperature: 0.4,
      maxResponseTokens: 32,
      keepAliveMinutes: 30,
    });
    expect(text('test-status')).toBe('Reply from llama3.2:3b in 250 ms: "OK"');
    expect($<HTMLButtonElement>('test-connection').disabled).toBe(false);
  });

  it('shows a friendly message and fix when the test fails', async () => {
    const chat = async () => {
      throw new LlmError('model-not-found', 'Model "qwen2.5-coder:7b" is not installed.');
    };
    const page = await initOptionsPage(document, fakeDeps(fakeClient({ chat })));

    await page.testConnection();

    expect(text('test-status')).toBe(
      'Test failed. The model "qwen2.5-coder:7b" is not installed. ' +
        'Run ollama pull qwen2.5-coder:7b, then click Refresh.',
    );
    expect($('test-status').querySelector('.fix code')?.textContent).toBe(
      'ollama pull qwen2.5-coder:7b',
    );
  });

  it('uses the platform for the OLLAMA_ORIGINS fix', async () => {
    const chat = async () => {
      throw new LlmError('origin-blocked', 'The server refused this extension (Forbidden).');
    };
    const deps = { ...fakeDeps(fakeClient({ chat })), platform: 'windows' as const };
    const page = await initOptionsPage(document, deps);

    await page.testConnection();

    expect(text('test-status')).toContain('Ollama blocked the request from this extension.');
    expect($('test-status').querySelector('.fix code')?.textContent).toBe(
      'setx OLLAMA_ORIGINS "chrome-extension://*"',
    );
  });

  it('asks for a model before testing', async () => {
    const client = fakeClient();
    const page = await initOptionsPage(document, fakeDeps(client, { ...DEFAULT_SETTINGS }));

    await page.testConnection();

    expect(text('test-status')).toBe('Choose a model first.');
    expect(client.chat).not.toHaveBeenCalled();
  });
});

describe('options page privacy note (PR 7.4)', () => {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  it('says code stays on this computer and links to PRIVACY.md', () => {
    const section = doc.querySelector<HTMLElement>('#privacy')!;
    expect(section.getAttribute('aria-labelledby')).toBe('privacy-title');
    expect(section.textContent).toContain('Your code stays on this computer');
    expect(section.textContent).toContain('sends nothing anywhere else');
    const link = section.querySelector<HTMLAnchorElement>('a')!;
    expect(link.getAttribute('href')).toMatch(/\/PRIVACY\.md$/);
    // Opens in a new tab without giving that page access to this one.
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });

  it('is outside the form, so it is not a setting', () => {
    expect(doc.querySelector('#settings-form #privacy')).toBeNull();
  });
});

describe('options page Speed section (PR 8.6)', () => {
  const GB = 1_000_000_000;
  const rows = () =>
    [...$<HTMLTableElement>('speed-results').tBodies[0]!.rows].map((r) =>
      [...r.cells].map((c) => c.textContent),
    );

  // Each model answers after `ms` on the page's clock.
  function timedClient(times: Record<string, number>, overrides: Partial<LlmClient> = {}) {
    let t = 0;
    const client = fakeClient({
      listModels: vi.fn(async () => Object.keys(times).map((name) => ({ name }))),
      chat: vi.fn(async (_messages, options) => {
        t += times[options.model]!;
        return {
          content: 'ok',
          model: options.model,
          timings: { answerTokens: 100, answerMs: 2000 },
        };
      }),
      ...overrides,
    });
    return { client, now: () => t };
  }

  it('says the picked model runs fully on the GPU', async () => {
    const client = fakeClient({
      runningModels: vi.fn(async () => [
        { name: 'qwen2.5-coder:7b', sizeBytes: 5 * GB, vramBytes: 5 * GB },
      ]),
    });
    await initOptionsPage(document, fakeDeps(client));
    expect(text('gpu-status')).toBe('Runs on: 100% GPU. qwen2.5-coder:7b runs fully on the GPU.');
    expect($('gpu-status').className).toBe('gpu-ok');
  });

  it('warns when the picked model is partly on the CPU, with a fix', async () => {
    const client = fakeClient({
      runningModels: vi.fn(async () => [
        { name: 'qwen2.5-coder:7b', sizeBytes: 6 * GB, vramBytes: 3 * GB },
      ]),
    });
    await initOptionsPage(document, fakeDeps(client));
    expect(text('gpu-status')).toContain('Runs on: 50%/50% CPU/GPU.');
    expect($('gpu-status').className).toBe('gpu-warn');
    expect($('gpu-status').querySelector('.fix code')?.textContent).toBe('q4_K_M');
  });

  it('says when the picked model is not loaded, and checks again when the model changes', async () => {
    const runningModels = vi.fn(async () => [
      { name: 'llama3.2:3b', sizeBytes: 2 * GB, vramBytes: 0 },
    ]);
    await initOptionsPage(document, fakeDeps(fakeClient({ runningModels })));
    expect(text('gpu-status')).toContain('qwen2.5-coder:7b is not loaded right now');

    $<HTMLSelectElement>('model').value = 'llama3.2:3b';
    $('model').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(text('gpu-status')).toContain('Runs on: 100% CPU.'));
  });

  it('shows nothing about the GPU when Ollama cannot be reached', async () => {
    const client = fakeClient({
      runningModels: vi.fn(async () => {
        throw new LlmError('connection', 'down');
      }),
    });
    await initOptionsPage(document, fakeDeps(client));
    expect(text('gpu-status')).toBe('');
  });

  it('times each coding model, fastest first, and marks the fastest under 2 s', async () => {
    const { client, now } = timedClient({
      'qwen2.5-coder:7b': 14_000,
      'qwen2.5-coder:3b': 1_500,
      'llama3.2:3b': 1_000,
    });
    const deps = { ...fakeDeps(client), now };
    const page = await initOptionsPage(document, deps);
    expect($('speed-results').hidden).toBe(true);

    await page.speedTest();

    // llama3.2 is not a coding model, so it is not timed.
    expect(rows()).toEqual([
      ['qwen2.5-coder:3bFastest under 2 s', '1.5 s', '50.0', '–', 'Use this model'],
      ['qwen2.5-coder:7b', '14.0 s', '50.0', '–', 'In use'],
    ]);
    expect($('speed-results').hidden).toBe(false);
    expect($('speed-results').querySelector('tr.pick')?.textContent).toContain('qwen2.5-coder:3b');
    expect(text('speed-status')).toBe('Fastest under 2 seconds: qwen2.5-coder:3b (1.5 s).');
  });

  it('switches and saves the model with Use this model', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 14_000, 'qwen2.5-coder:3b': 4_200 });
    const deps = { ...fakeDeps(client), now };
    const page = await initOptionsPage(document, deps);
    await page.speedTest();
    // An unsaved change elsewhere in the form is not saved with it.
    $<HTMLInputElement>('maxResponseTokens').value = '999';

    $('speed-results').querySelector<HTMLButtonElement>('button')!.click();

    await vi.waitFor(() => expect(text('speed-status')).toBe('Now using qwen2.5-coder:3b. Saved.'));
    expect(deps.saveSettings).toHaveBeenCalledWith({ model: 'qwen2.5-coder:3b' });
    expect(await deps.getSettings()).toMatchObject({
      model: 'qwen2.5-coder:3b',
      maxResponseTokens: 512,
    });
    expect($<HTMLSelectElement>('model').value).toBe('qwen2.5-coder:3b');
    expect(rows().map((r) => r[4])).toEqual(['In use', 'Use this model']);
    // Loaded again (the test unloaded it), the way the warm-up loads a model.
    await vi.waitFor(() =>
      expect(client.loadModel).toHaveBeenLastCalledWith('qwen2.5-coder:3b', {
        keepAliveMinutes: 30,
        contextTokens: 2048,
      }),
    );
  });

  it('runs the test with the Context size in the form (automatic is 2048)', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 1_000 });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(client.chat).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ contextTokens: 2048 }),
    );

    $<HTMLInputElement>('contextTokens').value = '8192';
    await page.speedTest();
    expect(client.loadModel).toHaveBeenLastCalledWith(
      'qwen2.5-coder:7b',
      expect.objectContaining({ contextTokens: 8192 }),
    );
    expect(client.chat).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ contextTokens: 8192 }),
    );
  });

  it('does not run with a bad Context size', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 1_000 });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    $<HTMLInputElement>('contextTokens').value = '100';
    await page.speedTest();
    expect(errorFor('contextTokens')).not.toBe('');
    expect(text('speed-status')).toBe('Fix the problems above, then try again.');
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('says so when no model answers in under 2 seconds, and suggests a small model', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 2_000 });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect($('speed-results').querySelector('.badge')).toBeNull();
    expect(text('speed-status')).toBe(
      'No model answered in under 2 seconds; the fastest was qwen2.5-coder:7b at 2.0 s. ' +
        'A small coding model is much faster: run ollama pull qwen2.5-coder:1.5b ' +
        '(or ollama pull qwen2.5-coder:0.5b on a slow CPU), then run the Speed test again.',
    );
    expect([...$('speed-status').querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'ollama pull qwen2.5-coder:1.5b',
      'ollama pull qwen2.5-coder:0.5b',
    ]);
  });

  it('suggests a small model when every model fails, keeping the reasons in the table', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 1, 'codellama:7b': 1 });
    vi.mocked(client.loadModel).mockRejectedValue(new LlmError('http', 'out of memory'));
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(rows().map((r) => r[1])).toEqual(['Failed: out of memory', 'Failed: out of memory']);
    expect(text('speed-status')).toBe(
      'No model answered. See the table for why. ' +
        'A small coding model is much faster: run ollama pull qwen2.5-coder:1.5b ' +
        '(or ollama pull qwen2.5-coder:0.5b on a slow CPU), then run the Speed test again.',
    );
    expect([...$('speed-status').querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'ollama pull qwen2.5-coder:1.5b',
      'ollama pull qwen2.5-coder:0.5b',
    ]);
  });

  it('suggests the GPU when every model fails and both small models were tried', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:1.5b': 1, 'qwen2.5-coder:0.5b': 1 });
    vi.mocked(client.loadModel).mockRejectedValue(new LlmError('http', 'out of memory'));
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(text('speed-status')).toBe(
      'No model answered. See the table for why. A model fully on the GPU would be faster.',
    );
  });

  it('suggests only the smaller model once the small one has been timed', async () => {
    const { client, now } = timedClient({
      'qwen2.5-coder:7b': 14_000,
      'qwen2.5-coder:1.5b': 2_500,
    });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(text('speed-status')).toContain(
      'the fastest was qwen2.5-coder:1.5b at 2.5 s. Try an even smaller one: ' +
        'run ollama pull qwen2.5-coder:0.5b, then run the Speed test again.',
    );
    expect([...$('speed-status').querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'ollama pull qwen2.5-coder:0.5b',
    ]);
  });

  it('suggests the GPU once both small models have been timed', async () => {
    const { client, now } = timedClient({
      'qwen2.5-coder:1.5b': 2_500,
      'qwen2.5-coder:0.5b': 2_100,
    });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(text('speed-status')).toBe(
      'No model answered in under 2 seconds; the fastest was qwen2.5-coder:0.5b at 2.1 s. ' +
        'A model fully on the GPU would be faster.',
    );
    expect($('speed-status').querySelector('code')).toBeNull();
  });

  it('says when the picked model is a reasoning model and none made 2 seconds', async () => {
    const { client, now } = timedClient(
      { 'deepseek-r1:7b': 9_000, 'qwen2.5-coder:7b': 6_000 },
      {
        modelContext: vi.fn(async (model: string) =>
          model.startsWith('deepseek-r1') ? { capabilities: ['completion', 'thinking'] } : {},
        ),
      },
    );
    const page = await initOptionsPage(document, {
      ...fakeDeps(client, { ...SAVED, model: 'deepseek-r1:7b' }),
      now,
    });
    await vi.waitFor(() => expect(text('thinking-status')).toContain('is a reasoning model'));
    await page.speedTest();
    expect(text('speed-status')).toContain(
      'deepseek-r1:7b, the model picked above, is a reasoning model: even with thinking off ' +
        'it is bigger and slower than a small coding model.',
    );
  });

  it('does not call a model that is not a reasoning model one', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 6_000 });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(text('speed-status')).not.toContain('reasoning');
  });

  it('shows where each model ran and why a model failed', async () => {
    const { client, now } = timedClient(
      { 'qwen2.5-coder:7b': 1_200, 'codellama:7b': 1 },
      {
        runningModels: vi.fn(async () => [
          { name: 'qwen2.5-coder:7b', sizeBytes: 6 * GB, vramBytes: 3 * GB },
        ]),
      },
    );
    vi.mocked(client.loadModel).mockImplementation(async (model) => {
      if (model === 'codellama:7b') throw new LlmError('http', 'out of memory');
    });
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });
    await page.speedTest();
    expect(rows()).toEqual([
      ['qwen2.5-coder:7bFastest under 2 s', '1.2 s', '50.0', '50%/50% CPU/GPU', 'In use'],
      ['codellama:7b', 'Failed: out of memory'],
    ]);
  });

  it('stops the test with the Stop button, marking no model as fastest', async () => {
    const { client, now } = timedClient({ 'qwen2.5-coder:7b': 1, 'qwen2.5-coder:3b': 1 });
    let started: () => void = () => {};
    const waiting = new Promise<void>((r) => (started = r));
    // The 3b model answers; the 7b one (the picked model, so timed last) hangs.
    vi.mocked(client.chat).mockImplementation((_messages, options) =>
      options.model === 'qwen2.5-coder:3b'
        ? Promise.resolve({ content: 'ok', model: options.model })
        : new Promise((_resolve, reject) => {
            started();
            options.signal?.addEventListener('abort', () =>
              reject(new LlmError('aborted', 'cancelled')),
            );
          }),
    );
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });

    const running = page.speedTest();
    await waiting;
    expect($<HTMLButtonElement>('speed-test').disabled).toBe(true);
    expect($('speed-stop').hidden).toBe(false);
    expect(text('speed-status')).toBe('Timing qwen2.5-coder:7b (2 of 2)…');
    // Not marked while the test is still running.
    expect(rows()).toEqual([['qwen2.5-coder:3b', '0.0 s', '–', '–', 'Use this model']]);
    $('speed-stop').click();
    await running;

    expect(text('speed-status')).toBe('Stopped.');
    expect(rows()).toEqual([
      ['qwen2.5-coder:3b', '0.0 s', '–', '–', 'Use this model'],
      ['qwen2.5-coder:7b', 'Stopped'],
    ]);
    expect($('speed-results').querySelector('.badge')).toBeNull();
    expect($<HTMLButtonElement>('speed-test').disabled).toBe(false);
    expect($('speed-stop').hidden).toBe(true);
  });

  it('says how to get a model when none is installed', async () => {
    const client = fakeClient({ listModels: vi.fn(async () => []) });
    const page = await initOptionsPage(document, fakeDeps(client));
    await page.speedTest();
    expect(text('speed-status')).toBe(
      'No models installed. Run ollama pull qwen2.5-coder:1.5b, then try again.',
    );
    expect($('speed-status').querySelector('code')?.textContent).toBe(
      'ollama pull qwen2.5-coder:1.5b',
    );
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('explains a server that is down', async () => {
    const client = fakeClient();
    const page = await initOptionsPage(document, fakeDeps(client));
    vi.mocked(client.listModels).mockRejectedValue(new LlmError('connection', 'down'));
    await page.speedTest();
    expect(text('speed-status')).toContain('Could not list models.');
    expect(client.chat).not.toHaveBeenCalled();
  });
});

describe('options page Make Ollama faster (PR 11.7)', () => {
  const rows = () =>
    [...$<HTMLTableElement>('measure-results').tBodies[0]!.rows].map((r) =>
      [...r.cells].map((c) => c.textContent),
    );
  const commands = () =>
    [...document.querySelectorAll('#faster-tips pre')].map((c) => c.textContent);

  // The picked model answers after each of `times` in turn, on the page's clock.
  function timedClient(times: number[], overrides: Partial<LlmClient> = {}) {
    let t = 0;
    const client = fakeClient({
      chat: vi.fn(async (_messages, options) => {
        t += times.shift()!;
        return {
          content: 'ok',
          model: options.model,
          timings: { answerTokens: 100, answerMs: 2000 },
        };
      }),
      ...overrides,
    });
    return { client, now: () => t };
  }

  it('lists each setting with what it does and the Command Prompt line on Windows', async () => {
    await initOptionsPage(document, { ...fakeDeps(fakeClient()), platform: 'windows' });

    expect(text('faster-title')).toBe('Make Ollama faster');
    expect(text('faster-shell')).toBe('In Command Prompt, run:');
    expect(commands()).toEqual(['setx OLLAMA_FLASH_ATTENTION 1', 'setx OLLAMA_KV_CACHE_TYPE q8_0']);
    const tips = [...document.querySelectorAll('#faster-tips li')].map((li) => li.textContent);
    expect(tips[0]).toContain('flash attention');
    expect(tips[1]).toContain('Works only with OLLAMA_FLASH_ATTENTION set to 1');
    expect(text('faster-restart')).toContain('quit Ollama from its icon in the system tray');
  });

  it('gives the commands for macOS and Linux', async () => {
    await initOptionsPage(document, { ...fakeDeps(fakeClient()), platform: 'mac' });
    expect(commands()[0]).toBe('launchctl setenv OLLAMA_FLASH_ATTENTION 1');
    expect(text('faster-restart')).toContain('menu bar');

    document.documentElement.innerHTML = html;
    await initOptionsPage(document, fakeDeps(fakeClient()));
    expect(text('faster-shell')).toContain('sudo systemctl edit ollama.service');
    expect(commands()[1]).toBe('Environment="OLLAMA_KV_CACHE_TYPE=q8_0"');
    expect($('faster-restart').querySelector('code')?.textContent).toBe(
      'sudo systemctl restart ollama',
    );
  });

  it('is outside the form, so it is not a setting', () => {
    expect($('settings-form').contains($('faster'))).toBe(false);
  });

  it('times only the picked model with Measure, saves the result and shows it', async () => {
    const { client, now } = timedClient([3_200]);
    const deps = { ...fakeDeps(client), now, clock: () => Date.UTC(2026, 10, 5, 14, 3) };
    const page = await initOptionsPage(document, deps);
    expect($('measure-results').hidden).toBe(true);

    await page.measure();

    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.chat).mock.calls[0]![1].model).toBe('qwen2.5-coder:7b');
    // The picked model stays loaded, as it does after the Speed test.
    expect(vi.mocked(client.chat).mock.calls[0]![1].keepAliveMinutes).toBe(30);
    expect(deps.saveMeasurement).toHaveBeenCalledWith({
      model: 'qwen2.5-coder:7b',
      totalMs: 3_200,
      tokensPerSecond: 50,
      at: Date.UTC(2026, 10, 5, 14, 3),
    });
    expect(text('measure-status')).toBe('Measured qwen2.5-coder:7b. Saved.');
    expect($('measure-results').hidden).toBe(false);
    const [row] = rows();
    expect(row![0]).toBe('Measured');
    expect(row!.slice(2)).toEqual(['3.2 s', '50.0', '–']);
    expect(text('measure-compare')).toBe('');
  });

  it('shows the second result next to the previous one, with how much faster it is', async () => {
    const { client, now } = timedClient([3_200, 2_400]);
    const page = await initOptionsPage(document, { ...fakeDeps(client), now });

    await page.measure();
    await page.measure();

    expect(rows().map((r) => [r[0], r[2]])).toEqual([
      ['Before', '3.2 s'],
      ['Latest', '2.4 s'],
    ]);
    expect(text('measure-compare')).toBe('0.8 s faster than before (25% less time).');
    expect($('measure-compare').className).toBe('faster');
  });

  it('shows the saved results when the page opens, and those of the model picked', async () => {
    const kept: Measurement[] = [
      { model: 'qwen2.5-coder:7b', totalMs: 4_000, at: 1 },
      { model: 'qwen2.5-coder:7b', totalMs: 5_000, at: 2, processor: '100% CPU' },
      { model: 'llama3.2:3b', totalMs: 1_000, at: 3 },
    ];
    await initOptionsPage(document, fakeDeps(fakeClient(), SAVED, kept));
    expect(rows().map((r) => [r[0], r[2], r[4]])).toEqual([
      ['Before', '4.0 s', '–'],
      ['Latest', '5.0 s', '100% CPU'],
    ]);
    expect(text('measure-compare')).toBe('1.0 s slower than before (25% more time).');

    $<HTMLSelectElement>('model').value = 'llama3.2:3b';
    $('model').dispatchEvent(new Event('change'));
    expect(rows().map((r) => [r[0], r[2]])).toEqual([['Measured', '1.0 s']]);
    expect(text('measure-compare')).toBe('');
  });

  it('shows the results of the model picked with Use this model (review on #76)', async () => {
    const kept: Measurement[] = [
      { model: 'qwen2.5-coder:7b', totalMs: 9_000, at: 1 },
      { model: 'qwen2.5-coder:7b', totalMs: 8_000, at: 2 },
      { model: 'qwen2.5-coder:3b', totalMs: 3_000, at: 3 },
    ];
    let t = 0;
    const times: Record<string, number> = { 'qwen2.5-coder:7b': 8_000, 'qwen2.5-coder:3b': 3_000 };
    const client = fakeClient({
      listModels: vi.fn(async () => Object.keys(times).map((name) => ({ name }))),
      chat: vi.fn(async (_messages, options) => {
        t += times[options.model]!;
        return { content: 'ok', model: options.model };
      }),
    });
    const page = await initOptionsPage(document, {
      ...fakeDeps(client, SAVED, kept),
      now: () => t,
    });
    expect(rows().map((r) => r[0])).toEqual(['Before', 'Latest']);
    await page.speedTest();

    [...$('speed-results').querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Use this model')!
      .click();

    await vi.waitFor(() => expect($<HTMLSelectElement>('model').value).toBe('qwen2.5-coder:3b'));
    expect(rows().map((r) => [r[0], r[2]])).toEqual([['Measured', '3.0 s']]);
    expect(text('measure-compare')).toBe('');
  });

  it('saves nothing when the model fails, and says why', async () => {
    const chat = vi.fn(async () => {
      throw new LlmError('http', 'model requires more system memory');
    });
    const deps = fakeDeps(fakeClient({ chat }));
    const page = await initOptionsPage(document, deps);

    await page.measure();

    expect(deps.saveMeasurement).not.toHaveBeenCalled();
    expect(text('measure-status')).toBe(
      'Could not time qwen2.5-coder:7b: model requires more system memory',
    );
    expect($('measure-results').hidden).toBe(true);
  });

  it('asks for a model before measuring', async () => {
    const client = fakeClient();
    const page = await initOptionsPage(document, fakeDeps(client, { ...SAVED, model: '' }));
    await page.measure();
    expect(text('measure-status')).toBe('Choose a model first.');
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('shows the result even when saving it fails', async () => {
    const { client, now } = timedClient([3_000]);
    const deps = {
      ...fakeDeps(client),
      now,
      saveMeasurement: vi.fn(async () => {
        throw new Error('quota');
      }),
    };
    const page = await initOptionsPage(document, deps);
    await page.measure();
    expect(text('measure-status')).toBe('Measured qwen2.5-coder:7b, but could not save it: quota');
    expect(rows()).toHaveLength(1);
  });

  it('does not measure while the Speed test runs', async () => {
    let finish!: () => void;
    const chat = vi.fn(
      (_messages: unknown, options: { model: string }) =>
        new Promise<{ content: string; model: string }>((resolve) => {
          finish = () => resolve({ content: 'ok', model: options.model });
        }),
    );
    const client = fakeClient({
      listModels: vi.fn(async () => [{ name: 'qwen2.5-coder:7b' }]),
      chat,
    });
    const page = await initOptionsPage(document, fakeDeps(client));

    const running = page.speedTest();
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect($<HTMLButtonElement>('measure').disabled).toBe(true);
    await page.measure();
    expect(chat).toHaveBeenCalledTimes(1);

    finish();
    await running;
    expect($<HTMLButtonElement>('measure').disabled).toBe(false);
  });
});

describe('Keyboard shortcuts (PR 11.9)', () => {
  const flush = () => new Promise((done) => setTimeout(done, 0));
  beforeEach(() => {
    document.documentElement.innerHTML = html;
  });

  function setup(commands: CommandInfo[] | (() => Promise<CommandInfo[]>)) {
    const deps = {
      getAll: vi.fn(typeof commands === 'function' ? commands : async () => commands),
      openTab: vi.fn(async () => {}),
    };
    const shortcuts = initShortcuts(document, deps);
    const keyOf = (name: string) =>
      document.querySelector<HTMLElement>(`#shortcut-list dd[data-command="${name}"]`)!;
    return { deps, shortcuts, keyOf };
  }

  it('shows the key of each command, and Not set for one with none', async () => {
    const { keyOf } = setup([
      { name: 'explain', description: 'Explain', shortcut: 'Alt+E' },
      { name: 'open-chat', description: 'Open chat', shortcut: '' },
    ]);
    await flush();
    const terms = [...document.querySelectorAll('#shortcut-list dt')].map((dt) => dt.textContent);
    expect(terms).toEqual(SHORTCUT_ROWS.map((row) => row.label));
    expect(keyOf('explain').querySelector('kbd')!.textContent).toBe('Alt+E');
    expect(keyOf('open-chat').textContent).toBe(NOT_SET);
    expect(document.getElementById('shortcut-note')!.hidden).toBe(true);
  });

  it('says how to set Explain when Chrome could not give it Ctrl+Shift+E', async () => {
    setup([{ name: 'explain', shortcut: '' }, { name: 'open-chat' }]);
    await flush();
    const note = document.getElementById('shortcut-note')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(EXPLAIN_NOT_SET_NOTE);
    expect(note.textContent).toContain('Alt+E');
  });

  it('opens Chrome’s shortcuts page from Change shortcuts', () => {
    const { deps } = setup([]);
    document.getElementById('change-shortcuts')!.click();
    expect(deps.openTab).toHaveBeenCalledWith(SHORTCUTS_URL);
    expect(SHORTCUTS_URL).toBe('chrome://extensions/shortcuts');
  });

  it('reads the keys again when the page comes back into view', async () => {
    let key = 'Alt+E';
    const { keyOf, deps } = setup(async () => [{ name: 'explain', shortcut: key }]);
    await flush();
    key = 'Ctrl+Shift+Y';
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(deps.getAll).toHaveBeenCalledTimes(2);
    expect(keyOf('explain').textContent).toBe('Ctrl+Shift+Y');
  });

  it('shows Unknown, and no note, when Chrome does not answer', async () => {
    const { keyOf } = setup(async () => Promise.reject(new Error('no commands')));
    await flush();
    expect(keyOf('explain').textContent).toBe('Unknown');
    expect(document.getElementById('shortcut-note')!.hidden).toBe(true);
  });

  it('mentions the right-click menu item', () => {
    expect(document.getElementById('shortcuts')!.textContent).toContain(
      'Explain with PR Explainer',
    );
  });
});
