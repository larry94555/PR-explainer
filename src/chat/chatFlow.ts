// Connects the chat panel to the model (PR 5.3). The popup's Ask a question
// button opens the panel with a ChatSession (src/chat/chatSession.ts); each
// question the user sends is answered by streaming the session's message list
// to the service worker, and the answer is written into the panel as it
// arrives.
//
// - A finished answer is recorded in the session, so the next question
//   builds on it.
// - Stop ends the request. Any text the model wrote stays in the panel and is
//   recorded with the question, so a follow-up can refer to it; a stop before
//   any text records nothing.
// - A failed request shows the message and fix in the panel and records
//   nothing, so the user can just ask again.
// In every case the panel is ready for the next question.
//
// While the panel is open, clicking other code adds it to the conversation
// (addCode, PR 5.4): the header names it, a "Now looking at …" note marks the
// spot, and the next question is sent with it. Code added while an answer is
// being written is recorded after that answer, in the order the panel shows.
// New chat stops any answer, clears the conversation, and goes back to the
// code and explanation the chat started from. Closing the panel
// stops a request that is still running; the session stays, so asking again
// about the same code carries on the conversation.
//
// The parts that talk to Chrome and draw the panel are passed in, so the
// tests can use fakes.

import { describeRequestError } from '../clickHandler';
import type { ChatMessage } from '../llm/types';
import type { ChatStream } from '../messaging/client';
import type { ChatPanel, ChatPanelMessage, ChatPanelOptions, ChatSubject } from './chatPanel';
import { formatLines } from './chatPanel';
import {
  ChatSession,
  codeNote,
  formatExplanation,
  type ChatCode,
  type ChatSeed,
  type ChatSessions,
} from './chatSession';

export interface ChatFlowDeps {
  /** Streams the model's answer to `messages`, calling `onChunk` with each piece. */
  ask(messages: ChatMessage[], onChunk: (text: string) => void): ChatStream;
  /** Opens the chat panel, closing any other one. */
  openPanel(options: ChatPanelOptions): ChatPanel;
}

/** Shown when the model finished without writing anything. */
export const EMPTY_ANSWER = {
  message: 'The model finished without writing an answer.',
  fix: 'Ask again, or pick another model on the PR Explainer settings page.',
};

/**
 * The session to chat in for `seed`. The PR's session is reused while it is
 * about the same code and explanation, so closing and reopening the chat
 * carries on the conversation. Asking about other code from the popup starts
 * a new one (to keep the conversation, click the other code while the chat is
 * open, see ActiveChat.addCode). `regenerated` (the
 * explanation came from Regenerate) always starts a new one, even when the
 * model wrote the same text again. Without a PR name the session is not kept.
 */
export function chatSessionFor(
  sessions: ChatSessions,
  pr: string | undefined,
  seed: ChatSeed,
  { regenerated = false }: { regenerated?: boolean } = {},
): ChatSession {
  if (pr === undefined) return new ChatSession(seed);
  const existing = sessions.get(pr);
  const same =
    !regenerated &&
    existing?.context === seed.context &&
    formatExplanation(existing.explanation) === formatExplanation(seed.explanation);
  return same ? existing : sessions.restart(pr, seed);
}

/**
 * The panel's first messages: the explanation, then every earlier turn and a
 * note for each piece of code moved on to.
 */
export function panelMessages(session: ChatSession): ChatPanelMessage[] {
  return [
    { role: 'assistant', text: formatExplanation(session.explanation) },
    ...session.entries.flatMap((entry): ChatPanelMessage[] =>
      entry.kind === 'code'
        ? [{ role: 'note', text: codeNote(entry.about) }]
        : [
            { role: 'user', text: entry.question },
            { role: 'assistant', text: entry.answer },
          ],
    ),
  ];
}

/** Names code for the conversation, for example "`src/settings.ts` line 42". */
export function describeSubject(subject: ChatSubject): string {
  return `\`${subject.filePath}\` ${formatLines(subject)}`;
}

/** The open chat: its panel, and a way to bring other code into it. */
export interface ActiveChat extends ChatPanel {
  /**
   * Adds other code to the conversation (a click on another line while the
   * chat is open). Returns false once the panel is closed, so the caller can
   * explain the code in the popup instead. Code the chat is already about is
   * taken (true) but not added again.
   */
  addCode(context: string, subject: ChatSubject): boolean;
}

/** Opens the chat panel for `session` and answers each question sent in it. */
export function startChat(
  deps: ChatFlowDeps,
  session: ChatSession,
  subject: ChatSubject,
): ActiveChat {
  interface Pending {
    question: string;
    reply: string;
    view: ReturnType<ChatPanel['addMessage']>;
    stream?: ChatStream;
  }
  // The answer being written, if any. Each request checks it is still the
  // pending one, so a stopped request cannot write into the panel.
  let pending: Pending | undefined;
  // Code clicked while an answer is being written, recorded once it ends.
  let queued: ChatCode[] = [];

  const recordQueued = () => {
    for (const code of queued) session.addCode(code);
    queued = [];
  };

  const finish = () => {
    pending = undefined;
    panel.setBusy(false);
  };

  const send = (question: string) => {
    const messages = session.messagesFor(question);
    const turn: Pending = { question, reply: '', view: panel.addMessage('assistant', '') };
    pending = turn;
    panel.setBusy(true);
    const current = () => pending === turn;
    const stream = deps.ask(messages, (chunk) => {
      if (!current()) return;
      turn.reply += chunk;
      turn.view.update(turn.reply);
    });
    turn.stream = stream;
    stream.result.then(
      (result) => {
        if (!current()) return;
        finish();
        if (result.status === 'failed') {
          recordQueued();
          return turn.view.showError(result.message, result.fix);
        }
        const recorded = session.addTurn(question, result.answer);
        recordQueued();
        if (!recorded) return turn.view.showError(EMPTY_ANSWER.message, EMPTY_ANSWER.fix);
        turn.view.update(result.answer);
      },
      (error: unknown) => {
        if (!current()) return;
        finish();
        recordQueued();
        const { message, fix } = describeRequestError(error);
        turn.view.showError(message, fix);
      },
    );
  };

  const stop = () => {
    const turn = pending;
    if (!turn) return;
    finish();
    turn.stream?.stop();
    turn.view.showStopped();
    session.addTurn(turn.question, turn.reply);
    recordQueued();
  };

  // Stops any answer without recording it, as closing the panel does.
  const drop = () => {
    const turn = pending;
    pending = undefined;
    queued = [];
    turn?.stream?.stop();
  };

  const newChat = () => {
    drop();
    session.reset();
    panel.setBusy(false);
    panel.clear();
    for (const message of panelMessages(session)) {
      if (message.role === 'note') panel.addNote(message.text);
      else panel.addMessage(message.role, message.text);
    }
    panel.setSubject(subject);
    panel.focus();
  };

  const panel = deps.openPanel({
    subject,
    messages: panelMessages(session),
    onSend: send,
    onStop: stop,
    onNewChat: newChat,
    onClose: drop,
  });

  const addCode = (context: string, next: ChatSubject): boolean => {
    if (!panel.isOpen) return false;
    const latest = queued.at(-1)?.context ?? session.currentContext;
    if (context === latest) return true;
    const code = { context, about: describeSubject(next) };
    if (pending) queued.push(code);
    else session.addCode(code);
    panel.setSubject(next);
    panel.addNote(codeNote(code.about));
    panel.focus();
    return true;
  };

  return Object.assign(panel, { addCode });
}
