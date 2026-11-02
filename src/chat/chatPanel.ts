// The chat panel (Milestone 5): a message list, a text box, and a Send button,
// docked in the bottom-right corner of the window. Like the popup
// (src/popup/popup.ts) it lives in a Shadow DOM root, so GitHub's CSS cannot
// restyle it and its CSS cannot leak into GitHub.
//
// The header names the file and lines being discussed. Questions are shown as
// plain text; answers are untrusted model output and are rendered with
// renderMarkdown, which never parses HTML. Enter sends, Shift+Enter starts a
// new line, and Send is disabled while the text box is empty or an answer is
// being written (setBusy). The list keeps the newest message in view, unless
// the user has scrolled up to read an older one.
//
// This PR adds only the UI. The panel does not talk to the LLM or keep the
// conversation: it reports each question through onSend, and the caller adds
// the answer with addMessage and fills it in with update. PR 5.3 opens it from
// the popup with a ChatSession (src/chat/chatSession.ts); until then only the
// demo page (`npm run demo:chat`) opens it.

import { renderMarkdown } from '../popup/renderMarkdown';
import { CHAT_PANEL_STYLE } from './chatPanelStyle';

export const CHAT_PANEL_ID = 'pr-explainer-chat';

/** What the chat is about: a file and one line or a block of lines. */
export interface ChatSubject {
  filePath: string;
  startLine: number;
  /** The last line of a selected block; leave out for a single line. */
  endLine?: number;
}

/** "line 42", or "lines 12 to 18" for a block. */
export function formatLines(subject: ChatSubject): string {
  const { startLine, endLine } = subject;
  return endLine === undefined || endLine === startLine
    ? `line ${startLine}`
    : `lines ${Math.min(startLine, endLine)} to ${Math.max(startLine, endLine)}`;
}

export type ChatRole = 'user' | 'assistant';

/** A message to show when the panel opens, such as the explanation and earlier turns. */
export interface ChatPanelMessage {
  role: ChatRole;
  text: string;
}

/** One message in the list. An answer is filled in with update as it streams. */
export interface ChatMessageView {
  readonly element: HTMLElement;
  readonly role: ChatRole;
  /** Replaces the message's text (markdown for an answer). */
  update(text: string): void;
}

export interface ChatPanelOptions {
  subject: ChatSubject;
  /** Shown before anything is typed, oldest first. */
  messages?: ChatPanelMessage[];
  /**
   * Called with the trimmed question after it has been added to the list and
   * the text box cleared.
   */
  onSend?: (question: string) => void;
  /** Called once when the panel closes, however it was closed. */
  onClose?: () => void;
}

export interface ChatPanel {
  readonly host: HTMLElement;
  readonly isOpen: boolean;
  /** The messages in the list, oldest first. */
  readonly messages: readonly ChatMessageView[];
  /** Adds a message at the bottom of the list. */
  addMessage(role: ChatRole, text: string): ChatMessageView;
  /** While busy (an answer is being written), Send and Enter do nothing. */
  setBusy(busy: boolean): void;
  /** Puts the cursor in the text box. */
  focus(): void;
  close(): void;
}

/** How close to the bottom (in pixels) still counts as reading the newest message. */
export const FOLLOW_SLACK = 24;

let current: ChatPanel | null = null;

/** The open chat panel, if any. */
export function currentChatPanel(): ChatPanel | null {
  return current;
}

/** Opens the chat panel, closing any other one. */
export function openChatPanel(options: ChatPanelOptions, doc: Document = document): ChatPanel {
  current?.close();

  const host = doc.createElement('div');
  host.id = CHAT_PANEL_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = CHAT_PANEL_STYLE;

  const panel = doc.createElement('div');
  panel.className = 'chat';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'PR Explainer chat');

  const header = doc.createElement('div');
  header.className = 'header';
  const title = doc.createElement('span');
  title.className = 'title';
  title.textContent = 'Chat';
  const subject = doc.createElement('span');
  subject.className = 'subject';
  const file = doc.createElement('code');
  file.className = 'file';
  file.textContent = options.subject.filePath;
  const lines = doc.createElement('span');
  lines.className = 'lines';
  lines.textContent = formatLines(options.subject);
  subject.append(file, lines);
  subject.title = `${options.subject.filePath}, ${formatLines(options.subject)}`;
  const closeButton = doc.createElement('button');
  closeButton.className = 'close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close chat');
  closeButton.textContent = '×';
  header.append(title, subject, closeButton);

  const list = doc.createElement('div');
  list.className = 'messages';
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');

  const form = doc.createElement('form');
  form.className = 'composer';
  const input = doc.createElement('textarea');
  input.className = 'input';
  input.rows = 2;
  input.placeholder = 'Ask about this code…';
  input.setAttribute('aria-label', 'Your question');
  const sendButton = doc.createElement('button');
  sendButton.className = 'send';
  sendButton.type = 'submit';
  sendButton.textContent = 'Send';
  const hint = doc.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Enter to send · Shift+Enter for a new line';
  form.append(input, sendButton, hint);

  panel.append(header, list, form);
  shadow.append(style, panel);
  doc.body.append(host);

  let open = true;
  let busy = false;
  const views: ChatMessageView[] = [];

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK;
  const scrollToEnd = () => {
    list.scrollTop = list.scrollHeight;
  };

  const canSend = () => open && !busy && input.value.trim() !== '';
  const syncSend = () => {
    sendButton.disabled = !canSend();
    panel.dataset.busy = String(busy);
  };

  const render = (role: ChatRole, el: HTMLElement, text: string) => {
    if (role === 'assistant') el.replaceChildren(renderMarkdown(doc, text));
    else el.textContent = text;
  };

  const addMessage = (role: ChatRole, text: string, follow = nearBottom()): ChatMessageView => {
    const element = doc.createElement('div');
    element.className = `message ${role}`;
    element.dataset.role = role;
    render(role, element, text);
    list.append(element);
    const view: ChatMessageView = {
      element,
      role,
      update(next) {
        if (!open) return;
        const keep = nearBottom();
        render(role, element, next);
        if (keep) scrollToEnd();
      },
    };
    views.push(view);
    if (follow) scrollToEnd();
    return view;
  };

  const send = () => {
    if (!canSend()) return;
    const question = input.value.trim();
    input.value = '';
    // The user's own question always scrolls into view.
    addMessage('user', question, true);
    syncSend();
    options.onSend?.(question);
  };

  input.addEventListener('input', syncSend);
  input.addEventListener('keydown', (event) => {
    // isComposing: Enter that picks a word in an input method (IME) is not a send.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });
  closeButton.addEventListener('click', () => chat.close());
  // Key presses inside the shadow root reach GitHub's page with the panel's
  // host as their target, which GitHub does not see as a text box, so typing
  // "t" or "s" would trigger its keyboard shortcuts. Keep them inside.
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  for (const message of options.messages ?? []) addMessage(message.role, message.text, true);
  syncSend();

  const chat: ChatPanel = {
    host,
    get isOpen() {
      return open;
    },
    get messages() {
      return [...views];
    },
    addMessage(role, text) {
      return addMessage(role, text);
    },
    setBusy(next) {
      busy = next;
      syncSend();
    },
    focus() {
      input.focus();
    },
    close() {
      if (!open) return;
      open = false;
      host.remove();
      if (current === chat) current = null;
      options.onClose?.();
    },
  };

  current = chat;
  return chat;
}
