// Keyboard and focus helpers (PR 7.3).
//
// The Explain shortcut explains code without the mouse: the selected block of
// lines, or the one line that has keyboard focus or holds the text cursor.
// GitHub's newer diff view lets you move between lines with the arrow keys
// (each cell can take focus); in the classic view, select text with the
// keyboard or turn on caret browsing (F7) and move the cursor to a line.
//
// Since PR 11.9 the shortcut is a Chrome command (suggested Ctrl+Shift+E, see
// src/commands.ts), so it can be changed on chrome://extensions/shortcuts and
// no other extension or page handles it too. The page no longer listens for
// the key itself: the service worker tells it (src/tabCommands.ts), and
// src/selection.ts explains, since it already knows about selected blocks.
// Nothing is explained while typing in a text box.

/** True when `target` is somewhere the user types: a text box or editable text. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return editable != null && editable.getAttribute('contenteditable') !== 'false';
}

/**
 * Where a single line to explain is: the element with keyboard focus when it
 * is on a line (`isLine`), otherwise where the text cursor or selection ends.
 * Null when neither is on a line.
 */
export function shortcutTarget(doc: Document, isLine: (node: Node) => boolean): Node | null {
  const focused = doc.activeElement;
  if (focused && focused !== doc.body && isLine(focused)) return focused;
  const selection = doc.getSelection();
  const caret = selection?.rangeCount ? selection.focusNode : null;
  return caret && isLine(caret) ? caret : null;
}

/**
 * Gives focus back to `element` after a panel that had it closed (the popup
 * and the chat panel), if it is still on the page and can take focus.
 */
export function restoreFocus(element: Element | null): void {
  if (!element?.isConnected || element === element.ownerDocument.body) return;
  if ('focus' in element && typeof element.focus === 'function') {
    (element as HTMLElement).focus({ preventScroll: true });
  }
}
