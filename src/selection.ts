// Multi-line selection (PR 4.4): explain a block of lines as a whole.
//
// The user picks a range of lines in one file in either of two ways:
// - drag across the lines (a text selection that covers two or more rows), or
// - click one line, then Shift-click another.
// The rows in the range are highlighted and a small "Explain selection"
// button appears under the last one. Pressing it opens the explanation popup
// under the block, using the same streaming, Stop, cache and Regenerate as a
// single line (explainCode in src/clickHandler.ts); while the chat is open
// the block goes to the chat instead (PR 5.4). A range that spans two
// files shows a short "one file at a time" note instead, and a range longer
// than MAX_SELECTED_LINES asks for a smaller one.
//
// The highlight and the button go away on Esc or the next mousedown anywhere
// else; while the block's popup is open the highlight stays, and it is
// cleared when that popup closes.
//
// Alt+E (PR 7.3, see src/a11y.ts) does the same from the keyboard: it
// explains the block when one is selected (pressing Explain selection for
// it), and otherwise the line that has keyboard focus or holds the text
// cursor (explainLineAt in src/clickHandler.ts).

import { isEditable, isExplainShortcut, shortcutTarget } from './a11y';
import { explainCode, explainLineAt, isInteractive, type ClickHandlerDeps } from './clickHandler';
import type { CodeSpan } from './fileContext';
import { locateRange, locateRow, type DiffRange } from './diffDom';
import {
  formatSelection,
  MAX_SELECTED_LINES,
  selectionContext,
  type SelectionContext,
} from './lineContext';
import type { ChatSubject } from './chat/chatPanel';
import type { AnchorRect, PopupAnchor } from './popup/popup';
import { applyTheme, THEME_VARS } from './theme';

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

// The bar uses the popup's theme colors, so it matches GitHub's light or dark
// mode (src/theme.ts, PR 7.3).
const UI_STYLE = `
  :host { all: initial; }
  ${THEME_VARS}
  .bar {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    background: var(--pe-bg);
    border: 1px solid var(--pe-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px var(--pe-shadow);
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    color: var(--pe-fg);
  }
  button {
    font: inherit;
    font-weight: 600;
    color: var(--pe-on-success);
    background: var(--pe-success);
    border: 1px solid var(--pe-success);
    border-radius: 6px;
    padding: 3px 10px;
    cursor: pointer;
  }
  button:hover { background: var(--pe-success-hover); }
  button:focus-visible { outline: 2px solid var(--pe-focus); outline-offset: 1px; }
  .note { padding: 2px 6px; }
`;

/**
 * The file and lines a selection covers, for the chat panel's header. Uses
 * the new file's line numbers, or the old file's when only removed lines are
 * selected.
 */
export function selectionSubject(context: SelectionContext): ChatSubject {
  const kept = context.lines.filter((line) => line.side !== 'removed');
  const numbers = (kept.length ? kept : context.lines).map((line) => line.lineNumber);
  return {
    filePath: context.filePath,
    startLine: Math.min(...numbers),
    endLine: Math.max(...numbers),
  };
}

/** How many code lines a range holds (two per changed split view row). */
function lineCount(range: DiffRange): number {
  return range.items.filter((item) => 'line' in item).length;
}

/**
 * Where a selection is in the new file (PR 6.3), for reading its enclosing
 * block from the full file. Undefined when it is only removed lines.
 */
export function selectionCode(context: SelectionContext): CodeSpan | undefined {
  const kept = context.lines.filter((line) => line.side !== 'removed');
  if (!kept.length) return undefined;
  const numbers = kept.map((line) => line.lineNumber);
  const startLine = Math.min(...numbers);
  return {
    filePath: context.filePath,
    startLine,
    endLine: Math.max(...numbers),
    text: kept.find((line) => line.lineNumber === startLine)!.text,
  };
}

export interface SelectionDeps extends Pick<
  ClickHandlerDeps,
  'explain' | 'openPopup' | 'onContext' | 'onTiming' | 'openChat' | 'addToChat'
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

/**
 * The current text selection as plain values, or null when nothing is
 * selected, so a mouseup can tell whether its own gesture changed it.
 */
function selectionKey(doc: Document): readonly unknown[] | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const r = selection.getRangeAt(0);
  return [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
}

function sameKey(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
  return a !== null && b !== null && a.every((value, i) => value === b[i]);
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
  // Where the last plain click on a line landed (its cell, so split view
  // knows which side), for a later Shift-click.
  let anchorAt: Node | null = null;
  let rows: Element[] = [];
  let ui: HTMLElement | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let explaining = false;
  // Presses the shown Explain selection button, while one is shown.
  let explainSelected: (() => void) | null = null;
  // The text selection when the current gesture's mousedown happened. A drag
  // that ends with the browser still showing this same selection (for
  // example a click on blank space after an earlier drag) made no new one.
  let selectionAtDown: readonly unknown[] | null = null;

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
    explainSelected = null;
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
    applyTheme(host, doc);
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
    // A split view row can hold two lines (removed and added).
    button.textContent = `Explain selection (${lineCount(range)} lines)`;
    const explainBlock = () => {
      removeUi();
      explaining = true;
      const selected = rows;
      const context = selectionContext(range);
      const code = selectionCode(context);
      const request = {
        text: formatSelection(context),
        subject: selectionSubject(context),
        ...(code && { code }),
      };
      explainCode(deps, request, blockAnchor(selected), () => {
        // Only clear the highlight if no newer selection replaced it.
        if (rows === selected) {
          explaining = false;
          clearHighlight();
        }
      });
    };
    button.addEventListener('click', explainBlock);
    showUi(x + win.scrollX, box.bottom + win.scrollY + 4, button);
    explainSelected = explainBlock;
  };

  /**
   * Shows the bar for the range between `ends` (the button, or a note when
   * the range cannot be explained) at window position `x`, under the row
   * `endRow`. Returns false when `ends` are not two rows of one range.
   */
  const offer = (ends: [unknown, unknown], x: number, endRow: Element | null): boolean => {
    const range = locateRange(ends[0] as Node, ends[1] as Node);
    if (!range || (range !== 'other-file' && range.rows.length < 2)) return false;
    const y = (endRow?.getBoundingClientRect().bottom ?? 0) + win.scrollY + 4;
    if (range === 'other-file') showNote(x + win.scrollX, y, OTHER_FILE_NOTE);
    else if (lineCount(range) > MAX_SELECTED_LINES) showNote(x + win.scrollX, y, TOO_MANY_NOTE);
    else select(range, x);
    return true;
  };

  /** Alt+E: the selected block, or else the focused or cursor line. */
  const explainFromKeyboard = (): boolean => {
    if (explainSelected) {
      explainSelected();
      return true;
    }
    const ends = selectionEnds(doc);
    if (
      ends &&
      locateRow(ends[0]) &&
      locateRow(ends[1]) &&
      locateRow(ends[0]) !== locateRow(ends[1])
    ) {
      const endRow = locateRow(ends[1]);
      if (!offer(ends, endRow?.getBoundingClientRect().left ?? 0, endRow)) return false;
      // A note (two files, too many lines) stays up; a block is explained at once.
      // (A cast, since TypeScript cannot see that offer may have set it.)
      (explainSelected as (() => void) | null)?.();
      return true;
    }
    return explainLineAt(
      deps,
      shortcutTarget(doc, (node) => locateRow(node) !== null),
    );
  };

  const onMouseUp = (event: MouseEvent) => {
    if (deps.isEnabled?.() === false || event.button !== 0) return;
    if (ui && event.composedPath().includes(ui)) return;
    const target = event.target;
    if (isInteractive(target)) return;

    let ends: [Node | EventTarget | null, Node | EventTarget | null] | null = null;
    if (event.shiftKey && anchorAt?.isConnected && locateRow(target)) {
      ends = [anchorAt, target];
      // Shift-click also stretches the browser's text selection; it is noise here.
      doc.getSelection()?.removeAllRanges();
    } else {
      const fromText = sameKey(selectionKey(doc), selectionAtDown) ? null : selectionEnds(doc);
      if (fromText && locateRow(fromText[0]) !== locateRow(fromText[1])) ends = fromText;
    }

    if (!ends) {
      // A plain click on a line is where a later Shift-click starts from.
      const row = locateRow(target);
      if (row && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        anchorAt = target instanceof Node ? target : row;
      }
      return;
    }
    offer(ends, event.clientX, locateRow(ends[1]) ?? locateRow(target));
  };

  const onMouseDown = (event: MouseEvent) => {
    selectionAtDown = selectionKey(doc);
    if (ui && event.composedPath().includes(ui)) return;
    clear();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') clear();
    else if (
      isExplainShortcut(event) &&
      deps.isEnabled?.() !== false &&
      !isEditable(event.target) &&
      explainFromKeyboard()
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
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
