import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  storageKey,
  SettingsValidationError,
  validateSettings,
  type Settings,
  type StorageAreaLike,
} from '../src/settings';

// An in-memory stand-in for chrome.storage.sync. Like Chrome, it copies values
// in and out (structured clone), so tests can't share objects with it.
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  const storage: StorageAreaLike & { data: Record<string, unknown> } = {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
  };
  return storage;
}

async function expectRejectedFields(
  promise: Promise<unknown>,
  fields: (keyof Settings)[],
): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SettingsValidationError);
  expect((error as SettingsValidationError).issues.map((i) => i.field)).toEqual(fields);
}

describe('settings', () => {
  describe('defaults', () => {
    it('uses the Ollama default URL, no model, temperature 0.2', () => {
      expect(DEFAULT_SETTINGS).toEqual({
        llmUrl: 'http://localhost:11434',
        model: '',
        temperature: 0.2,
        maxResponseTokens: 1024,
      });
      expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
    });

    it('returns the defaults on first run and stores nothing', async () => {
      const storage = fakeStorage();
      await expect(getSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
      expect(storage.set).not.toHaveBeenCalled();
      expect(storage.data).toEqual({});
    });

    it('cannot be changed by editing a returned object', async () => {
      const storage = fakeStorage();
      const first = await getSettings(storage);
      first.model = 'changed';
      await expect(getSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
      expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    });
  });

  describe('saving and reloading', () => {
    it('saves values and reads them back', async () => {
      const storage = fakeStorage();
      const update = {
        llmUrl: 'http://127.0.0.1:8080',
        model: 'qwen2.5-coder:7b',
        temperature: 0.7,
        maxResponseTokens: 2048,
      };
      await expect(saveSettings(update, storage)).resolves.toEqual(update);
      await expect(getSettings(storage)).resolves.toEqual(update);
    });

    it('stores only the fields the user saved, one key per field', async () => {
      const storage = fakeStorage();
      await saveSettings({ model: 'llama3.1' }, storage);
      expect(storage.data).toEqual({ 'settings.model': 'llama3.1' });
      expect(storage.set).toHaveBeenCalledWith({ 'settings.model': 'llama3.1' });
    });

    it('merges partial updates with what is already saved', async () => {
      const storage = fakeStorage();
      await saveSettings({ model: 'llama3.1', temperature: 1 }, storage);
      const result = await saveSettings({ temperature: 0.5 }, storage);

      expect(result).toEqual({ ...DEFAULT_SETTINGS, model: 'llama3.1', temperature: 0.5 });
      expect(storage.data).toEqual({ 'settings.model': 'llama3.1', 'settings.temperature': 0.5 });
    });

    it('keeps both updates when two saves of different fields overlap', async () => {
      // Hold every read until both saves have started, the way two extension
      // contexts can interleave. Neither save may undo the other.
      const storage = fakeStorage();
      const realGet = storage.get;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      storage.get = vi.fn(async (keys: string[]) => {
        await gate;
        return realGet(keys);
      });

      const a = saveSettings({ model: 'A' }, storage);
      const b = saveSettings({ temperature: 1 }, storage);
      release();
      await Promise.all([a, b]);

      await expect(getSettings(storage)).resolves.toMatchObject({ model: 'A', temperature: 1 });
    });

    it('treats undefined fields as "keep the current value"', async () => {
      const storage = fakeStorage();
      await saveSettings({ model: 'llama3.1' }, storage);
      await saveSettings({ model: undefined, temperature: 1 }, storage);
      await expect(getSettings(storage)).resolves.toMatchObject({
        model: 'llama3.1',
        temperature: 1,
      });
    });

    it('ignores unknown fields', async () => {
      const storage = fakeStorage();
      await saveSettings({ model: 'm', apiKey: 'x' } as Partial<Settings>, storage);
      expect(storage.data).toEqual({ 'settings.model': 'm' });
    });

    it('trims the model name and drops a trailing slash from the URL', async () => {
      const storage = fakeStorage();
      const result = await saveSettings(
        { llmUrl: ' http://localhost:11434/ ', model: '  llama3.1 ' },
        storage,
      );
      expect(result).toMatchObject({ llmUrl: 'http://localhost:11434', model: 'llama3.1' });
    });
  });

  describe('validation', () => {
    it.each([
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://[::1]:11434',
      'https://localhost:8443',
      'http://localhost',
    ])('accepts the local URL %s', async (llmUrl) => {
      await expect(saveSettings({ llmUrl }, fakeStorage())).resolves.toMatchObject({ llmUrl });
    });

    it.each([
      ['not a URL', 'not a url'],
      ['a remote host', 'http://example.com:11434'],
      ['a LAN address', 'http://192.168.1.20:11434'],
      ['a lookalike host', 'http://localhost.example.com:11434'],
      ['another scheme', 'ftp://localhost:11434'],
      ['a path', 'http://localhost:11434/api'],
      ['a query string', 'http://localhost:11434?x=1'],
      ['credentials', 'http://user:pw@localhost:11434'],
      ['an empty string', ''],
    ])('rejects %s as the URL', async (_label, llmUrl) => {
      await expectRejectedFields(saveSettings({ llmUrl }, fakeStorage()), ['llmUrl']);
    });

    it.each([0, 0.2, 2])('accepts temperature %s', async (temperature) => {
      await expect(saveSettings({ temperature }, fakeStorage())).resolves.toMatchObject({
        temperature,
      });
    });

    it.each([-0.1, 2.1, NaN, Infinity])('rejects temperature %s', async (temperature) => {
      await expectRejectedFields(saveSettings({ temperature }, fakeStorage()), ['temperature']);
    });

    it.each([0, 1.5, 32769, -5])('rejects max response length %s', async (maxResponseTokens) => {
      await expectRejectedFields(saveSettings({ maxResponseTokens }, fakeStorage()), [
        'maxResponseTokens',
      ]);
    });

    it('reports every bad field at once with a readable message', async () => {
      const promise = saveSettings({ llmUrl: 'http://example.com', temperature: 5 }, fakeStorage());
      await expectRejectedFields(promise, ['llmUrl', 'temperature']);
      await expect(promise).rejects.toThrow(
        'llmUrl: URL must point to this computer (localhost or 127.0.0.1).; ' +
          'temperature: Temperature must be a number from 0 to 2.',
      );
    });

    it('stores nothing when a save is rejected', async () => {
      const storage = fakeStorage();
      await saveSettings({ model: 'llama3.1' }, storage);
      await expect(saveSettings({ model: 'other', temperature: 9 }, storage)).rejects.toThrow();
      expect(storage.data).toEqual({ 'settings.model': 'llama3.1' });
    });

    it('falls back to the default for bad or unknown stored values', async () => {
      const storage = fakeStorage({
        'settings.llmUrl': 'http://evil.example.com',
        'settings.model': 'llama3.1',
        'settings.temperature': 'hot',
        'settings.extra': true,
      });
      await expect(getSettings(storage)).resolves.toEqual({
        ...DEFAULT_SETTINGS,
        model: 'llama3.1',
      });
    });

    it('ignores storage keys that are not settings', async () => {
      const storage = fakeStorage({ model: 'not ours', settings: { model: 'old' } });
      await expect(getSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
      expect(storageKey('model')).toBe('settings.model');
    });
  });
});
