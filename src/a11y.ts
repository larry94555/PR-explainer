// Keyboard and focus helpers (PR 7.3).
//
// Alt+E explains code without the mouse: the selected block of lines, or the
// one line that has keyboard focus or holds the text cursor. GitHub's newer
// diff view lets you move between lines with the arrow keys (each cell can
// take focus); in the classic view, select text with the keyboard or turn on
// caret browsing (F7) and move the cursor to a line. src/selection.ts listens
// for the key, since it already knows about selected blocks.
//
// The key is matched by its position (`event.code`), not the character it
// types, so it works on keyboard layouts where Alt+E types a character (such
// as macOS, where Option+E starts an accent). AltGr+E (which types € on many
// European layouts) arrives as Ctrl+Alt+E and is left alone, as is Alt+E
// while typing in a text box, so typing is never blocked. Chrome lets a page
// handle Alt+E before using it to open its own menu on Windows, so the
// listener calls preventDefault when it explains something.

/** True for Alt+E with no other modifier, not a held-down repeat. */
export function isExplainShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === 'KeyE' &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat
  );
}

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
