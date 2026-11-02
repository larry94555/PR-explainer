import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LlmError, type LlmClient, type ModelInfo } from '../src/llm/types';
import { initOptionsPage, TEST_PROMPT, type OptionsPageDeps } from '../src/options/optionsPage';
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  validateSettings,
  type Settings,
} from '../src/settings';

const html = readFileSync(resolve(import.meta.dirname, '../src/options.html'), 'utf8');

const SAVED: Settings = {
  llmUrl: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
  temperature: 0.4,
  maxResponseTokens: 512,
  contextTokens: 0,
  keepAliveMinutes: 30,
  showPrompt: false,
};

const MODELS: ModelInfo[] = [{ name: 'llama3.2:3b' }, { name: 'qwen2.5-coder:7b' }];

function fakeClient(overrides: Partial<LlmClient> = {}): LlmClient {
  return {
    listModels: vi.fn(async () => MODELS),
    modelContext: vi.fn(async () => ({})),
    loadedModels: vi.fn(async () => []),
    loadedContextTokens: vi.fn(async () => undefined),
    loadModel: vi.fn(async () => {}),
    chat: vi.fn(async (_messages, options) => ({ content: 'OK', model: options.model })),
    chatStream: vi.fn(),
    ...overrides,
  };
}

// Like the real saveSettings: rejects invalid fields, otherwise returns the
// stored settings.
function fakeDeps(client: LlmClient, saved: Settings = SAVED) {
  let stored = { ...saved };
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
    expect($<HTMLInputElement>('showPrompt').checked).toBe(false);
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
    await vi.waitFor(() => expect(deps.createClient).toHaveBeenCalledTimes(2));

    expect(deps.createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ llmUrl: 'http://127.0.0.1:8080' }),
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
    expect(deps.createClient).toHaveBeenCalledTimes(1); // only the first load
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
      temperature: 1.5,
      maxResponseTokens: 2048,
      contextTokens: 0,
      keepAliveMinutes: 30,
      showPrompt: false,
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
