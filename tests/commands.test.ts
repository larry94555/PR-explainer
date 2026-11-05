// Keyboard shortcuts you can change (PR 11.9): the service worker sends the
// Explain and Open chat commands to the active PR tab, and the tab acts on them.
import {
  EXPLAIN_COMMAND,
  followChatPlace,
  isPrPage,
  OPEN_CHAT_COMMAND,
  setupCommands,
  type ChatPlace,
  type CommandTabsLike,
  type TabLike,
} from '../src/commands';
import type { StorageChangedLike } from '../src/debug/debugLog';
import type { MessageListener } from '../src/messaging/protocol';
import type { SidePanelLike } from '../src/sidePanelOpener';
import { listenForTabCommands } from '../src/tabCommands';
import manifest from '../public/manifest.json';

const PR = 'https://github.com/owner/repo/pull/17/files';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTabs(active: TabLike[] = []) {
  const sent: { tabId: number; message: unknown; options?: { frameId?: number } }[] = [];
  const tabs: CommandTabsLike = {
    query: vi.fn(async () => active),
    sendMessage: vi.fn(async (tabId, message, options) => {
      sent.push({ tabId, message, options });
    }),
  };
  return { tabs, sent };
}

function setup({
  place = 'sidepanel' as ChatPlace,
  sidePanel = { open: vi.fn(async () => {}) } as SidePanelLike | undefined,
  active = [] as TabLike[],
} = {}) {
  let listener: (command: string, tab?: TabLike) => void = () => {};
  const commands = { onCommand: { addListener: (l: typeof listener) => void (listener = l) } };
  const { tabs, sent } = fakeTabs(active);
  setupCommands({ commands, tabs, sidePanel, chatPlace: () => place });
  return {
    press: (command: string, tab?: TabLike) => listener(command, tab),
    tabs,
    sent,
    sidePanel,
  };
}

describe('the manifest commands', () => {
  it('declares Explain on Ctrl+Shift+E and Open chat with no key', () => {
    expect(manifest.commands.explain.suggested_key).toEqual({ default: 'Ctrl+Shift+E' });
    expect(manifest.commands.explain.description).toMatch(/explain/i);
    expect(manifest.commands['open-chat']).toEqual({ description: 'Open chat' });
    expect(manifest.commands['open-chat']).not.toHaveProperty('suggested_key');
    expect(Object.keys(manifest.commands)).toEqual([EXPLAIN_COMMAND, OPEN_CHAT_COMMAND]);
  });
});

describe('isPrPage', () => {
  it.each([
    'https://github.com/owner/repo/pull/17',
    'https://github.com/owner/repo/pull/17/files',
    'https://github.com/owner/repo/pull/17/commits/abc123',
    'https://github.com/owner/repo/pull/17?w=1#diff-1',
  ])('is true for %s', (url) => expect(isPrPage(url)).toBe(true));

  it.each([
    undefined,
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/pulls',
    'https://github.com/owner/repo/issues/17',
    'https://gitlab.com/owner/repo/pull/17',
    'https://github.com.evil.example/owner/repo/pull/17',
  ])('is false for %s', (url) => expect(isPrPage(url)).toBe(false));
});

describe('setupCommands', () => {
  it('sends Explain to the active tab, its top frame', () => {
    const { press, sent } = setup();
    press(EXPLAIN_COMMAND, { id: 4, url: PR });
    expect(sent).toEqual([
      {
        tabId: 4,
        message: { type: 'pr-explainer:command', command: 'explain' },
        options: { frameId: 0 },
      },
    ]);
  });

  it('does nothing outside a PR', async () => {
    const { press, sent, sidePanel } = setup();
    press(EXPLAIN_COMMAND, { id: 4, url: 'https://github.com/owner/repo/issues/3' });
    press(OPEN_CHAT_COMMAND, { id: 4, url: 'https://example.com/' });
    press(EXPLAIN_COMMAND, { id: 4 });
    await flush();
    expect(sent).toEqual([]);
    expect(sidePanel!.open).not.toHaveBeenCalled();
  });

  it('ignores commands it does not know', async () => {
    const { press, sent } = setup();
    press('something-else', { id: 4, url: PR });
    await flush();
    expect(sent).toEqual([]);
  });

  it('asks for the active tab when Chrome passes none', async () => {
    const { press, sent, tabs } = setup({ active: [{ id: 9, url: PR }] });
    press(EXPLAIN_COMMAND);
    await flush();
    expect(tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(sent.map((s) => s.tabId)).toEqual([9]);
  });

  it('opens Open chat in the side panel at once, before anything is awaited', () => {
    const { press, sent, sidePanel } = setup();
    press(OPEN_CHAT_COMMAND, { id: 4, url: PR, windowId: 1 });
    expect(sidePanel!.open).toHaveBeenCalledWith({ tabId: 4 });
    expect(sent).toEqual([]);
  });

  it('sends Open chat to the page, with the reason, when Chrome refuses the side panel', async () => {
    const sidePanel = { open: vi.fn(async () => Promise.reject(new Error('No user gesture'))) };
    const { press, sent } = setup({ sidePanel });
    press(OPEN_CHAT_COMMAND, { id: 4, url: PR });
    await flush();
    expect(sent.map((s) => s.message)).toEqual([
      { type: 'pr-explainer:command', command: 'open-chat', reason: 'No user gesture' },
    ]);
  });

  it('sends Open chat to the page when Chat opens in is On the page', () => {
    const { press, sent, sidePanel } = setup({ place: 'page' });
    press(OPEN_CHAT_COMMAND, { id: 4, url: PR });
    expect(sidePanel!.open).not.toHaveBeenCalled();
    expect(sent.map((s) => s.message)).toEqual([
      { type: 'pr-explainer:command', command: 'open-chat' },
    ]);
  });

  it('survives a tab with no content script yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { press, tabs } = setup();
    vi.mocked(tabs.sendMessage).mockRejectedValueOnce(new Error('Receiving end does not exist.'));
    press(EXPLAIN_COMMAND, { id: 4, url: PR });
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing without chrome.commands', () => {
    const { tabs } = fakeTabs();
    expect(() =>
      setupCommands({ commands: undefined, tabs, sidePanel: undefined, chatPlace: () => 'page' }),
    ).not.toThrow();
  });
});

describe('followChatPlace', () => {
  function fakeChanged() {
    const listeners: Parameters<StorageChangedLike['addListener']>[0][] = [];
    return {
      onChanged: { addListener: (l: (typeof listeners)[number]) => void listeners.push(l) },
      fire: (value: unknown) =>
        listeners.forEach((l) => l({ 'settings.chatOpensIn': { newValue: value } }, 'sync')),
    };
  }

  it('is Side panel until read, then follows the stored value and each save', async () => {
    const { onChanged, fire } = fakeChanged();
    const place = followChatPlace(
      { get: async () => ({ 'settings.chatOpensIn': 'page' }) },
      onChanged,
    );
    expect(place.current()).toBe('sidepanel');
    await flush();
    expect(place.current()).toBe('page');
    fire('sidepanel');
    expect(place.current()).toBe('sidepanel');
  });

  it('lets a save made before the read win', async () => {
    const { onChanged, fire } = fakeChanged();
    const place = followChatPlace(
      { get: async () => ({ 'settings.chatOpensIn': 'sidepanel' }) },
      onChanged,
    );
    fire('page');
    await flush();
    expect(place.current()).toBe('page');
  });
});

describe('listenForTabCommands', () => {
  function setupPage() {
    let listener: MessageListener = () => false;
    const runtime = {
      id: 'ext',
      onMessage: { addListener: (l: MessageListener) => void (listener = l) },
    };
    const handlers = { explain: vi.fn(), explainAtPointer: vi.fn(), openChat: vi.fn() };
    listenForTabCommands(runtime, handlers);
    const send = (message: unknown, id = 'ext') => listener(message, { id }, () => {});
    return { handlers, send };
  }

  it('runs each command from the extension', () => {
    const { handlers, send } = setupPage();
    send({ type: 'pr-explainer:command', command: 'explain' });
    send({ type: 'pr-explainer:command', command: 'explain-at-pointer' });
    send({ type: 'pr-explainer:command', command: 'open-chat', reason: 'why' });
    expect(handlers.explain).toHaveBeenCalledTimes(1);
    expect(handlers.explainAtPointer).toHaveBeenCalledTimes(1);
    expect(handlers.openChat).toHaveBeenCalledWith('why');
  });

  it('ignores other messages and other extensions', () => {
    const { handlers, send } = setupPage();
    send({ type: 'pr-explainer:command', command: 'explain' }, 'another-extension');
    send({ type: 'something-else', command: 'explain' });
    send('explain');
    send(null);
    expect(handlers.explain).not.toHaveBeenCalled();
  });
});
