// @vitest-environment node
// PR 9.4: the popup's Debug button and the toolbar button's menu open one debug window.
import {
  createDebugWindowOpener,
  DEBUG_MENU_ID,
  DEBUG_MENU_TITLE,
  DEBUG_WINDOW_ID_KEY,
  setupDebugMenu,
  type ContextMenusLike,
  type WindowsLike,
} from '../src/debug/debugWindowOpener';
import type { SessionStorageLike } from '../src/debug/debugLog';
import { storageKey } from '../src/settings';

const URL = 'chrome-extension://ext/debug.html';

function fakeSession(): SessionStorageLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => void Object.assign(data, items),
  };
}

function fakeWindows() {
  const open = new Set<number>();
  let next = 10;
  const windows = {
    create: vi.fn(async () => {
      const id = next++;
      open.add(id);
      return { id };
    }),
    update: vi.fn(async (id: number) => {
      if (!open.has(id)) throw new Error(`No window with id: ${id}.`);
      return {};
    }),
  } satisfies WindowsLike;
  return { windows, close: (id: number) => open.delete(id) };
}

describe('debug window opener (PR 9.4)', () => {
  it('opens debug.html in a window of its own, then brings the same one to the front', async () => {
    const { windows } = fakeWindows();
    const storage = fakeSession();
    const opener = createDebugWindowOpener({ windows, storage, url: URL });
    expect(await opener.open()).toBe('opened');
    expect(windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL, type: 'popup', focused: true }),
    );
    expect(await opener.open()).toBe('focused');
    expect(windows.create).toHaveBeenCalledTimes(1);
    expect(windows.update).toHaveBeenLastCalledWith(10, { focused: true });
  });

  it('opens one window for two quick clicks', async () => {
    const { windows } = fakeWindows();
    const opener = createDebugWindowOpener({ windows, storage: fakeSession(), url: URL });
    expect(await Promise.all([opener.open(), opener.open()])).toEqual(['opened', 'focused']);
    expect(windows.create).toHaveBeenCalledTimes(1);
  });

  it('remembers the window after the service worker restarts, and opens a new one once it is closed', async () => {
    const { windows, close } = fakeWindows();
    const storage = fakeSession();
    await createDebugWindowOpener({ windows, storage, url: URL }).open();
    expect(storage.data[DEBUG_WINDOW_ID_KEY]).toBe(10);
    const restarted = createDebugWindowOpener({ windows, storage, url: URL });
    expect(await restarted.open()).toBe('focused');
    close(10);
    expect(await restarted.open()).toBe('opened');
    expect(storage.data[DEBUG_WINDOW_ID_KEY]).toBe(11);
  });
});

describe('Open debug window on the toolbar button menu (PR 9.4)', () => {
  function fakeMenus() {
    let onClicked: (info: { menuItemId: string | number }) => void = () => {};
    const menus = {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      update: vi.fn(async () => {}),
      onClicked: { addListener: (l: typeof onClicked) => void (onClicked = l) },
    } satisfies ContextMenusLike;
    return { menus, click: (id: string) => onClicked({ menuItemId: id }) };
  }

  function setup(on: boolean) {
    const { menus, click } = fakeMenus();
    let changed: (changes: Record<string, { newValue?: unknown }>, area: string) => void = () => {};
    const open = vi.fn(async () => 'opened');
    const made = setupDebugMenu({
      menus,
      onChanged: { addListener: (l) => void (changed = l) },
      isOn: async () => on,
      open,
    });
    return {
      menus,
      click,
      open,
      made,
      changed: (...args: Parameters<typeof changed>) => changed(...args),
    };
  }

  it('adds the item to the toolbar button menu, shown only with the setting on', async () => {
    const off = setup(false);
    await off.made;
    expect(off.menus.removeAll).toHaveBeenCalled();
    expect(off.menus.create).toHaveBeenCalledWith({
      id: DEBUG_MENU_ID,
      title: DEBUG_MENU_TITLE,
      contexts: ['action'],
      visible: false,
    });
    const on = setup(true);
    await on.made;
    expect(on.menus.create).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  });

  it('shows or hides it when the setting is saved', async () => {
    const t = setup(false);
    await t.made;
    t.changed({ [storageKey('debugWindow')]: { newValue: true } }, 'sync');
    await vi.waitFor(() =>
      expect(t.menus.update).toHaveBeenCalledWith(DEBUG_MENU_ID, { visible: true }),
    );
    t.changed({ [storageKey('debugWindow')]: { newValue: false } }, 'sync');
    await vi.waitFor(() =>
      expect(t.menus.update).toHaveBeenLastCalledWith(DEBUG_MENU_ID, { visible: false }),
    );
    t.changed({ [storageKey('model')]: { newValue: 'x' } }, 'sync');
    expect(t.menus.update).toHaveBeenCalledTimes(2);
  });

  it('opens the window when chosen, and ignores other menu items', async () => {
    const t = setup(true);
    await t.made;
    t.click('something-else');
    expect(t.open).not.toHaveBeenCalled();
    t.click(DEBUG_MENU_ID);
    expect(t.open).toHaveBeenCalledTimes(1);
  });
});
