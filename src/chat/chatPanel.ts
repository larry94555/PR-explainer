// The chat panel (Milestone 5): a message list, a text box, and a Send button,
// docked in the bottom-right corner of the window. Like the popup
// (src/popup/popup.ts) it lives in a Shadow DOM root, so GitHub's CSS cannot
// restyle it and its CSS cannot leak into GitHub.
//
// The header names the file and lines being discussed (setSubject changes
// them when the user moves on to other code, PR 5.4), and a note in the list
// (addNote) marks where that happened. A New chat button (onNewChat) lets the
// caller start the conversation over. Questions are shown as
// plain text; answers are untrusted model output and are rendered with
// renderMarkdown, which never parses HTML. Enter sends, Shift+Enter starts a
// new line, and Send is disabled while the text box is empty or an answer is
// being written (setBusy). The list keeps the newest message in view, unless
// the user has scrolled up to read an older one.
//
// While an answer is being written a Stop button replaces Send (onStop). By
// default (PR 9.6) the answer is not shown while it is written: it says
// "Thinking…" until the panel stops being busy, then the whole answer appears
// at once. With the Show answers as they are written setting on
// (streamAnswers), each update shows at once, as before. An
// answer that failed shows the message and fix in red (showError), and a
// stopped one keeps its text with a "Stopped" note (showStopped).
//
// Like the popup, each answer shows how long it took: a live timer under it
// while the panel is busy, then "Answered in …", "Failed after …", or
// "Stopped after …" (PR 8.1). The timer is hidden from screen readers while
// it ticks, so the message list does not announce every tenth of a second.
//
// It follows GitHub's light or dark mode (src/theme.ts). Esc closes it, and
// closing it while focus is inside gives focus back to what had it before it
// opened. The message list is marked aria-busy while an answer is being
// written (PR 7.3).
//
// The same panel draws the chat in Chrome's side panel (PR 11.8,
// src/sidepanel/sidePanelPage.ts): `layout: 'fill'` makes it fill the page it
// is on instead of floating in a corner, and `theme` gives it GitHub's light
// or dark mode, which the side panel's own page cannot read. There it is a
// region rather than a dialog, and Esc does not close it.
//
// The panel does not talk to the LLM or keep the conversation: it reports
// each question through onSend, and the caller adds the answer with
// addMessage and fills it in with update. src/chat/chatFlow.ts does that with
// a ChatSession when the popup's Ask a question button is pressed, and the
// demo page (`npm run demo:chat`) does it with fake answers.

import { appendInline, renderMarkdown } from '../popup/renderMarkdown';
import { formatElapsed, TICK_MS } from '../popup/popup';
import { CHAT_PANEL_STYLE } from './chatPanelStyle';
import { restoreFocus } from '../a11y';
import { followTheme, type Theme } from '../theme';

export const CHAT_PANEL_ID = 'pr-explainer-chat';

/** What the chat is about: a file and one line or a block of lines. */
export interface ChatSubject {
  filePath: string;
  startLine: number;
  /** The last line of a selected block; leave out for a single line. */
  endLine?: number;
  /**
   * The code that was clicked or selected, line by line exactly as on the
   * page, with each line's number (PR 11.14). Shown under the header so the
   * chat says what it is about without looking back at the PR.
   */
  code?: SubjectLine[];
}

/** One line of `ChatSubject.code`. */
export interface SubjectLine {
  lineNumber: number;
  text: string;
}

/** "line 42", or "lines 12 to 18" for a block. */
export function formatLines(subject: ChatSubject): string {
  const { startLine, endLine } = subject;
  return endLine === undefined || endLine === startLine
    ? `line ${startLine}`
    : `lines ${Math.min(startLine, endLine)} to ${Math.max(startLine, endLine)}`;
}

export type ChatRole = 'user' | 'assistant';

/**
 * A message to show when the panel opens, such as the explanation and earlier
 * turns. A 'note' is a line between messages, such as "Now looking at …".
 */
export interface ChatPanelMessage {
  role: ChatRole | 'note';
  text: string;
}

/** One message in the list. An answer is filled in with update as it streams. */
export interface ChatMessageView {
  readonly element: HTMLElement;
  readonly role: ChatRole;
  /** Replaces the message's text (markdown for an answer). */
  update(text: string): void;
  /** Shows that the answer failed: `message` and `fix` replace its text. */
  showError(message: string, fix: string): void;
  /** Marks the answer as stopped, keeping any text it has. */
  showStopped(): void;
}

/** Shown in a stopped answer, after any text the model wrote. */
export const STOPPED_NOTE = 'Stopped.';
/** Shown in place of the answer when Stop is pressed before any text arrived. */
export const STOPPED_EMPTY = 'Stopped before the model wrote anything.';

export interface ChatPanelOptions {
  subject: ChatSubject;
  /** Shown before anything is typed, oldest first. */
  messages?: ChatPanelMessage[];
  /**
   * Called with the trimmed question after it has been added to the list and
   * the text box cleared.
   */
  onSend?: (question: string) => void;
  /** Called when Stop is pressed while an answer is being written. */
  onStop?: () => void;
  /** Called when New chat is pressed. Leaving it out hides the button. */
  onNewChat?: () => void;
  /** Called once when the panel closes, however it was closed. */
  onClose?: () => void;
  /**
   * Show an answer's text while it is being written (PR 9.6). Off by default:
   * updates to the answer being written are kept until the panel stops being
   * busy (or the answer is stopped), then shown in one go.
   */
  streamAnswers?: boolean;
  /** Clock in milliseconds, for an answer's elapsed time. Tests pass a fake one. */
  now?: () => number;
  /**
   * `docked` (the default) floats over the bottom right of the page; `fill`
   * fills the page, for Chrome's side panel (PR 11.8).
   */
  layout?: 'docked' | 'fill';
  /**
   * Light or dark, set by the caller (the side panel, PR 11.8). Left out, the
   * panel follows the page it is on (src/theme.ts).
   */
  theme?: Theme;
}

export interface ChatPanel {
  readonly host: HTMLElement;
  readonly isOpen: boolean;
  /** True while an answer is being written (setBusy). */
  readonly isBusy: boolean;
  /** The messages in the list, oldest first. */
  readonly messages: readonly ChatMessageView[];
  /** Adds a message at the bottom of the list. */
  addMessage(role: ChatRole, text: string): ChatMessageView;
  /** Adds a note between messages, such as "Now looking at `file.ts` line 42". */
  addNote(text: string): void;
  /** Removes every message and note. */
  clear(): void;
  /** Changes the file and lines named in the header. */
  setSubject(subject: ChatSubject): void;
  /**
   * While busy (an answer is being written), Send and Enter do nothing and
   * Stop shows. Turning it on starts the timer under the newest answer, and
   * turning it off stops it.
   */
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
  // Where keyboard focus goes back to when the panel closes.
  const returnFocus = doc.activeElement;

  const host = doc.createElement('div');
  host.id = CHAT_PANEL_ID;
  const fill = options.layout === 'fill';
  if (fill) host.dataset.layout = 'fill';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = CHAT_PANEL_STYLE;

  const panel = doc.createElement('div');
  panel.className = 'chat';
  panel.setAttribute('role', fill ? 'region' : 'dialog');
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
  const lines = doc.createElement('span');
  lines.className = 'lines';
  subject.append(file, lines);
  // The clicked code with its line numbers (PR 11.14), between the header and
  // the messages. Hidden when the subject has no code.
  const codeBox = doc.createElement('div');
  codeBox.className = 'subject-code';
  codeBox.setAttribute('role', 'group');
  codeBox.setAttribute('aria-label', 'The code this chat is about');
  const setSubject = (next: ChatSubject) => {
    file.textContent = next.filePath;
    lines.textContent = formatLines(next);
    subject.title = `${next.filePath}, ${formatLines(next)}`;
    const codeLines = next.code ?? [];
    codeBox.hidden = codeLines.length === 0;
    codeBox.replaceChildren(
      ...codeLines.map(({ lineNumber, text }) => {
        const row = doc.createElement('span');
        row.className = 'code-line';
        const number = doc.createElement('span');
        number.className = 'line-number';
        number.textContent = String(lineNumber);
        const code = doc.createElement('code');
        code.textContent = text;
        row.append(number, code);
        return row;
      }),
    );
  };
  setSubject(options.subject);
  const newChatButton = doc.createElement('button');
  newChatButton.className = 'new-chat';
  newChatButton.type = 'button';
  newChatButton.textContent = 'New chat';
  newChatButton.title = 'Clear this conversation and start again';
  const closeButton = doc.createElement('button');
  closeButton.className = 'close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close chat');
  closeButton.textContent = '×';
  header.append(title, subject);
  if (options.onNewChat) header.append(newChatButton);
  header.append(closeButton);

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
  // Takes Send's place while an answer is being written (see chatPanelStyle.ts).
  const stopButton = doc.createElement('button');
  stopButton.className = 'stop';
  stopButton.type = 'button';
  stopButton.textContent = 'Stop';
  stopButton.title = 'Stop the model';
  const hint = doc.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Enter to send · Shift+Enter for a new line';
  form.append(input, sendButton, stopButton, hint);

  panel.append(header, codeBox, list, form);
  shadow.append(style, panel);
  doc.body.append(host);
  let stopFollowingTheme = () => {};
  if (options.theme) host.dataset.theme = options.theme;
  else stopFollowingTheme = followTheme(host, doc);

  let open = true;
  let busy = false;
  const views: ChatMessageView[] = [];

  // The time each answer took, shown under it. Only one ticks at a time.
  const now = options.now ?? (() => performance.now());
  interface Timer {
    label: HTMLElement;
    startedAt: number;
    finishedAt?: number;
  }
  const timers = new WeakMap<HTMLElement, Timer>();
  let ticking: Timer | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const showTime = (timer: Timer, prefix = '') => {
    timer.label.textContent = prefix + formatElapsed((timer.finishedAt ?? now()) - timer.startedAt);
  };
  const startTimer = (answer: HTMLElement) => {
    if (timers.has(answer)) return;
    const follow = nearBottom();
    const label = doc.createElement('p');
    label.className = 'elapsed';
    label.setAttribute('aria-hidden', 'true');
    answer.after(label);
    const timer: Timer = { label, startedAt: now() };
    timers.set(answer, timer);
    ticking = timer;
    showTime(timer);
    if (follow) scrollToEnd();
    ticker ??= setInterval(() => ticking && showTime(ticking), TICK_MS);
  };
  const stopTicking = () => {
    clearInterval(ticker);
    ticker = undefined;
    ticking = undefined;
  };
  // Freezes an answer's time (once) and says how it ended.
  const finishTimer = (answer: HTMLElement, prefix: string) => {
    const timer = timers.get(answer);
    if (!timer) return;
    if (ticking === timer) stopTicking();
    timer.finishedAt ??= now();
    timer.label.removeAttribute('aria-hidden');
    showTime(timer, prefix);
  };

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK;
  const scrollToEnd = () => {
    list.scrollTop = list.scrollHeight;
  };

  const canSend = () => open && !busy && input.value.trim() !== '';
  const syncSend = () => {
    sendButton.disabled = !canSend();
    panel.dataset.busy = String(busy);
    list.setAttribute('aria-busy', String(busy));
  };

  const render = (role: ChatRole, el: HTMLElement, text: string) => {
    if (role === 'assistant') el.replaceChildren(renderMarkdown(doc, text));
    else el.textContent = text;
  };

  // Text kept back for the answer being written (streamAnswers off), shown
  // when it ends.
  const heldBack = new WeakMap<HTMLElement, string>();
  const isWriting = (element: HTMLElement) => busy && ticking === timers.get(element);
  const showHeldBack = (element: HTMLElement) => {
    const text = heldBack.get(element);
    if (text === undefined) return;
    heldBack.delete(element);
    render('assistant', element, text);
  };

  const addMessage = (role: ChatRole, text: string, follow = nearBottom()): ChatMessageView => {
    const element = doc.createElement('div');
    element.className = `message ${role}`;
    element.dataset.role = role;
    render(role, element, text);
    list.append(element);
    const change = (fill: () => void) => {
      if (!open) return;
      const keep = nearBottom();
      fill();
      if (keep) scrollToEnd();
    };
    const view: ChatMessageView = {
      element,
      role,
      update(next) {
        if (role === 'assistant' && !options.streamAnswers && isWriting(element)) {
          if (open) heldBack.set(element, next);
          return;
        }
        heldBack.delete(element);
        change(() => render(role, element, next));
      },
      showError(message, fix) {
        heldBack.delete(element);
        finishTimer(element, 'Failed after ');
        change(() => {
          element.dataset.status = 'failed';
          element.setAttribute('role', 'alert');
          const messageEl = doc.createElement('p');
          messageEl.className = 'error-message';
          appendInline(messageEl, message);
          const fixEl = doc.createElement('p');
          fixEl.className = 'fix';
          appendInline(fixEl, fix);
          element.replaceChildren(messageEl, fixEl);
        });
      },
      showStopped() {
        finishTimer(element, 'Stopped after ');
        change(() => {
          // What the model wrote before Stop is shown, not lost.
          showHeldBack(element);
          element.dataset.status = 'stopped';
          const note = doc.createElement('p');
          note.className = 'stopped-note';
          note.textContent = element.textContent?.trim() ? STOPPED_NOTE : STOPPED_EMPTY;
          element.append(note);
        });
      },
    };
    views.push(view);
    if (follow) scrollToEnd();
    return view;
  };

  const addNote = (text: string, follow = nearBottom()) => {
    if (!open) return;
    const element = doc.createElement('p');
    element.className = 'note';
    appendInline(element, text);
    list.append(element);
    if (follow) scrollToEnd();
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
  stopButton.addEventListener('click', () => {
    if (open && busy) options.onStop?.();
  });
  newChatButton.addEventListener('click', () => {
    if (open) options.onNewChat?.();
  });
  closeButton.addEventListener('click', () => chat.close());
  // Key presses inside the shadow root reach GitHub's page with the panel's
  // host as their target, which GitHub does not see as a text box, so typing
  // "t" or "s" would trigger its keyboard shortcuts. Keep them inside.
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  // isComposing: Esc that cancels an input method (IME) word keeps the panel open.
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing && !fill) chat.close();
  });

  for (const message of options.messages ?? []) {
    if (message.role === 'note') addNote(message.text, true);
    else addMessage(message.role, message.text, true);
  }
  syncSend();

  const chat: ChatPanel = {
    host,
    get isOpen() {
      return open;
    },
    get isBusy() {
      return busy;
    },
    get messages() {
      return [...views];
    },
    addMessage(role, text) {
      return addMessage(role, text);
    },
    addNote(text) {
      addNote(text);
    },
    clear() {
      if (!open) return;
      views.length = 0;
      stopTicking();
      list.replaceChildren();
    },
    setSubject(next) {
      if (open) setSubject(next);
    },
    setBusy(next) {
      if (open && next) {
        const answer = [...views].reverse().find((v) => v.role === 'assistant');
        if (answer) startTimer(answer.element);
      } else if (!next && ticking) {
        const answer = views.find((v) => timers.get(v.element) === ticking);
        if (answer) {
          finishTimer(answer.element, 'Answered in ');
          // The whole answer, in one go.
          const keep = nearBottom();
          showHeldBack(answer.element);
          if (keep) scrollToEnd();
        }
      }
      busy = next;
      syncSend();
    },
    focus() {
      input.focus();
    },
    close() {
      if (!open) return;
      // Focus inside a shadow root shows as its host on the page.
      const hadFocus = doc.activeElement === host;
      open = false;
      stopTicking();
      stopFollowingTheme();
      host.remove();
      if (hadFocus) restoreFocus(returnFocus);
      if (current === chat) current = null;
      options.onClose?.();
    },
  };

  current = chat;
  return chat;
}
