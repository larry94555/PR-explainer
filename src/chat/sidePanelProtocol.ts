// What the chat in Chrome's side panel (PR 11.8) and the GitHub page send each
// other. Types only, so the content script and the side panel page can both
// import it without sharing code (see src/content.ts).
//
// The conversation stays in the content script, as before (ChatSessions, one
// per PR, kept while the tab is open). The side panel page draws it: it
// connects to the active tab with chrome.tabs.connect, the page answers with
// the whole chat (`chat`), or `empty` when it has none, and from then on sends
// each change as it happens (`add`, `update` and the rest, the same calls the
// on-page panel gets). The side panel sends back what the user does: a
// question (`send`), Stop, New chat and close. Before it moves to another tab
// it sends `detach`, so the page can tell that from the side panel closing,
// which ends the chat as closing the on-page panel does.

import type { ChatRole, ChatSubject } from './chatPanel';
import type { Theme } from '../theme';

// Each side keeps its own copy of the name; this type makes TypeScript check they match.
export type SidePanelPortName = 'pr-explainer:sidepanel';

/** One message or note as the side panel should show it. */
export type SidePanelEntry =
  | { kind: 'note'; text: string }
  | {
      kind: 'message';
      id: number;
      role: ChatRole;
      text: string;
      /** How an answer ended, when it failed or was stopped. */
      status?: 'failed' | 'stopped';
      error?: { message: string; fix: string };
    };

/** The whole chat, sent when the side panel connects (or the chat opens). */
export interface SidePanelChat {
  type: 'chat';
  /** A new chat (true), or the one the side panel may already show. */
  opened: boolean;
  subject: ChatSubject;
  entries: SidePanelEntry[];
  busy: boolean;
  streamAnswers: boolean;
  theme: Theme;
}

/** From the page to the side panel. */
export type SidePanelUpdate =
  | SidePanelChat
  | { type: 'empty'; theme: Theme; onPr: boolean }
  | { type: 'add'; id: number; role: ChatRole; text: string }
  | { type: 'update'; id: number; text: string }
  | { type: 'error'; id: number; message: string; fix: string }
  | { type: 'stopped'; id: number }
  | { type: 'note'; text: string }
  | { type: 'clear' }
  | { type: 'subject'; subject: ChatSubject }
  | { type: 'busy'; busy: boolean }
  | { type: 'theme'; theme: Theme }
  | { type: 'focus' };

/** From the side panel to the page. */
export type SidePanelAction =
  | { type: 'send'; question: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'close' }
  | { type: 'detach' };
