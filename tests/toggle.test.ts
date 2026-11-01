import * as content from '../src/enabledState';
import {
  DEFAULT_ENABLED,
  ENABLED_KEY,
  readEnabled,
  trackEnabled,
  watchEnabled,
  type LocalStorageLike,
  type StorageChange,
} from '../src/enabledState';
import * as toolbar from '../src/toolbarToggle';
import {
  actionBadge,
  setupToolbarToggle,
  toggleEnabled,
  type ActionLike,
} from '../src/toolbarToggle';

// An in-memory stand-in for chrome.storage.local that also fires
// chrome.storage.onChanged, like Chrome does after each set.
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;
  const listeners: Listener[] = [];
  const storage: LocalStorageLike & { data: Record<string, unknown> } = {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      for (const listener of listeners) listener(changes, 'local');
    }),
  };
  const onChanged = {
    addListener: (listener: Listener) => listeners.push(listener),
    fire: (changes: Record<string, StorageChange>, areaName: string) =>
      listeners.forEach((l) => l(changes, areaName)),
  };
  return { storage, onChanged };
}

// A stand-in for chrome.action that remembers what the icon shows.
function fakeAction() {
  const shown = { text: '', color: '', title: '' };
  let onClick: (() => void) | undefined;
  const action: ActionLike = {
    setBadgeText: vi.fn(async ({ text }) => void (shown.text = text)),
    setBadgeBackgroundColor: vi.fn(async ({ color }) => void (shown.color = color)),
    setTitle: vi.fn(async ({ title }) => void (shown.title = title)),
    onClicked: { addListener: (listener) => void (onClick = listener) },
  };
  return { action, shown, click: () => onClick?.() };
}

describe('on/off state', () => {
  it('uses the same storage key and default in the content script and the service worker', () => {
    expect(toolbar.ENABLED_KEY).toBe(content.ENABLED_KEY);
    expect(toolbar.DEFAULT_ENABLED).toBe(content.DEFAULT_ENABLED);
  });

  it('is on by default and on when the stored value is not a boolean', async () => {
    expect(DEFAULT_ENABLED).toBe(true);
    await expect(readEnabled(fakeStorage().storage)).resolves.toBe(true);
    await expect(readEnabled(fakeStorage({ [ENABLED_KEY]: 'no' }).storage)).resolves.toBe(true);
    await expect(readEnabled(fakeStorage({ [ENABLED_KEY]: false }).storage)).resolves.toBe(false);
  });

  it('flips and saves the state on each toggle', async () => {
    const { storage } = fakeStorage();
    await expect(toggleEnabled(storage)).resolves.toBe(false);
    expect(storage.data[ENABLED_KEY]).toBe(false);
    await expect(readEnabled(storage)).resolves.toBe(false);
    await expect(toggleEnabled(storage)).resolves.toBe(true);
    await expect(readEnabled(storage)).resolves.toBe(true);
  });

  it('tells the content script about changes to the local key only', () => {
    const { onChanged } = fakeStorage();
    const seen: boolean[] = [];
    watchEnabled(onChanged, (enabled) => seen.push(enabled));
    onChanged.fire({ [ENABLED_KEY]: { newValue: false } }, 'local');
    onChanged.fire({ [ENABLED_KEY]: { newValue: false } }, 'sync'); // other area
    onChanged.fire({ 'settings.model': { newValue: 'x' } }, 'local'); // other key
    onChanged.fire({ [ENABLED_KEY]: { oldValue: false } }, 'local'); // key removed
    expect(seen).toEqual([false, true]);
  });
});

describe('trackEnabled (content script)', () => {
  /** A storage whose first get waits until the test settles it. */
  function slowStorage() {
    const { storage, onChanged } = fakeStorage({ [ENABLED_KEY]: true });
    let finish!: (value: Record<string, unknown>) => void;
    let fail!: (error: unknown) => void;
    vi.mocked(storage.get).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    return {
      storage,
      onChanged,
      finish: (v: unknown) => finish({ [ENABLED_KEY]: v }),
      fail: (e: unknown) => fail(e),
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('is unknown until the saved state is read, then reports it', async () => {
    const { storage, onChanged, finish } = slowStorage();
    const seen: string[] = [];
    const state = trackEnabled(storage, onChanged, (v, cause) => seen.push(`${cause}:${v}`));
    expect(state.current()).toBeNull();
    finish(false);
    await flush();
    expect(state.current()).toBe(false);
    expect(seen).toEqual(['read:false']);
  });

  it('ignores a pending read that a newer OFF change overtook', async () => {
    const { storage, onChanged, finish } = slowStorage();
    const seen: string[] = [];
    const state = trackEnabled(storage, onChanged, (v, cause) => seen.push(`${cause}:${v}`));
    // The toolbar is clicked while the first read is still pending...
    onChanged.fire({ [ENABLED_KEY]: { oldValue: true, newValue: false } }, 'local');
    expect(state.current()).toBe(false);
    // ...and the read then answers with the older value.
    finish(true);
    await flush();
    expect(state.current()).toBe(false);
    expect(seen).toEqual(['change:false']);
  });

  it('falls back to on if the read fails, unless a change already arrived', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = slowStorage();
    const first = trackEnabled(a.storage, a.onChanged, () => {});
    a.fail(new Error('boom'));
    await flush();
    expect(first.current()).toBe(true);

    const b = slowStorage();
    const second = trackEnabled(b.storage, b.onChanged, () => {});
    b.onChanged.fire({ [ENABLED_KEY]: { newValue: false } }, 'local');
    b.fail(new Error('boom'));
    await flush();
    expect(second.current()).toBe(false);
    warn.mockRestore();
  });
});

describe('toolbar button', () => {
  it('shows ON or OFF with a title that says what a click does', () => {
    expect(actionBadge(true)).toMatchObject({ text: 'ON', title: expect.stringContaining('off') });
    expect(actionBadge(false)).toMatchObject({ text: 'OFF', title: expect.stringContaining('on') });
    expect(actionBadge(true).color).not.toBe(actionBadge(false).color);
  });

  it('shows the saved state when the service worker starts', async () => {
    const { storage } = fakeStorage({ [ENABLED_KEY]: false });
    const { action, shown } = fakeAction();
    await setupToolbarToggle({ action, storage }).idle();
    expect(shown).toEqual(actionBadge(false));
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('turns off on the first click and back on on the second, saving each time', async () => {
    const { storage, onChanged } = fakeStorage();
    const { action, shown, click } = fakeAction();
    const pages: boolean[] = [];
    watchEnabled(onChanged, (enabled) => pages.push(enabled));
    const toggle = setupToolbarToggle({ action, storage });
    await toggle.idle();
    expect(shown.text).toBe('ON');

    click();
    await toggle.idle();
    expect(shown).toEqual(actionBadge(false));
    expect(storage.data[ENABLED_KEY]).toBe(false);

    click();
    await toggle.idle();
    expect(shown).toEqual(actionBadge(true));
    expect(storage.data[ENABLED_KEY]).toBe(true);
    expect(pages).toEqual([false, true]);
  });

  it('handles quick clicks one at a time', async () => {
    const { storage } = fakeStorage();
    const { action, shown, click } = fakeAction();
    const toggle = setupToolbarToggle({ action, storage });
    click();
    click();
    click();
    await toggle.idle();
    expect(storage.data[ENABLED_KEY]).toBe(false);
    expect(shown.text).toBe('OFF');
    expect(storage.set).toHaveBeenCalledTimes(3);
  });

  it('keeps working after a storage error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { storage } = fakeStorage();
    const { action, shown, click } = fakeAction();
    const toggle = setupToolbarToggle({ action, storage });
    vi.mocked(storage.set).mockRejectedValueOnce(new Error('quota'));
    click();
    await toggle.idle();
    expect(warn).toHaveBeenCalled();
    expect(shown.text).toBe('ON');
    click();
    await toggle.idle();
    expect(shown.text).toBe('OFF');
    warn.mockRestore();
  });
});
