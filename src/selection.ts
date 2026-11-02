// Multi-line selection (PR 4.4): explain a block of lines as a whole.
//
// The user picks a range of lines in one file in either of two ways:
// - drag across the lines (a text selection that covers two or more rows), or
// - click one line, then Shift-click another.
// The rows in the range are highlighted and a small "Explain selection"
// button appears under the last one. Pressing it opens the explanation popup
// under the block, using the same streaming, Stop, cache and Regenerate as a
// single line (explainInPopup in src/clickHandler.ts). A range that spans two
// files shows a short "one file at a time" note instead, and a range longer
// than MAX_SELECTED_LINES asks for a smaller one.
//
// The highlight and the button go away on Esc or the next mousedown anywhere
// else; while the block's popup is open the highlight stays, and it is
// cleared when that popup closes.

import { explainInPopup, isInteractive, type ClickHandlerDeps } from './clickHandler';
import { locateRange, locateRow, type DiffRange } from './diffDom';
import { formatSelection, MAX_SELECTED_LINES, selectionContext } from './lineContext';
import type { AnchorRect, PopupAnchor } from './popup/popup';

/** Set on each highlighted row. GitHub's own markup never uses it. */
export const SELECTED_ATTR = 'data-pr-explainer-selected';
export const SELECTION_UI_ID = 'pr-explainer-selection';
const STYLE_ID = 'pr-explainer-selection-style';

export const OTHER_FILE_NOTE = 'Select lines in one file at a time.';
export const TOO_MANY_NOTE = `Select ${MAX_SELECTED_LINES} lines or fewer.`;
/** How long a note stays up, unless the user clicks first. */
export const NOTE_MS = 4000;

// The tint goes on the cells as an inset shadow, so it shows over GitHub's
// green and red line colors instead of replacing them.
const PAGE_STYLE = `
  tr[${SELECTED_ATTR}] > td {
    box-shadow: inset 0 0 0 9999px rgba(84, 174, 255, 0.22) !important;
  }
  tr[${SELECTED_ATTR}] > td:first-child {
    box-shadow: inset 3px 0 0 #0969da, inset 0 0 0 9999px rgba(84, 174, 255, 0.22) !important;
  }
`;

const UI_STYLE = `
  :host { all: initial; }
  .bar {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    background: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(140, 149, 159, 0.3);
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    color: #1f2328;
  }
  button {
    font: inherit;
    font-weight: 600;
    color: #ffffff;
    background: #1f883d;
    border: 1px solid rgba(31, 35, 40, 0.15);
    border-radius: 6px;
    padding: 3px 10px;
    cursor: pointer;
  }
  button:hover { background: #1a7f37; }
  .note { padding: 2px 6px; }
`;

export interface SelectionDeps extends Pick<
  ClickHandlerDeps,
  'explain' | 'openPopup' | 'onContext' | 'onTiming'
> {
  /** False while click-to-explain is off (toolbar button). */
  isEnabled?(): boolean;
}

/**
 * What the popup points at for a block: from the top of its first row to the
 * bottom of its last, so the popup goes below the block, or above it when
 * there is no room below, instead of covering it.
 */
export function blockAnchor(rows: readonly Element[]): PopupAnchor {
  return {
    getBoundingClientRect(): AnchorRect {
      const first = rows[0]!.getBoundingClientRect();
      const last = rows.at(-1)!.getBoundingClientRect();
      return { top: first.top, bottom: last.bottom, left: first.left };
    },
  };
}

/** The first and last rows a text selection touches, or null. */
function selectionEnds(doc: Document): [Node, Node] | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  // A drag that ends in the gutter between rows can leave a container that is
  // the table body itself; the row is then the child at the offset.
  const pick = (container: Node, offset: number, end: boolean): Node =>
    container instanceof Element && !locateRow(container)
      ? (container.childNodes[end ? offset - 1 : offset] ?? container)
      : container;
  return [
    pick(range.startContainer, range.startOffset, false),
    pick(range.endContainer, range.endOffset, true),
  ];
}

/**
 * Listens for drags and Shift-clicks across diff lines on `doc`. Returns a
 * function that removes the listeners and anything shown.
 */
export function installSelection(deps: SelectionDeps, doc: Document = document): () => void {
  const win = doc.defaultView!;
  // The row of the last plain click on a line, for Shift-click.
  let anchorRow: Element | null = null;
  let rows: Element[] = [];
  let ui: HTMLElement | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let explaining = false;

  const ensureStyle = () => {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = PAGE_STYLE;
    (doc.head ?? doc.body).append(style);
  };

  const removeUi = () => {
    clearTimeout(noteTimer);
    ui?.remove();
    ui = null;
  };
  const clearHighlight = () => {
    for (const row of rows) row.removeAttribute(SELECTED_ATTR);
    rows = [];
  };
  const clear = () => {
    removeUi();
    if (!explaining) clearHighlight();
  };

  /** Shows a small floating bar at page position (x, y) holding `content`. */
  const showUi = (x: number, y: number, content: HTMLElement) => {
    removeUi();
    const host = doc.createElement('div');
    host.id = SELECTION_UI_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = UI_STYLE;
    const bar = doc.createElement('div');
    bar.className = 'bar';
    bar.append(content);
    shadow.append(style, bar);
    host.style.setProperty('position', 'absolute');
    host.style.setProperty('top', `${y}px`);
    host.style.setProperty('left', `${x}px`);
    host.style.setProperty('z-index', '2147483646');
    doc.body.append(host);
    ui = host;
  };

  const showNote = (x: number, y: number, text: string) => {
    clear();
    const note = doc.createElement('span');
    note.className = 'note';
    note.setAttribute('role', 'status');
    note.textContent = text;
    showUi(x, y, note);
    noteTimer = setTimeout(removeUi, NOTE_MS);
  };

  const select = (range: DiffRange, x: number) => {
    // A new selection replaces the highlight of a block being explained. That
    // block's popup stays open until the user explains the new one.
    explaining = false;
    clear();
    ensureStyle();
    rows = range.rows;
    for (const row of rows) row.setAttribute(SELECTED_ATTR, '');
    const last = rows.at(-1)!;
    const box = last.getBoundingClientRect();
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = `Explain selection (${rows.length} lines)`;
    button.addEventListener('click', () => {
      removeUi();
      explaining = true;
      const selected = rows;
      explainInPopup(deps, formatSelection(selectionContext(range)), blockAnchor(selected), () => {
        // Only clear the highlight if no newer selection replaced it.
        if (rows === selected) {
          explaining = false;
          clearHighlight();
        }
      });
    });
    showUi(x + win.scrollX, box.bottom + win.scrollY + 4, button);
  };

  const onMouseUp = (event: MouseEvent) => {
    if (deps.isEnabled?.() === false || event.button !== 0) return;
    if (ui && event.composedPath().includes(ui)) return;
    const target = event.target;
    if (isInteractive(target)) return;

    let ends: [Node | EventTarget | null, Node | EventTarget | null] | null = null;
    if (event.shiftKey && anchorRow?.isConnected && locateRow(target)) {
      ends = [anchorRow, target];
      // Shift-click also stretches the browser's text selection; it is noise here.
      doc.getSelection()?.removeAllRanges();
    } else {
      const fromText = selectionEnds(doc);
      if (fromText && locateRow(fromText[0]) !== locateRow(fromText[1])) ends = fromText;
    }

    if (!ends) {
      // A plain click on a line is where a later Shift-click starts from.
      const row = locateRow(target);
      if (row && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        anchorRow = row;
      }
      return;
    }
    const range = locateRange(ends[0], ends[1]);
    if (!range || (range !== 'other-file' && range.rows.length < 2)) return;
    const endRow = locateRow(ends[1]) ?? locateRow(target);
    const box = endRow?.getBoundingClientRect();
    const y = (box?.bottom ?? event.clientY) + win.scrollY + 4;
    const x = event.clientX + win.scrollX;
    if (range === 'other-file') showNote(x, y, OTHER_FILE_NOTE);
    else if (range.rows.length > MAX_SELECTED_LINES) showNote(x, y, TOO_MANY_NOTE);
    else select(range, event.clientX);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (ui && event.composedPath().includes(ui)) return;
    clear();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') clear();
  };

  doc.addEventListener('mouseup', onMouseUp);
  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  return () => {
    doc.removeEventListener('mouseup', onMouseUp);
    doc.removeEventListener('mousedown', onMouseDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    explaining = false;
    clear();
  };
}
