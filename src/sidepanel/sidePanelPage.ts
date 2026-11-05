// The chat in Chrome's side panel (PR 11.8): src/sidepanel.html.
//
// The side panel sits next to the page, so the chat covers no code, and it
// stays open while GitHub moves between the PR's tabs. It is one page for
// the whole window, so it follows the active tab: it connects to that tab's
// GitHub page with chrome.tabs.connect, which answers with its chat for the
// PR, or says it has none (src/chat/sidePanelChat.ts). Moving to another tab
// tells the old page (`detach`) and connects to the new one; a page that
// reloads is connected to again once it has loaded.
//
// The chat is drawn with the same panel as on the page (src/chat/chatPanel.ts,
// `layout: 'fill'`), in GitHub's light or dark mode as the page reports it.
// What the user does in it (a question, Stop, New chat, close) is sent to the
// page, which keeps the conversation and asks the model as before.
//
// It must not share code with the content script inside one Vite build (see
// src/content.ts), so vite.config.ts builds it on its own. Chrome's APIs are
// passed in so the tests can use fakes.

import { openChatPanel, type ChatMessageView, type ChatPanel } from '../chat/chatPanel';
import type {
  SidePanelAction,
  SidePanelChat,
  SidePanelPortName,
  SidePanelUpdate,
} from '../chat/sidePanelProtocol';
import type { PortLike } from '../messaging/protocol';
import type { Theme } from '../theme';

const PORT_NAME: SidePanelPortName = 'pr-explainer:sidepanel';

/** Shown when the tab is not on GitHub, or not on a PR. */
export const NOT_ON_PR =
  'Open a pull request on GitHub, click a line, and choose Ask a question to chat about it here.';
/** Shown on a PR that has no chat yet. */
export const NO_CHAT_YET =
  'Click a line in this pull request and choose Ask a question. The chat shows here, next to the code.';

export interface TabLike {
  id?: number;
  url?: string;
  windowId?: number;
}

/** The parts of chrome.tabs the side panel uses. */
export interface SidePanelTabs {
  query(info: { active: true; currentWindow: true }): Promise<TabLike[]>;
  connect(tabId: number, info: { name: string }): PortLike;
  onActivated: {
    addListener(listener: (info: { tabId: number; windowId: number }) => void): void;
  };
  onUpdated: {
    addListener(
      listener: (
        tabId: number,
        changeInfo: { status?: string; url?: string },
        tab?: TabLike,
      ) => void,
    ): void;
  };
}

/** Whether the content script runs on `url` (public/manifest.json). */
export function isGitHubPage(url: string | undefined): boolean {
  return url?.startsWith('https://github.com/') === true;
}

export interface SidePanelPage {
  /** The tab it shows now. */
  readonly tabId: number | undefined;
  /** The chat it draws, if any. */
  readonly chat: ChatPanel | null;
  /** Finds the active tab and connects to it; resolves once done. */
  ready: Promise<void>;
}

export function createSidePanelPage(
  doc: Document,
  tabs: SidePanelTabs,
  options: { now?: () => number } = {},
): SidePanelPage {
  const emptyEl = doc.createElement('p');
  emptyEl.className = 'empty';
  emptyEl.setAttribute('role', 'status');
  doc.body.append(emptyEl);

  let windowId: number | undefined;
  let tabId: number | undefined;
  let port: PortLike | null = null;
  let panel: ChatPanel | null = null;
  let views = new Map<number, ChatMessageView>();
  // Set while the side panel closes its own chat, so it does not tell the page.
  let quiet = false;

  const setTheme = (theme: Theme | undefined) => {
    if (theme) doc.documentElement.dataset.theme = theme;
    else delete doc.documentElement.dataset.theme;
  };
  const closePanel = () => {
    quiet = true;
    panel?.close();
    quiet = false;
    panel = null;
    views = new Map();
  };
  const showEmpty = (text: string, theme?: Theme) => {
    closePanel();
    setTheme(theme);
    emptyEl.textContent = text;
    emptyEl.hidden = false;
  };
  const send = (action: SidePanelAction) => {
    try {
      port?.postMessage(action);
    } catch {
      // The page went away; its disconnect says so.
    }
  };

  const showChat = (update: SidePanelChat) => {
    closePanel();
    setTheme(update.theme);
    emptyEl.hidden = true;
    // The answer being written, if it is held back until it ends (PR 9.6).
    // It is the last answer, even when a note for code clicked meanwhile
    // (PR 5.4) comes after it (review on #77).
    const lastAnswer = [...update.entries]
      .reverse()
      .find((entry) => entry.kind === 'message' && entry.role === 'assistant');
    const holding =
      update.busy && !update.streamAnswers && lastAnswer?.kind === 'message'
        ? lastAnswer
        : undefined;
    panel = openChatPanel(
      {
        subject: update.subject,
        messages: update.entries.map((entry) =>
          entry.kind === 'note'
            ? { role: 'note' as const, text: entry.text }
            : { role: entry.role, text: entry === holding ? '' : entry.text },
        ),
        onSend: (question) => send({ type: 'send', question }),
        onStop: () => send({ type: 'stop' }),
        onNewChat: () => send({ type: 'newChat' }),
        onClose: () => {
          if (!quiet) send({ type: 'close' });
        },
        streamAnswers: update.streamAnswers,
        layout: 'fill',
        theme: update.theme,
        ...(options.now && { now: options.now }),
      },
      doc,
    );
    const shown = panel.messages;
    let i = 0;
    for (const entry of update.entries) {
      if (entry.kind !== 'message') continue;
      const view = shown[i++];
      if (!view) continue;
      views.set(entry.id, view);
      if (entry.status === 'failed' && entry.error)
        view.showError(entry.error.message, entry.error.fix);
      else if (entry.status === 'stopped') view.showStopped();
    }
    if (update.busy) panel.setBusy(true);
    if (holding) views.get(holding.id)?.update(holding.text);
    if (update.opened) panel.focus();
  };

  const render = (update: SidePanelUpdate) => {
    if (update.type === 'chat') return showChat(update);
    if (update.type === 'empty')
      return showEmpty(update.onPr ? NO_CHAT_YET : NOT_ON_PR, update.theme);
    if (update.type === 'theme') {
      setTheme(update.theme);
      if (panel) panel.host.dataset.theme = update.theme;
      return;
    }
    if (!panel) return;
    switch (update.type) {
      case 'add':
        views.set(update.id, panel.addMessage(update.role, update.text));
        return;
      case 'update':
        views.get(update.id)?.update(update.text);
        return;
      case 'error':
        views.get(update.id)?.showError(update.message, update.fix);
        return;
      case 'stopped':
        views.get(update.id)?.showStopped();
        return;
      case 'note':
        panel.addNote(update.text);
        return;
      case 'clear':
        panel.clear();
        views = new Map();
        return;
      case 'subject':
        panel.setSubject(update.subject);
        return;
      case 'busy':
        panel.setBusy(update.busy);
        return;
      case 'focus':
        panel.focus();
        return;
    }
  };

  const leave = () => {
    const old = port;
    port = null;
    if (!old) return;
    try {
      old.postMessage({ type: 'detach' } satisfies SidePanelAction);
      old.disconnect();
    } catch {
      // Already gone.
    }
  };

  const follow = (tab: TabLike | undefined) => {
    if (tab?.id !== undefined && tab.id === tabId && port) return;
    leave();
    tabId = tab?.id;
    if (tab?.id === undefined || !isGitHubPage(tab.url)) {
      showEmpty(NOT_ON_PR);
      return;
    }
    let next: PortLike;
    try {
      next = tabs.connect(tab.id, { name: PORT_NAME });
    } catch {
      showEmpty(NOT_ON_PR);
      return;
    }
    port = next;
    next.onMessage.addListener((message) => {
      if (port === next) render(message as SidePanelUpdate);
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      // The page reloaded or went away; it is connected to again once loaded.
      port = null;
      showEmpty(NOT_ON_PR);
    });
  };

  tabs.onActivated.addListener((info) => {
    if (windowId !== undefined && info.windowId !== windowId) return;
    void tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id === info.tabId) follow(tab);
    });
  });
  tabs.onUpdated.addListener((id, changeInfo, tab) => {
    if (id !== tabId || port || changeInfo.status !== 'complete') return;
    follow(tab ?? { id });
  });

  const ready = tabs.query({ active: true, currentWindow: true }).then(
    ([tab]) => {
      windowId = tab?.windowId;
      follow(tab);
    },
    () => showEmpty(NOT_ON_PR),
  );

  return {
    get tabId() {
      return tabId;
    },
    get chat() {
      return panel;
    },
    ready,
  };
}
