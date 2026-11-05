// Keyboard shortcuts and the right-click menu (PR 11.9), on the GitHub page's
// side. The service worker hears the Explain and Open chat commands and the
// menu item Explain with PR Explainer (src/commands.ts) and sends them to the
// PR tab, which knows what is focused, selected or right-clicked.
//
// The content script cannot import the service worker's code (see
// src/content.ts), so the message type is copied here; the type from
// src/messaging/protocol.ts checks it matches.

import type { ExtensionRuntime, TabCommand, TabCommandType } from './messaging/protocol';

const COMMAND_TYPE: TabCommandType = 'pr-explainer:command';

export interface TabCommandHandlers {
  /** The Explain shortcut. */
  explain(): void;
  /** Explain with PR Explainer, on what was last right-clicked. */
  explainAtPointer(): void;
  /**
   * The Open chat shortcut: in the side panel Chrome just opened, or on the
   * page, with why the side panel did not open, if it did not.
   */
  openChat(options: { sidePanel?: true; reason?: string }): void;
}

function isTabCommand(message: unknown): message is TabCommand {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === COMMAND_TYPE
  );
}

/** Acts on each command the service worker sends this tab. Only our own extension's are heard. */
export function listenForTabCommands(
  runtime: Pick<ExtensionRuntime, 'id' | 'onMessage'>,
  handlers: TabCommandHandlers,
): void {
  runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== runtime.id || !isTabCommand(message)) return false;
    if (message.command === 'explain') handlers.explain();
    else if (message.command === 'explain-at-pointer') handlers.explainAtPointer();
    else if (message.command === 'open-chat') {
      handlers.openChat({
        ...(message.sidePanel === true && { sidePanel: true as const }),
        ...(typeof message.reason === 'string' && { reason: message.reason }),
      });
    }
    return false;
  });
}

/** Where the last right-click on the page was, for the menu item. */
export interface ContextTarget {
  target: EventTarget | null;
  point: { x: number; y: number };
}

/**
 * Remembers what each right-click was on. The menu item's message comes
 * after the menu closes, and Chrome does not say which element it was on.
 */
export function trackContextTarget(doc: Document = document): {
  current(): ContextTarget | null;
  remove(): void;
} {
  let last: ContextTarget | null = null;
  const onContextMenu = (event: MouseEvent) => {
    last = { target: event.target, point: { x: event.clientX, y: event.clientY } };
  };
  doc.addEventListener('contextmenu', onContextMenu, true);
  return {
    current: () => last,
    remove: () => doc.removeEventListener('contextmenu', onContextMenu, true),
  };
}
