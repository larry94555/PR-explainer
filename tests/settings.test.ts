import {
  CHAT_MIN_RESPONSE_TOKENS,
  chatModelOf,
  chatResponseTokens,
  chatSettings,
  hasOwnChatModel,
  DEFAULT_SETTINGS,
  DEFAULT_SKIP_PATTERNS,
  chatPlaceOf,
  followChatPlace,
  followRequestsAtOnce,
  HOVER_WAIT_MS_RANGE,
  REQUESTS_AT_ONCE_RANGE,
  requestsAtOnceOf,
  getSettings,
  saveSettings,
  storageKey,
  SettingsValidationError,
  validateSettings,
  type Settings,
  type StorageAreaLike,
} from '../src/settings';
import {
  DEFAULT_SKIP_PATTERNS as CONTENT_SKIP_PATTERNS,
  SKIP_SETTING_KEY,
  skipPatternsOf,
} from '../src/skipFiles';
import { STREAM_SETTING_KEY, trackStreamSetting } from '../src/streamSetting';
import { CHAT_PLACE_KEY, chatPlaceOf as contentChatPlaceOf } from '../src/chat/sidePanelChat';
import {
  AHEAD_SETTING_KEY,
  REQUESTS_AT_ONCE,
  REQUESTS_SETTING_KEY,
  requestsAtOnceOf as contentRequestsAtOnceOf,
} from '../src/explainAhead';
import type { StorageChangedEvent } from '../src/enabledState';
import {
  HOVER_SETTING_KEY,
  HOVER_WAIT_KEY,
  HOVER_WAIT_MS,
  hoverWaitOf,
  toHoverEnabled,
} from '../src/prefetch';

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
  describe('chat answer limit (PR 8.4)', () => {
    it('lets chat answers run to CHAT_MIN_RESPONSE_TOKENS when the setting is lower', () => {
      expect(CHAT_MIN_RESPONSE_TOKENS).toBe(1024);
      expect(chatResponseTokens(DEFAULT_SETTINGS)).toBe(1024);
      expect(chatResponseTokens({ maxResponseTokens: 1 })).toBe(1024);
    });

    it('still gives chat at least 1024 with the 120-token default (PR 9.8)', () => {
      expect(DEFAULT_SETTINGS.maxResponseTokens).toBe(120);
      expect(chatResponseTokens({ maxResponseTokens: 120 })).toBe(1024);
    });

    it('uses the setting when it is higher', () => {
      expect(chatResponseTokens({ maxResponseTokens: 4096 })).toBe(4096);
    });
  });

  describe('Chat model (PR 9.14)', () => {
    it('is "Same as explanations" by default, so chat uses Model', () => {
      const settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:1.5b' };
      expect(settings.chatModel).toBe('');
      expect(chatModelOf(settings)).toBe('qwen2.5-coder:1.5b');
      expect(chatSettings(settings)).toEqual(settings);
      expect(hasOwnChatModel(settings)).toBe(false);
    });

    it('sends chat to the Chat model when one is set, leaving the rest as it is', () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'qwen2.5-coder:1.5b',
        chatModel: 'qwen2.5-coder:7b',
        temperature: 0.5,
      };
      expect(chatModelOf(settings)).toBe('qwen2.5-coder:7b');
      expect(chatSettings(settings)).toEqual({ ...settings, model: 'qwen2.5-coder:7b' });
      expect(hasOwnChatModel(settings)).toBe(true);
    });

    it('does not count the same model, with or without :latest, as a model of its own', () => {
      expect(hasOwnChatModel({ model: 'llama3', chatModel: 'llama3' })).toBe(false);
      expect(hasOwnChatModel({ model: 'llama3', chatModel: 'llama3:latest' })).toBe(false);
      expect(hasOwnChatModel({ model: 'llama3:latest', chatModel: 'llama3' })).toBe(false);
      expect(hasOwnChatModel({ model: 'llama3', chatModel: 'llama3:8b' })).toBe(true);
    });

    it('saves a trimmed Chat model and rejects one that is not text', async () => {
      const storage = fakeStorage();
      await saveSettings({ chatModel: '  qwen2.5-coder:7b ' }, storage);
      expect(storage.data).toEqual({ [storageKey('chatModel')]: 'qwen2.5-coder:7b' });
      await expectRejectedFields(saveSettings({ chatModel: 7 as unknown as string }, storage), [
        'chatModel',
      ]);
      // Back to "Same as explanations".
      await saveSettings({ chatModel: '' }, storage);
      expect((await getSettings(storage)).chatModel).toBe('');
    });

    it('falls back to "Same as explanations" when the stored value is not text', async () => {
      const storage = fakeStorage({ [storageKey('chatModel')]: 42 });
      expect((await getSettings(storage)).chatModel).toBe('');
    });
  });

  describe('defaults', () => {
    it('uses the Ollama default URL, no model, temperature 0.2, 120-token answers, keep loaded 30 minutes', () => {
      expect(DEFAULT_SETTINGS).toEqual({
        llmUrl: 'http://localhost:11434',
        model: '',
        // "Same as explanations" (PR 9.14).
        chatModel: '',
        chatOpensIn: 'sidepanel',
        temperature: 0.2,
        // One sentence per section arrives sooner (PR 8.4, PR 9.8).
        maxResponseTokens: 120,
        contextTokens: 0,
        keepAliveMinutes: 30,
        // Explain on hover hides the model's time on most clicks (PR 11.2).
        explainOnHover: true,
        // Most people rest on a line for less than a second (PR 11.2).
        hoverWaitMs: 300,
        // Explain ahead keeps the model busy and uses battery (PR 9.10, PR 10.6).
        explainAhead: 'off',
        // On a CPU, requests at once share the same cores (PR 10.6).
        requestsAtOnce: 1,
        // Background work drains the battery and turns the fan on (PR 11.3).
        backgroundOnBattery: 'pause',
        // Lockfiles, bundles and generated code nobody clicks (PR 11.4).
        skipInBackground: DEFAULT_SKIP_PATTERNS.join('\n'),
        // A whole PR prefetched once stays done for a week (PR 10.9).
        keepAnswersDays: 7,
        // Thinking was most of the wait on a reasoning model (PR 9.5).
        letModelThink: false,
        // The answer appears whole, so the sections do not jump around (PR 9.6).
        streamAnswers: false,
        showPrompt: false,
        // The debug log keeps prompts, so it is opt-in (PR 9.3).
        debugWindow: false,
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

  it('keeps a stored 300, which may be a deliberate choice, over the new default (PR 9.8)', async () => {
    const storage = fakeStorage({ [storageKey('maxResponseTokens')]: 300 });
    expect((await getSettings(storage)).maxResponseTokens).toBe(300);
    expect(storage.set).not.toHaveBeenCalled();
  });

  describe('saving and reloading', () => {
    it('saves values and reads them back', async () => {
      const storage = fakeStorage();
      const update = {
        llmUrl: 'http://127.0.0.1:8080',
        model: 'qwen2.5-coder:1.5b',
        chatModel: 'qwen2.5-coder:7b',
        chatOpensIn: 'page' as const,
        temperature: 0.7,
        maxResponseTokens: 2048,
        contextTokens: 8192,
        keepAliveMinutes: 90,
        explainOnHover: false,
        hoverWaitMs: 1000,
        explainAhead: 'pr' as const,
        requestsAtOnce: 2,
        backgroundOnBattery: 'keep' as const,
        skipInBackground: '*.min.js\ndist/',
        keepAnswersDays: 30,
        letModelThink: true,
        streamAnswers: true,
        showPrompt: true,
        debugWindow: true,
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

    it.each([0, 512, 2048, 131072])(
      'accepts context size %s (0 is automatic)',
      async (contextTokens) => {
        await expect(saveSettings({ contextTokens }, fakeStorage())).resolves.toMatchObject({
          contextTokens,
        });
      },
    );

    it.each([100, 511, 131073, 2048.5, NaN])('rejects context size %s', async (contextTokens) => {
      const promise = saveSettings({ contextTokens }, fakeStorage());
      await expectRejectedFields(promise, ['contextTokens']);
      await expect(promise).rejects.toThrow(
        'Context size must be a whole number from 512 to 131072, or 0 for automatic.',
      );
    });

    it.each([0, 1, 30, 1440])(
      'accepts keep model loaded for %s minutes (0 unloads after each answer)',
      async (keepAliveMinutes) => {
        await expect(saveSettings({ keepAliveMinutes }, fakeStorage())).resolves.toMatchObject({
          keepAliveMinutes,
        });
      },
    );

    it.each([-1, 1441, 2.5, NaN])(
      'rejects keep model loaded for %s minutes',
      async (keepAliveMinutes) => {
        const promise = saveSettings({ keepAliveMinutes }, fakeStorage());
        await expectRejectedFields(promise, ['keepAliveMinutes']);
        await expect(promise).rejects.toThrow(
          'Keep model loaded must be a whole number from 0 to 1440.',
        );
      },
    );

    it('accepts Explain on hover on or off and nothing else (PR 8.7)', async () => {
      await expect(saveSettings({ explainOnHover: true }, fakeStorage())).resolves.toMatchObject({
        explainOnHover: true,
      });
      const promise = saveSettings({ explainOnHover: 1 as unknown as boolean }, fakeStorage());
      await expectRejectedFields(promise, ['explainOnHover']);
      await expect(promise).rejects.toThrow('Explain on hover must be on or off.');
    });

    it('accepts Pause or Keep going for Background work on battery and nothing else (PR 11.3)', async () => {
      for (const mode of ['pause', 'keep'] as const) {
        await expect(
          saveSettings({ backgroundOnBattery: mode }, fakeStorage()),
        ).resolves.toMatchObject({ backgroundOnBattery: mode });
      }
      for (const bad of [true, 'off', '']) {
        const promise = saveSettings(
          { backgroundOnBattery: bad as unknown as 'pause' },
          fakeStorage(),
        );
        await expectRejectedFields(promise, ['backgroundOnBattery']);
        await expect(promise).rejects.toThrow(
          'Background work on battery must be Pause or Keep going.',
        );
      }
      const key = storageKey('backgroundOnBattery');
      expect((await getSettings(fakeStorage({ [key]: 'never' }))).backgroundOnBattery).toBe(
        'pause',
      );
    });

    it('accepts Off, Lines on screen or Whole PR for Explain ahead and nothing else (PR 10.6)', async () => {
      for (const mode of ['off', 'screen', 'pr'] as const) {
        await expect(saveSettings({ explainAhead: mode }, fakeStorage())).resolves.toMatchObject({
          explainAhead: mode,
        });
      }
      for (const bad of [true, 'yes']) {
        const promise = saveSettings({ explainAhead: bad as unknown as 'off' }, fakeStorage());
        await expectRejectedFields(promise, ['explainAhead']);
        await expect(promise).rejects.toThrow(
          'Explain ahead must be Off, Lines on screen or Whole PR.',
        );
      }
    });

    it('reads an Explain ahead on or off saved before PR 10.6 as Lines on screen or Off', async () => {
      const key = storageKey('explainAhead');
      expect((await getSettings(fakeStorage({ [key]: true }))).explainAhead).toBe('screen');
      expect((await getSettings(fakeStorage({ [key]: false }))).explainAhead).toBe('off');
      expect((await getSettings(fakeStorage({ [key]: 'fast' }))).explainAhead).toBe('off');
    });

    it('accepts Requests at once as a whole number from 1 to 4 (PR 10.6)', async () => {
      for (const n of [1, 2, 3, 4]) {
        await expect(saveSettings({ requestsAtOnce: n }, fakeStorage())).resolves.toMatchObject({
          requestsAtOnce: n,
        });
      }
      for (const bad of [0, 5, 1.5, NaN, '2' as unknown as number]) {
        const promise = saveSettings({ requestsAtOnce: bad }, fakeStorage());
        await expectRejectedFields(promise, ['requestsAtOnce']);
        await expect(promise).rejects.toThrow(
          'Requests at once must be a whole number from 1 to 4.',
        );
      }
      expect(requestsAtOnceOf(3)).toBe(3);
      expect(requestsAtOnceOf(9)).toBe(1);
      expect(requestsAtOnceOf(undefined)).toBe(1);
    });

    it('accepts Keep answers for as a whole number of days from 0 to 365 (PR 10.9)', async () => {
      for (const n of [0, 1, 7, 365]) {
        await expect(saveSettings({ keepAnswersDays: n }, fakeStorage())).resolves.toMatchObject({
          keepAnswersDays: n,
        });
      }
      for (const bad of [-1, 366, 2.5, NaN, '7' as unknown as number]) {
        const promise = saveSettings({ keepAnswersDays: bad }, fakeStorage());
        await expectRejectedFields(promise, ['keepAnswersDays']);
        await expect(promise).rejects.toThrow(
          'Keep answers for must be a whole number from 0 to 365.',
        );
      }
      // A bad stored value falls back to the default.
      const stored = fakeStorage({ [storageKey('keepAnswersDays')]: -3 });
      expect((await getSettings(stored)).keepAnswersDays).toBe(7);
    });

    it('follows Requests at once in the service worker: 1 until read, then each save (PR 10.6)', async () => {
      const key = storageKey('requestsAtOnce');
      let listener: (
        changes: Record<string, { newValue?: unknown }>,
        area: string,
      ) => void = () => {};
      const followed = followRequestsAtOnce(fakeStorage({ [key]: 2 }), {
        addListener: (l) => void (listener = l),
      });
      expect(followed.current()).toBe(1);
      await new Promise((r) => setTimeout(r, 0));
      expect(followed.current()).toBe(2);
      listener({ [key]: { newValue: 4 } }, 'local');
      expect(followed.current()).toBe(2);
      listener({ [key]: { newValue: 4 } }, 'sync');
      expect(followed.current()).toBe(4);
      listener({ [key]: { newValue: 7 } }, 'sync');
      expect(followed.current()).toBe(1);
    });

    it('follows Chat opens in in the service worker: Side panel until read, then each save (PR 11.9)', async () => {
      const key = storageKey('chatOpensIn');
      let listener: (
        changes: Record<string, { newValue?: unknown }>,
        area: string,
      ) => void = () => {};
      const followed = followChatPlace(fakeStorage({ [key]: 'page' }), {
        addListener: (l) => void (listener = l),
      });
      expect(followed.current()).toBe('sidepanel');
      await new Promise((r) => setTimeout(r, 0));
      expect(followed.current()).toBe('page');
      listener({ [key]: { newValue: 'sidepanel' } }, 'sync');
      expect(followed.current()).toBe('sidepanel');
      listener({ [key]: { newValue: 'nonsense' } }, 'sync');
      expect(followed.current()).toBe('sidepanel');
      // Read the same way as the content script's copy of the setting.
      expect(['page', 'sidepanel', undefined, 3].map(chatPlaceOf)).toEqual(
        ['page', 'sidepanel', undefined, 3].map(contentChatPlaceOf),
      );
    });

    it('lets a save of Chat opens in made before the read win (PR 11.9)', async () => {
      const key = storageKey('chatOpensIn');
      let listener: (
        changes: Record<string, { newValue?: unknown }>,
        area: string,
      ) => void = () => {};
      const followed = followChatPlace(fakeStorage({ [key]: 'sidepanel' }), {
        addListener: (l) => void (listener = l),
      });
      listener({ [key]: { newValue: 'page' } }, 'sync');
      await new Promise((r) => setTimeout(r, 0));
      expect(followed.current()).toBe('page');
    });

    it('the content script reads Requests at once under its key, with the same limits (PR 10.6)', () => {
      expect(REQUESTS_SETTING_KEY).toBe(storageKey('requestsAtOnce'));
      expect(REQUESTS_AT_ONCE).toEqual({
        ...REQUESTS_AT_ONCE_RANGE,
        default: DEFAULT_SETTINGS.requestsAtOnce,
      });
      expect([0, 1, 4, 5, 2.5].map(contentRequestsAtOnceOf)).toEqual(
        [0, 1, 4, 5, 2.5].map(requestsAtOnceOf),
      );
    });

    it('keeps a saved Explain on hover off, now that it is on by default (PR 11.2)', async () => {
      const storage = fakeStorage({ [storageKey('explainOnHover')]: false });
      expect((await getSettings(storage)).explainOnHover).toBe(false);
      expect((await getSettings(fakeStorage())).explainOnHover).toBe(true);
    });

    it('keeps Skip in background as one pattern per line, up to 4000 characters (PR 11.4)', async () => {
      const saved = await saveSettings(
        { skipInBackground: '  *.min.js \r\n\n dist/\n' },
        fakeStorage(),
      );
      expect(saved.skipInBackground).toBe('*.min.js\ndist/');
      // Empty skips nothing, and is kept as empty rather than the defaults.
      const storage = fakeStorage();
      await saveSettings({ skipInBackground: '' }, storage);
      expect((await getSettings(storage)).skipInBackground).toBe('');
      for (const bad of ['a'.repeat(4001), 3 as unknown as string]) {
        await expectRejectedFields(saveSettings({ skipInBackground: bad }, fakeStorage()), [
          'skipInBackground',
        ]);
      }
    });

    it('the content script reads Skip in background under its key, with the same defaults (PR 11.4)', () => {
      expect(SKIP_SETTING_KEY).toBe(storageKey('skipInBackground'));
      expect([...CONTENT_SKIP_PATTERNS]).toEqual([...DEFAULT_SKIP_PATTERNS]);
      expect(skipPatternsOf(DEFAULT_SETTINGS.skipInBackground)).toEqual([...DEFAULT_SKIP_PATTERNS]);
    });

    it('accepts a Hover wait from 150 to 2000 ms, whole numbers only (PR 11.2)', async () => {
      for (const ok of [150, 300, 2000]) {
        await expect(saveSettings({ hoverWaitMs: ok }, fakeStorage())).resolves.toMatchObject({
          hoverWaitMs: ok,
        });
      }
      for (const bad of [149, 2001, 300.5, NaN, '300' as unknown as number]) {
        const promise = saveSettings({ hoverWaitMs: bad }, fakeStorage());
        await expectRejectedFields(promise, ['hoverWaitMs']);
        await expect(promise).rejects.toThrow(
          'Hover wait must be a whole number from 150 to 2000.',
        );
      }
      // A bad stored value falls back to the default.
      const storage = fakeStorage({ [storageKey('hoverWaitMs')]: 50 });
      expect((await getSettings(storage)).hoverWaitMs).toBe(300);
    });

    it('the content script reads Explain on hover and Hover wait under their keys, with the same default and limits (PR 11.2)', () => {
      expect(HOVER_SETTING_KEY).toBe(storageKey('explainOnHover'));
      expect(HOVER_WAIT_KEY).toBe(storageKey('hoverWaitMs'));
      expect(toHoverEnabled(undefined)).toBe(DEFAULT_SETTINGS.explainOnHover);
      expect(HOVER_WAIT_MS).toEqual({
        ...HOVER_WAIT_MS_RANGE,
        default: DEFAULT_SETTINGS.hoverWaitMs,
      });
      expect(hoverWaitOf(undefined)).toBe(DEFAULT_SETTINGS.hoverWaitMs);
    });

    it('the content script reads Explain ahead under its key (PR 9.10)', () => {
      expect(AHEAD_SETTING_KEY).toBe(storageKey('explainAhead'));
    });

    it('accepts Let the model think on or off and nothing else (PR 9.5)', async () => {
      await expect(saveSettings({ letModelThink: true }, fakeStorage())).resolves.toMatchObject({
        letModelThink: true,
      });
      const promise = saveSettings({ letModelThink: 'yes' as unknown as boolean }, fakeStorage());
      await expectRejectedFields(promise, ['letModelThink']);
      await expect(promise).rejects.toThrow('Let the model think must be on or off.');
    });

    it('accepts Show answers as they are written on or off and nothing else (PR 9.6)', async () => {
      await expect(saveSettings({ streamAnswers: true }, fakeStorage())).resolves.toMatchObject({
        streamAnswers: true,
      });
      const promise = saveSettings({ streamAnswers: 'on' as unknown as boolean }, fakeStorage());
      await expectRejectedFields(promise, ['streamAnswers']);
      await expect(promise).rejects.toThrow('Show answers as they are written must be on or off.');
    });

    it('opens the chat in the side panel by default, and takes On the page (PR 11.8)', async () => {
      expect(DEFAULT_SETTINGS.chatOpensIn).toBe('sidepanel');
      await expect(saveSettings({ chatOpensIn: 'page' }, fakeStorage())).resolves.toMatchObject({
        chatOpensIn: 'page',
      });
      const promise = saveSettings({ chatOpensIn: 'popup' as unknown as 'page' }, fakeStorage());
      await expectRejectedFields(promise, ['chatOpensIn']);
      await expect(promise).rejects.toThrow('Chat opens in must be Side panel or On the page.');
    });

    it('the content script reads Chat opens in under its key, side panel unless page (PR 11.8)', () => {
      expect(CHAT_PLACE_KEY).toBe(storageKey('chatOpensIn'));
      expect(chatPlaceOf('page')).toBe('page');
      for (const stored of ['sidepanel', undefined, 'other', 1]) {
        expect(chatPlaceOf(stored)).toBe('sidepanel');
      }
    });

    it('the content script reads Show answers as they are written under its key (PR 9.6)', () => {
      expect(STREAM_SETTING_KEY).toBe(storageKey('streamAnswers'));
    });

    it('the content script follows Show answers as they are written as it is saved (PR 9.6)', async () => {
      let listener: Parameters<StorageChangedEvent['addListener']>[0] = () => {};
      const events: StorageChangedEvent = { addListener: (l) => void (listener = l) };
      const setting = trackStreamSetting(
        { get: async () => ({ [STREAM_SETTING_KEY]: true }) },
        events,
      );
      // Off until the read answers.
      expect(setting.current()).toBe(false);
      await vi.waitFor(() => expect(setting.current()).toBe(true));
      listener({ [STREAM_SETTING_KEY]: { newValue: false } }, 'sync');
      expect(setting.current()).toBe(false);
      // Another storage area, or another key, changes nothing.
      listener({ [STREAM_SETTING_KEY]: { newValue: true } }, 'local');
      listener({ 'settings.showPrompt': { newValue: true } }, 'sync');
      expect(setting.current()).toBe(false);
      // A stored value that is not a boolean means off.
      const odd = trackStreamSetting(
        { get: async () => ({ [STREAM_SETTING_KEY]: 'yes' }) },
        events,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(odd.current()).toBe(false);
    });

    it('accepts Show prompt on or off and nothing else', async () => {
      await expect(saveSettings({ showPrompt: true }, fakeStorage())).resolves.toMatchObject({
        showPrompt: true,
      });
      await expectRejectedFields(
        saveSettings({ showPrompt: 'yes' as unknown as boolean }, fakeStorage()),
        ['showPrompt'],
      );
    });

    it('accepts Debug window on or off and nothing else (PR 9.3)', async () => {
      await expect(saveSettings({ debugWindow: true }, fakeStorage())).resolves.toMatchObject({
        debugWindow: true,
      });
      const promise = saveSettings({ debugWindow: 1 as unknown as boolean }, fakeStorage());
      await expectRejectedFields(promise, ['debugWindow']);
      await expect(promise).rejects.toThrow('Debug window must be on or off.');
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
