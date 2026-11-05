// The chat in Chrome's side panel (PR 11.8), on the GitHub page's side.
//
// With Chat opens in set to Side panel, Ask a question asks the
// service worker to open the side panel (`openSidePanel`) and the chat is
// drawn there instead of over the page. Chrome opens a side panel only in
// answer to something the user did, so the request is sent at once from the
// click. If Chrome refuses, or this Chrome has no side panel, the chat opens
// on the page as before and says why, once per page.
//
// The conversation itself stays here, with the same ChatSession and chat flow
// (src/chat/chatFlow.ts) as the on-page panel: openSidePanelChat returns a
// ChatPanel whose calls are kept as a list of what the chat shows and sent to
// the side panel page (src/sidepanel/sidePanelPage.ts) over its port
// (src/chat/sidePanelProtocol.ts). The side panel connects to whichever tab
// is active, gets the whole chat, and then each change. The chat counts as
// open while the side panel shows it (or is opening for it): clicking another
// line then adds it to the conversation (PR 5.4). When the side panel moves
// to another tab it is set aside, and shown again when it comes back; when
// the side panel is closed it closes, as closing the on-page panel does.
//
// The content script cannot import src/settings.ts (see src/content.ts), so
// the setting's key is copied here; settings.test.ts checks it matches.

import type { StorageChangedEvent } from '../enabledState';
import type { PortLike, PortRuntime } from '../messaging/protocol';
import type { SyncStorageLike } from '../prefetch';
import { trackSyncValue } from '../syncFlag';
import type { Theme } from '../theme';
import type {
  ChatMessageView,
  ChatPanel,
  ChatPanelOptions,
  ChatRole,
  ChatSubject,
} from './chatPanel';
import type {
  SidePanelAction,
  SidePanelEntry,
  SidePanelPortName,
  SidePanelUpdate,
} from './sidePanelProtocol';

const PORT_NAME: SidePanelPortName = 'pr-explainer:sidepanel';

/** The chrome.storage.sync key of Chat opens in (storageKey('chatOpensIn')). */
export const CHAT_PLACE_KEY = 'settings.chatOpensIn';

/** Where the chat opens, as in src/settings.ts. */
export type ChatPlace = 'sidepanel' | 'page';

/** The setting as stored: `sidepanel`, or `page` (the default, PR 11.13) for anything else. */
export function chatPlaceOf(stored: unknown): ChatPlace {
  return stored === 'sidepanel' ? 'sidepanel' : 'page';
}

/** Follows Chat opens in (src/syncFlag.ts). On the page until it is read. */
export function trackChatPlace(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
): { current(): ChatPlace } {
  return trackSyncValue(CHAT_PLACE_KEY, storage, events, chatPlaceOf);
}

/** What the service worker says to `openSidePanel`. */
export type OpenSidePanelResult = { opened: true } | { opened: false; reason: string };

/** Shown once in a chat that opened on the page because the side panel did not. */
export function fallbackNote(reason: string): string {
  const why = reason.trim().replace(/\.$/, '');
  return `Chrome did not open the side panel (${why}), so the chat is on the page.`;
}

export interface ChatOpenerDeps {
  /** Chat opens in, read for each chat. */
  place(): ChatPlace;
  /** Whether a side panel shows this tab now, so there is nothing to open. */
  sidePanelShown(): boolean;
  /** Asks the service worker to open the side panel for this tab. */
  openSidePanel(): Promise<OpenSidePanelResult>;
}

/**
 * Decides where each chat opens. The returned function calls `start` with
 * the place, and a note to show in the chat when the side panel did not open
 * (only the first time on this page). The side panel is asked for straight
 * away, from the click, as Chrome requires.
 */
export function createChatOpener(
  deps: ChatOpenerDeps,
): (start: (place: ChatPlace, note?: string) => void) => void {
  let told = false;
  const onPage = (reason: string, start: (place: ChatPlace, note?: string) => void) => {
    const note = told ? undefined : fallbackNote(reason);
    told = true;
    start('page', note);
  };
  return (start) => {
    if (deps.place() === 'page') return start('page');
    if (deps.sidePanelShown()) return start('sidepanel');
    deps.openSidePanel().then(
      (result) => (result.opened ? start('sidepanel') : onPage(result.reason, start)),
      (error: unknown) => onPage(error instanceof Error ? error.message : String(error), start),
    );
  };
}

export interface SidePanelLinkDeps {
  runtime: Pick<PortRuntime, 'onConnect'>;
  /** The page's light or dark mode now (src/theme.ts). */
  theme(): Theme;
  /** Whether the page is a PR, for the side panel's text when there is no chat. */
  onPr(): boolean;
  /** For the detached elements of ChatPanel.messages. */
  doc?: Document;
}

export interface SidePanelLink {
  /** Whether a side panel is showing this tab now. */
  readonly shown: boolean;
  /** Opens a chat drawn in the side panel, closing any other one it shows. */
  open(options: ChatPanelOptions): ChatPanel;
  /** The open side panel chat, if any (see ChatPanel.isOpen). */
  current(): ChatPanel | null;
  /** Tells the side panel GitHub's light or dark mode changed. */
  themeChanged(theme: Theme): void;
  /** Tells the side panel the page moved (on or off a PR), when it has no chat. */
  pageChanged(): void;
}

interface SidePanelChat extends ChatPanel {
  snapshot(opened: boolean): SidePanelUpdate;
  act(action: SidePanelAction): void;
  /** Whether the side panel shows it (false once it moved to another tab). */
  shown: boolean;
  /** Whether a side panel has shown it yet (the first time, it takes focus). */
  seen: boolean;
}

/** Listens for the side panel connecting to this tab, and draws chats there. */
export function createSidePanelLink(deps: SidePanelLinkDeps): SidePanelLink {
  const doc = deps.doc ?? document;
  let port: PortLike | null = null;
  let chat: SidePanelChat | null = null;

  const post = (update: SidePanelUpdate) => {
    try {
      port?.postMessage(update);
    } catch {
      // The side panel went away; its disconnect says so.
    }
  };
  const empty = (): SidePanelUpdate => ({ type: 'empty', theme: deps.theme(), onPr: deps.onPr() });

  deps.runtime.onConnect.addListener((next) => {
    if (next.name !== PORT_NAME) return;
    // A side panel in another window takes over (one tab is active per window).
    const previous = port;
    port = next;
    if (previous && previous !== next) {
      try {
        previous.disconnect();
      } catch {
        // Already gone.
      }
    }
    if (chat) chat.shown = true;
    next.onMessage.addListener((message) => {
      if (port !== next) return;
      const action = message as SidePanelAction;
      if (action?.type === 'detach') {
        // The side panel moved to another tab: keep the chat for its return.
        port = null;
        if (chat) chat.shown = false;
        return;
      }
      chat?.act(action);
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      // The side panel was closed: the chat closes, as the on-page one does.
      port = null;
      chat?.close();
    });
    if (!chat) return post(empty());
    const first = !chat.seen;
    chat.seen = true;
    post(chat.snapshot(first));
  });

  const open = (options: ChatPanelOptions): ChatPanel => {
    const previous = chat;
    chat = null;
    previous?.close();
    let isOpen = true;
    let busy = false;
    let subject: ChatSubject = options.subject;
    let entries: SidePanelEntry[] = [];
    let nextId = 0;
    const views: ChatMessageView[] = [];

    const addMessage = (role: ChatRole, text: string, send = true): ChatMessageView => {
      const id = nextId++;
      const entry = { kind: 'message' as const, id, role, text } as Extract<
        SidePanelEntry,
        { kind: 'message' }
      >;
      entries.push(entry);
      const element = doc.createElement('div');
      element.textContent = text;
      const view: ChatMessageView = {
        element,
        role,
        update(next) {
          if (!isOpen) return;
          entry.text = next;
          element.textContent = next;
          post({ type: 'update', id, text: next });
        },
        showError(message, fix) {
          if (!isOpen) return;
          entry.status = 'failed';
          entry.error = { message, fix };
          element.textContent = `${message} ${fix}`;
          post({ type: 'error', id, message, fix });
        },
        showStopped() {
          if (!isOpen) return;
          entry.status = 'stopped';
          post({ type: 'stopped', id });
        },
      };
      views.push(view);
      if (send) post({ type: 'add', id, role, text });
      return view;
    };
    const addNote = (text: string) => {
      entries.push({ kind: 'note', text });
      post({ type: 'note', text });
    };
    for (const message of options.messages ?? []) {
      if (message.role === 'note') entries.push({ kind: 'note', text: message.text });
      else addMessage(message.role, message.text, false);
    }

    const panel: SidePanelChat = {
      host: doc.createElement('div'),
      shown: true,
      seen: port !== null,
      get isOpen() {
        return isOpen && this.shown;
      },
      get isBusy() {
        return busy;
      },
      get messages() {
        return [...views];
      },
      addMessage(role, text) {
        return addMessage(role, text, isOpen);
      },
      addNote(text) {
        if (isOpen) addNote(text);
      },
      clear() {
        if (!isOpen) return;
        entries = [];
        views.length = 0;
        post({ type: 'clear' });
      },
      setSubject(next) {
        if (!isOpen) return;
        subject = next;
        post({ type: 'subject', subject: next });
      },
      setBusy(next) {
        busy = next;
        if (isOpen) post({ type: 'busy', busy: next });
      },
      focus() {
        if (isOpen) post({ type: 'focus' });
      },
      close() {
        if (!isOpen) return;
        isOpen = false;
        if (chat === panel) {
          chat = null;
          post(empty());
        }
        options.onClose?.();
      },
      snapshot(opened) {
        return {
          type: 'chat',
          opened,
          subject,
          entries: entries.map((entry) => ({ ...entry })),
          busy,
          streamAnswers: options.streamAnswers === true,
          theme: deps.theme(),
        };
      },
      act(action) {
        if (!isOpen) return;
        switch (action?.type) {
          case 'send': {
            const question = typeof action.question === 'string' ? action.question.trim() : '';
            if (!question || busy) return;
            // The side panel showed the question itself.
            addMessage('user', question, false);
            options.onSend?.(question);
            return;
          }
          case 'stop':
            if (busy) options.onStop?.();
            return;
          case 'newChat':
            options.onNewChat?.();
            return;
          case 'close':
            panel.close();
            return;
        }
      },
    };
    chat = panel;
    post(panel.snapshot(true));
    return panel;
  };

  return {
    get shown() {
      return port !== null;
    },
    open,
    current: () => (chat?.isOpen ? chat : null),
    themeChanged(theme) {
      post({ type: 'theme', theme });
    },
    pageChanged() {
      if (!chat) post(empty());
    },
  };
}
