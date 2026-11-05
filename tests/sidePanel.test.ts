// The chat in Chrome's side panel (PR 11.8): opening it from Ask a question,
// the fallback when Chrome refuses, the toolbar menu's Open chat, and the
// side panel page drawing the conversation the GitHub page keeps, following
// the active tab's PR.
import { CurrentChat, startChat } from '../src/chat/chatFlow';
import type { ChatResult } from '../src/chat/chatHandler';
import { CHAT_PANEL_ID, type ChatPanel } from '../src/chat/chatPanel';
import { openChatFromShortcut, type ChatShortcutDeps } from '../src/chat/chatShortcut';
import { ChatSessions, type ChatSeed } from '../src/chat/chatSession';
import {
  createChatOpener,
  createSidePanelLink,
  fallbackNote,
  type ChatPlace,
  type SidePanelLink,
} from '../src/chat/sidePanelChat';
import type { ContextMenusLike } from '../src/debug/debugWindowOpener';
import type { ChatMessage } from '../src/llm/types';
import type { PortLike } from '../src/messaging/protocol';
import {
  CHAT_MENU_ID,
  CHAT_MENU_TITLE,
  openSidePanel,
  setupChatMenu,
  type SidePanelLike,
} from '../src/sidePanelOpener';
import {
  createSidePanelPage,
  NO_CHAT_YET,
  NOT_ON_PR,
  type SidePanelTabs,
  type TabLike,
} from '../src/sidepanel/sidePanelPage';
import type { Theme } from '../src/theme';

const PORT_NAME = 'pr-explainer:sidepanel';

const SEED: ChatSeed = {
  context: 'L14: export const LOCAL_HOSTS = new Set(["localhost"]);',
  explanation: {
    what: 'Lists the host names that count as this laptop.',
    why: 'The settings page only accepts a local LLM address.',
    concerns: 'None.',
  },
};
const SUBJECT = { filePath: 'src/settings.ts', startLine: 14 };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- Opening the side panel from Ask a question ---

describe('createChatOpener', () => {
  function opener(place: ChatPlace, shown: boolean, open: () => Promise<unknown>) {
    const openSidePanel = vi.fn(open) as unknown as () => Promise<
      { opened: true } | { opened: false; reason: string }
    >;
    const placeChat = createChatOpener({
      place: () => place,
      sidePanelShown: () => shown,
      openSidePanel,
    });
    return { placeChat, openSidePanel };
  }

  it('opens on the page, without asking for the side panel, when the setting says so', () => {
    const { placeChat, openSidePanel } = opener('page', false, async () => ({ opened: true }));
    const start = vi.fn();
    placeChat(start);
    expect(start).toHaveBeenCalledWith('page');
    expect(openSidePanel).not.toHaveBeenCalled();
  });

  it('asks for the side panel at once, from the click, and opens the chat there', async () => {
    const { placeChat, openSidePanel } = opener('sidepanel', false, async () => ({ opened: true }));
    const start = vi.fn();
    placeChat(start);
    // Asked before anything is awaited, so Chrome counts it as the user's action.
    expect(openSidePanel).toHaveBeenCalledTimes(1);
    await flush();
    expect(start).toHaveBeenCalledWith('sidepanel');
  });

  it('does not ask again while a side panel already shows the tab', () => {
    const { placeChat, openSidePanel } = opener('sidepanel', true, async () => ({ opened: true }));
    const start = vi.fn();
    placeChat(start);
    expect(start).toHaveBeenCalledWith('sidepanel');
    expect(openSidePanel).not.toHaveBeenCalled();
  });

  it('falls back to the page when Chrome refuses, and says why only the first time', async () => {
    const reason = '`sidePanel.open()` may only be called in response to a user gesture.';
    const { placeChat } = opener('sidepanel', false, async () => ({ opened: false, reason }));
    const start = vi.fn();
    placeChat(start);
    await flush();
    expect(start).toHaveBeenLastCalledWith('page', fallbackNote(reason));
    expect(fallbackNote(reason)).toBe(
      'Chrome did not open the side panel (`sidePanel.open()` may only be called in response ' +
        'to a user gesture), so the chat is on the page.',
    );
    placeChat(start);
    await flush();
    expect(start).toHaveBeenLastCalledWith('page', undefined);
  });

  it('falls back to the page when the service worker does not answer', async () => {
    const { placeChat } = opener('sidepanel', false, async () => {
      throw new Error('Could not reach the service worker');
    });
    const start = vi.fn();
    placeChat(start);
    await flush();
    expect(start).toHaveBeenCalledWith('page', fallbackNote('Could not reach the service worker'));
  });
});

describe('openSidePanel (service worker)', () => {
  it('calls chrome.sidePanel.open for the tab before returning', async () => {
    const open = vi.fn(async () => {});
    const result = openSidePanel({ open }, { tabId: 7 });
    expect(open).toHaveBeenCalledWith({ tabId: 7 });
    await expect(result).resolves.toEqual({ opened: true });
  });

  it('answers with the reason when Chrome refuses', async () => {
    const open = vi.fn(async () => {
      throw new Error('may only be called in response to a user gesture');
    });
    await expect(openSidePanel({ open }, { tabId: 7 })).resolves.toEqual({
      opened: false,
      reason: 'may only be called in response to a user gesture',
    });
    const throws: SidePanelLike = {
      open: () => {
        throw new Error('No active side panel');
      },
    };
    await expect(openSidePanel(throws, { windowId: 2 })).resolves.toEqual({
      opened: false,
      reason: 'No active side panel',
    });
  });

  it('says so on a Chrome with no side panel, or with no tab', async () => {
    await expect(openSidePanel(undefined, { tabId: 7 })).resolves.toEqual({
      opened: false,
      reason: 'this version of Chrome has no side panel',
    });
    await expect(openSidePanel({ open: vi.fn() }, undefined)).resolves.toEqual({
      opened: false,
      reason: 'no tab to open it for',
    });
  });
});

describe('setupChatMenu', () => {
  function fakeMenus() {
    const clicks: Parameters<ContextMenusLike['onClicked']['addListener']>[0][] = [];
    const menus = {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      update: vi.fn(async () => {}),
      onClicked: { addListener: (l: (typeof clicks)[number]) => void clicks.push(l) },
    };
    return { menus, clicks };
  }
  function fakeChanged() {
    const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] =
      [];
    return {
      onChanged: { addListener: (l: (typeof listeners)[number]) => void listeners.push(l) },
      fire: (changes: Record<string, { newValue?: unknown }>, area = 'sync') =>
        listeners.forEach((l) => l(changes, area)),
    };
  }

  it('adds Open chat after the debug item, shown while the chat opens in the side panel', async () => {
    const { menus } = fakeMenus();
    const { onChanged, fire } = fakeChanged();
    let debugDone!: () => void;
    const after = new Promise<void>((resolve) => (debugDone = resolve));
    const made = setupChatMenu({
      menus,
      sidePanel: { open: vi.fn(async () => {}) },
      onChanged,
      isOn: async () => true,
      after,
    });
    await flush();
    // Not before the debug menu's removeAll.
    expect(menus.create).not.toHaveBeenCalled();
    debugDone();
    await made;
    expect(menus.create).toHaveBeenCalledWith({
      id: CHAT_MENU_ID,
      title: CHAT_MENU_TITLE,
      contexts: ['action'],
      visible: true,
    });
    fire({ 'settings.chatOpensIn': { newValue: 'page' } });
    await flush();
    expect(menus.update).toHaveBeenLastCalledWith(CHAT_MENU_ID, { visible: false });
    fire({ 'settings.chatOpensIn': { newValue: 'sidepanel' } });
    await flush();
    expect(menus.update).toHaveBeenLastCalledWith(CHAT_MENU_ID, { visible: true });
  });

  it('opens the side panel in the clicked window at once', () => {
    const { menus, clicks } = fakeMenus();
    const open = vi.fn(async () => {});
    void setupChatMenu({
      menus,
      sidePanel: { open },
      onChanged: fakeChanged().onChanged,
      isOn: async () => true,
      after: Promise.resolve(),
    });
    clicks.forEach((l) => l({ menuItemId: 'open-debug-window' }, { windowId: 3 }));
    expect(open).not.toHaveBeenCalled();
    clicks.forEach((l) => l({ menuItemId: CHAT_MENU_ID }, { windowId: 3 }));
    expect(open).toHaveBeenCalledWith({ windowId: 3 });
  });
});

// --- The side panel page and the GitHub page together ---

interface FakePort extends PortLike {
  connected: boolean;
  messages: unknown[];
  /** The other end. */
  other?: FakePort;
}

/** Two ends of a chrome port: a message posted on one arrives on the other. */
function portPair(name: string): [FakePort, FakePort] {
  const make = (): FakePort & {
    deliver(m: unknown): void;
    disconnected(): void;
    other?: FakePort & { deliver(m: unknown): void; disconnected(): void };
  } => {
    const onMessage: ((m: unknown) => void)[] = [];
    const onDisconnect: (() => void)[] = [];
    const end = {
      name,
      connected: true,
      messages: [] as unknown[],
      postMessage(message: unknown) {
        if (!end.connected) throw new Error('Attempting to use a disconnected port object');
        end.other!.deliver(structuredClone(message));
      },
      disconnect() {
        if (!end.connected) return;
        end.connected = false;
        end.other!.connected = false;
        // Chrome tells only the other end.
        end.other!.disconnected();
      },
      onMessage: { addListener: (l: (m: unknown) => void) => void onMessage.push(l) },
      onDisconnect: { addListener: (l: () => void) => void onDisconnect.push(l) },
      deliver(message: unknown) {
        end.messages.push(message);
        onMessage.forEach((l) => l(message));
      },
      disconnected() {
        onDisconnect.forEach((l) => l());
      },
    } as FakePort & {
      deliver(m: unknown): void;
      disconnected(): void;
      other?: FakePort & { deliver(m: unknown): void; disconnected(): void };
    };
    return end;
  };
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a, b];
}

/** A GitHub tab: its content script's side panel link and chats. */
interface FakePage {
  id: number;
  url: string;
  link: SidePanelLink;
  connects: ((port: PortLike) => void)[];
  theme: Theme;
  /** The page end of the side panel's port, while connected. */
  port?: FakePort;
}

/** Tabs in one window, and the side panel's chrome.tabs. */
function fakeBrowser() {
  const pages = new Map<number, FakePage>();
  const tabs: TabLike[] = [];
  let active: number | undefined;
  const activated: ((info: { tabId: number; windowId: number }) => void)[] = [];
  const updated: ((tabId: number, changeInfo: { status?: string }, tab?: TabLike) => void)[] = [];

  const addPage = (id: number, url: string, theme: Theme = 'light'): FakePage => {
    const connects: ((port: PortLike) => void)[] = [];
    const page: FakePage = {
      id,
      url,
      connects,
      theme,
      link: createSidePanelLink({
        runtime: { onConnect: { addListener: (l) => void connects.push(l) } },
        theme: () => page.theme,
        onPr: () => /\/pull\/\d+/.test(page.url),
      }),
    };
    pages.set(id, page);
    if (!tabs.some((t) => t.id === id)) tabs.push({ id, url, windowId: 1 });
    return page;
  };

  const sideTabs: SidePanelTabs = {
    query: async () => tabs.filter((t) => t.id === active),
    connect: (tabId, info) => {
      // The page listens for this name only (src/chat/sidePanelChat.ts).
      if (info.name !== PORT_NAME) throw new Error(`unexpected port ${info.name}`);
      const [sideEnd, pageEnd] = portPair(info.name);
      const page = pages.get(tabId);
      if (!page) {
        // No content script: Chrome closes the port at once.
        queueMicrotask(() => pageEnd.disconnect());
        return sideEnd;
      }
      page.port = pageEnd;
      // The page hears of it after connect returns, as in Chrome.
      queueMicrotask(() => page.connects.forEach((l) => l(pageEnd)));
      return sideEnd;
    },
    onActivated: { addListener: (l) => void activated.push(l) },
    onUpdated: { addListener: (l) => void updated.push(l) },
  };

  return {
    pages,
    addPage,
    addTab: (id: number, url: string) => tabs.push({ id, url, windowId: 1 }),
    sideTabs,
    activate: async (id: number) => {
      active = id;
      activated.forEach((l) => l({ tabId: id, windowId: 1 }));
      await flush();
    },
    /** The page reloads: its content script and chats go, and a new one loads. */
    reload: async (id: number) => {
      const old = pages.get(id)!;
      old.port?.disconnect();
      pages.delete(id);
      const page = addPage(id, old.url, old.theme);
      updated.forEach((l) => l(id, { status: 'complete' }, { id, url: old.url, windowId: 1 }));
      await flush();
      return page;
    },
    setActive: (id: number) => (active = id),
  };
}

/** Waits for the side panel page to find the tab and hear from its page. */
async function opened(side: { ready: Promise<void> }): Promise<void> {
  await side.ready;
  await flush();
}

/** The side panel's own document, apart from the GitHub page's. */
function sidePanelDocument(): Document {
  return document.implementation.createHTMLDocument('PR Explainer chat');
}

interface Asked {
  messages: ChatMessage[];
  chunk(text: string): void;
  resolve(result: ChatResult): void;
  stop: ReturnType<typeof vi.fn>;
}

/** Starts a chat the way content.ts does, drawn in the side panel. */
function chatIn(page: FakePage, sessions = new ChatSessions(), pr = 'owner/repo#1') {
  const asked: Asked[] = [];
  const session = sessions.get(pr) ?? sessions.restart(pr, SEED);
  const chat = startChat(
    {
      ask: (messages, onChunk) => {
        let resolve!: (result: ChatResult) => void;
        const result = new Promise<ChatResult>((res) => (resolve = res));
        const stop = vi.fn();
        asked.push({ messages, chunk: onChunk, resolve, stop });
        return { result, stop };
      },
      openPanel: (options) => page.link.open({ ...options, streamAnswers: true }),
    },
    session,
    SUBJECT,
  );
  return { chat, asked, session, sessions };
}

function inSidePanel(doc: Document) {
  const root = () => doc.getElementById(CHAT_PANEL_ID)?.shadowRoot ?? null;
  return {
    root,
    shown: () =>
      [...(root()?.querySelectorAll<HTMLElement>('.message, .note') ?? [])].map((el) =>
        el.classList.contains('note')
          ? ['note', el.textContent]
          : [el.dataset.role, el.textContent],
      ),
    empty: () => {
      const el = doc.querySelector<HTMLElement>('.empty');
      return el && !el.hidden ? el.textContent : null;
    },
    subject: () => root()?.querySelector('.subject')?.textContent,
    ask: (question: string) => {
      const input = root()!.querySelector<HTMLTextAreaElement>('.input')!;
      input.value = question;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root()!.querySelector<HTMLFormElement>('.composer')!.requestSubmit();
    },
    click: (selector: string) => root()!.querySelector<HTMLButtonElement>(selector)!.click(),
  };
}

describe('side panel chat', () => {
  it('shows the chat opened from Ask a question once the side panel loads', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    // Ask a question: the chat starts before the side panel has loaded.
    const { chat } = chatIn(page);
    expect(chat.isOpen).toBe(true);

    const doc = sidePanelDocument();
    const side = createSidePanelPage(doc, browser.sideTabs);
    await opened(side);
    const view = inSidePanel(doc);
    expect(view.empty()).toBeNull();
    expect(view.shown()).toHaveLength(1);
    expect(view.shown()[0]?.[0]).toBe('assistant');
    expect(view.subject()).toContain('src/settings.ts');
    expect(doc.getElementById(CHAT_PANEL_ID)?.dataset.layout).toBe('fill');
    expect(view.shown()[0]?.[1]).toContain(SEED.explanation.what);
    expect(page.link.shown).toBe(true);
  });

  it('sends a question from the side panel and shows the answer as the page gets it', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    const view = inSidePanel(doc);
    expect(view.empty()).toBe(NO_CHAT_YET);

    const { asked, session } = chatIn(page);
    view.ask('Why a Set?');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'Why a Set?' });
    asked[0]!.chunk('Lookups are fast.');
    asked[0]!.resolve({ status: 'done', answer: 'Lookups are fast.', model: 'm' });
    await flush();
    expect(view.shown().slice(1)).toEqual([
      ['user', 'Why a Set?'],
      ['assistant', 'Lookups are fast.'],
    ]);
    expect(session.turns).toEqual([{ question: 'Why a Set?', answer: 'Lookups are fast.' }]);
  });

  it('passes Stop and New chat to the page, and closing the chat shows the empty text', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1');
    browser.setActive(1);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    const view = inSidePanel(doc);
    const { chat, asked, session } = chatIn(page);

    view.ask('Why?');
    asked[0]!.chunk('Because');
    view.click('.stop');
    expect(asked[0]!.stop).toHaveBeenCalled();
    expect(chat.isBusy).toBe(false);
    expect(session.turns).toHaveLength(1);

    view.click('.new-chat');
    expect(session.turns).toHaveLength(0);
    expect(view.shown()).toHaveLength(1);

    view.click('.close');
    expect(chat.isOpen).toBe(false);
    expect(view.empty()).toBe(NO_CHAT_YET);
  });

  it('adds another clicked line to the same conversation', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    const view = inSidePanel(doc);
    const { chat, asked } = chatIn(page);
    const current = new CurrentChat();
    current.set(chat, 'owner/repo#1');

    const next = { filePath: 'src/llm/retry.ts', startLine: 3, endLine: 5 };
    expect(current.addCode('owner/repo#1', 'L3: retry()', next)).toBe(true);
    expect(view.subject()).toContain('src/llm/retry.ts');
    expect(view.shown().at(-1)).toEqual(['note', 'Now looking at src/llm/retry.ts lines 3 to 5']);
    view.ask('And this?');
    expect(asked[0]!.messages.at(-1)?.content).toContain('L3: retry()');
  });

  it('follows the active tab, showing each PR its own conversation', async () => {
    const browser = fakeBrowser();
    const first = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    const second = browser.addPage(2, 'https://github.com/owner/repo/pull/2/files', 'dark');
    browser.setActive(1);
    const doc = sidePanelDocument();
    const side = createSidePanelPage(doc, browser.sideTabs);
    await opened(side);
    const view = inSidePanel(doc);
    const one = chatIn(first, new ChatSessions(), 'owner/repo#1');
    view.ask('About PR 1?');
    one.asked[0]!.resolve({ status: 'done', answer: 'Yes, PR 1.', model: 'm' });
    await flush();

    await browser.activate(2);
    expect(side.tabId).toBe(2);
    // The first page was told, so its chat waits for the side panel's return.
    expect(first.port?.connected).toBe(false);
    expect(one.chat.isOpen).toBe(false);
    expect(view.empty()).toBe(NO_CHAT_YET);
    expect(doc.documentElement.dataset.theme).toBe('dark');
    const two = chatIn(second, new ChatSessions(), 'owner/repo#2');
    expect(view.shown()).toHaveLength(1);

    await browser.activate(1);
    expect(one.chat.isOpen).toBe(true);
    expect(view.shown().slice(1)).toEqual([
      ['user', 'About PR 1?'],
      ['assistant', 'Yes, PR 1.'],
    ]);
    expect(two.chat.isOpen).toBe(false);
  });

  it('closes the chat when the side panel is closed, so a click explains in the popup', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    const { chat, asked, session, sessions } = chatIn(page);
    const current = new CurrentChat();
    current.set(chat, 'owner/repo#1');
    inSidePanel(doc).ask('Still there?');

    // Chrome closes the side panel: its end of the port goes.
    page.port!.other!.disconnect();
    expect(chat.isOpen).toBe(false);
    expect(asked[0]!.stop).toHaveBeenCalled();
    expect(page.link.current()).toBeNull();
    expect(current.addCode('owner/repo#1', 'L9: x', { filePath: 'a.ts', startLine: 9 })).toBe(
      false,
    );
    // The PR keeps its conversation for the next chat.
    expect(sessions.get('owner/repo#1')).toBe(session);
  });

  // The Open chat shortcut (PR 11.9): the service worker opens the side
  // panel, then the page draws the PR's kept conversation in it (review on #78).
  describe('the Open chat shortcut', () => {
    const PR = 'owner/repo#1';
    /** What content.ts passes: the page's sessions and the chat open in each place. */
    function shortcutDeps(page: FakePage, sessions: ChatSessions, onPage: ChatPanel | null = null) {
      const shown: { place: string; note?: string }[] = [];
      const deps: ChatShortcutDeps = {
        pr: () => PR,
        sessions,
        subjects: new Map([[PR, SUBJECT]]),
        openChat: (place) => (place === 'sidepanel' ? page.link.current() : onPage),
        show: (place, pr, session, subject, note) => {
          expect([pr, subject, session]).toEqual([PR, SUBJECT, sessions.get(PR)]);
          shown.push({ place, ...(note !== undefined && { note }) });
          if (place === 'sidepanel') chatIn(page, sessions, pr);
        },
      };
      return { deps, shown };
    }

    /** A PR whose side panel chat had a question answered, then was closed. */
    async function closedConversation() {
      const browser = fakeBrowser();
      const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
      browser.setActive(1);
      const first = sidePanelDocument();
      await opened(createSidePanelPage(first, browser.sideTabs));
      const { asked, sessions } = chatIn(page);
      inSidePanel(first).ask('Why a Set?');
      asked[0]!.resolve({ status: 'done', answer: 'Lookups are fast.', model: 'm' });
      await flush();
      page.port!.other!.disconnect();
      expect(page.link.current()).toBeNull();
      return { browser, page, sessions };
    }

    it('reopens a closed PR conversation in the side panel Chrome just opened', async () => {
      const { browser, page, sessions } = await closedConversation();
      // Chrome opens a new side panel, which first shows the empty text...
      const doc = sidePanelDocument();
      await opened(createSidePanelPage(doc, browser.sideTabs));
      expect(inSidePanel(doc).empty()).toBe(NO_CHAT_YET);
      // ...then the page hears the command and draws the conversation there.
      const { deps, shown } = shortcutDeps(page, sessions);
      expect(openChatFromShortcut(deps, { sidePanel: true })).toBe('reopened');
      await flush();
      expect(shown).toEqual([{ place: 'sidepanel' }]);
      expect(inSidePanel(doc).empty()).toBeNull();
      expect(inSidePanel(doc).shown().slice(1)).toEqual([
        ['user', 'Why a Set?'],
        ['assistant', 'Lookups are fast.'],
      ]);
      expect(page.link.current()).not.toBeNull();
    });

    it('focuses the side panel chat that is already open instead', async () => {
      const browser = fakeBrowser();
      const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
      browser.setActive(1);
      await opened(createSidePanelPage(sidePanelDocument(), browser.sideTabs));
      const { sessions } = chatIn(page);
      const focus = vi.spyOn(page.link.current()!, 'focus');
      const { deps, shown } = shortcutDeps(page, sessions);
      expect(openChatFromShortcut(deps, { sidePanel: true })).toBe('focused');
      expect(focus).toHaveBeenCalled();
      expect(shown).toEqual([]);
    });

    it('reopens it on the page, with why, when Chrome refused the side panel', async () => {
      const { page, sessions } = await closedConversation();
      const { deps, shown } = shortcutDeps(page, sessions);
      expect(openChatFromShortcut(deps, { reason: 'No user gesture' })).toBe('reopened');
      expect(shown).toEqual([{ place: 'page', note: fallbackNote('No user gesture') }]);
    });

    it('has nothing to open on a PR with no conversation yet', () => {
      const browser = fakeBrowser();
      const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
      const { deps, shown } = shortcutDeps(page, new ChatSessions());
      expect(openChatFromShortcut(deps, { sidePanel: true })).toBe('nothing');
      expect(openChatFromShortcut(deps, {})).toBe('nothing');
      expect(shown).toEqual([]);
    });
  });

  it('says what to do on a tab that is not a GitHub PR', async () => {
    const browser = fakeBrowser();
    browser.addTab(5, 'https://example.com/');
    browser.addPage(6, 'https://github.com/owner/repo');
    browser.setActive(5);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    expect(inSidePanel(doc).empty()).toBe(NOT_ON_PR);
    await browser.activate(6);
    expect(inSidePanel(doc).empty()).toBe(NOT_ON_PR);
  });

  it('connects again when the page reloads', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    const doc = sidePanelDocument();
    const side = createSidePanelPage(doc, browser.sideTabs);
    await opened(side);
    chatIn(page);
    expect(side.chat).not.toBeNull();
    const reloaded = await browser.reload(1);
    // A reload loses the tab's chats, as before PR 11.8.
    expect(side.chat).toBeNull();
    expect(inSidePanel(doc).empty()).toBe(NO_CHAT_YET);
    expect(reloaded.link.shown).toBe(true);
  });

  it("follows GitHub's light or dark mode", async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files', 'dark');
    browser.setActive(1);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    chatIn(page);
    const host = () => doc.getElementById(CHAT_PANEL_ID)!;
    expect(host().dataset.theme).toBe('dark');
    page.link.themeChanged('light');
    expect(host().dataset.theme).toBe('light');
    expect(doc.documentElement.dataset.theme).toBe('light');
  });

  it('holds back an answer being written when the side panel connects mid-answer', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    let resolve!: (result: ChatResult) => void;
    let chunk!: (text: string) => void;
    const session = new ChatSessions().restart('owner/repo#1', SEED);
    const chat = startChat(
      {
        ask: (_messages, onChunk) => {
          chunk = onChunk;
          return { result: new Promise<ChatResult>((res) => (resolve = res)), stop: vi.fn() };
        },
        // Show answers as they are written off (the default).
        openPanel: (options) => page.link.open({ ...options, streamAnswers: false }),
      },
      session,
      SUBJECT,
    );
    expect(chat.isOpen).toBe(true);
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    inSidePanel(doc).ask('Why?');
    chunk('Half an');
    // The side panel moves away and back (a new page, as after a restart): it
    // gets the answer so far, held back until it ends.
    page.port!.other!.postMessage({ type: 'detach' });
    page.port!.other!.disconnect();
    const doc2 = sidePanelDocument();
    await opened(createSidePanelPage(doc2, browser.sideTabs));
    const later = inSidePanel(doc2);
    const last = () => later.shown().at(-1);
    expect(last()?.[1]).toBe('');
    chunk(' answer.');
    resolve({ status: 'done', answer: 'Half an answer.', model: 'm' });
    await flush();
    expect(last()).toEqual(['assistant', 'Half an answer.']);
  });

  it('holds back the answer being written when a clicked line was noted after it (review on #77)', async () => {
    const browser = fakeBrowser();
    const page = browser.addPage(1, 'https://github.com/owner/repo/pull/1/files');
    browser.setActive(1);
    let resolve!: (result: ChatResult) => void;
    let chunk!: (text: string) => void;
    const session = new ChatSessions().restart('owner/repo#1', SEED);
    const chat = startChat(
      {
        ask: (_messages, onChunk) => {
          chunk = onChunk;
          return { result: new Promise<ChatResult>((res) => (resolve = res)), stop: vi.fn() };
        },
        openPanel: (options) => page.link.open({ ...options, streamAnswers: false }),
      },
      session,
      SUBJECT,
    );
    const doc = sidePanelDocument();
    await opened(createSidePanelPage(doc, browser.sideTabs));
    inSidePanel(doc).ask('Why?');
    chunk('Half an');
    // Another line is clicked while the answer is written: its note follows the answer.
    expect(chat.addCode('L3: retry()', { filePath: 'src/llm/retry.ts', startLine: 3 })).toBe(true);
    // The side panel moves away and back.
    page.port!.other!.postMessage({ type: 'detach' });
    page.port!.other!.disconnect();
    const doc2 = sidePanelDocument();
    await opened(createSidePanelPage(doc2, browser.sideTabs));
    const later = inSidePanel(doc2);
    expect(later.shown().slice(-2)).toEqual([
      ['assistant', ''],
      ['note', 'Now looking at src/llm/retry.ts line 3'],
    ]);
    chunk(' answer.');
    resolve({ status: 'done', answer: 'Half an answer.', model: 'm' });
    await flush();
    expect(later.shown().slice(-2)).toEqual([
      ['assistant', 'Half an answer.'],
      ['note', 'Now looking at src/llm/retry.ts line 3'],
    ]);
  });
});
