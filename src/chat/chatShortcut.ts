// The Open chat shortcut on the GitHub page's side (PR 11.9).
//
// The service worker opens Chrome's side panel for the key press and then
// tells the page (src/commands.ts, src/tabCommands.ts). The page keeps every
// PR's conversation (ChatSessions), so it is what draws it again: in the side
// panel that just opened, or on the page when Chat opens in is On the page or
// Chrome refused the side panel (with why). A chat already open there just
// gets focus. A PR with no conversation yet has nothing to open; the side
// panel then says to click a line, and Ask a question starts one.

import type { ChatPanel, ChatSubject } from './chatPanel';
import type { ChatSession, ChatSessions } from './chatSession';
import type { ChatPlace } from './sidePanelChat';
import { fallbackNote } from './sidePanelChat';

export interface ChatShortcutDeps {
  /** The PR the page shows now ("owner/repo#17"), or undefined off a PR. */
  pr(): string | undefined;
  sessions: Pick<ChatSessions, 'get'>;
  /** What each PR's chat was first about. */
  subjects: ReadonlyMap<string, ChatSubject>;
  /** The chat open in `place` now, if any. */
  openChat(place: ChatPlace): ChatPanel | null;
  /** Opens the chat for `session` in `place`, closing any other, with an optional note. */
  show(
    place: ChatPlace,
    pr: string,
    session: ChatSession,
    subject: ChatSubject,
    note?: string,
  ): void;
}

export type ChatShortcutOutcome = 'focused' | 'reopened' | 'nothing';

/** Acts on the Open chat shortcut. `sidePanel`: Chrome just opened the side panel for it. */
export function openChatFromShortcut(
  deps: ChatShortcutDeps,
  { sidePanel, reason }: { sidePanel?: true; reason?: string },
): ChatShortcutOutcome {
  const place: ChatPlace = sidePanel ? 'sidepanel' : 'page';
  const open = deps.openChat(place);
  if (open) {
    open.focus();
    return 'focused';
  }
  const pr = deps.pr();
  const session = pr === undefined ? undefined : deps.sessions.get(pr);
  const subject = pr === undefined ? undefined : deps.subjects.get(pr);
  if (pr === undefined || !session || !subject) return 'nothing';
  deps.show(place, pr, session, subject, reason ? fallbackNote(reason) : undefined);
  return 'reopened';
}
