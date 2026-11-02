// DiffDom: turns a click inside a GitHub PR diff into "which file, which
// line, which side". Every GitHub-specific CSS selector lives in this file,
// so when GitHub changes its markup only this file needs a fix.
//
// GitHub currently serves two diff layouts, and both are supported:
// - classic: server-rendered `table.diff-table` with `td.blob-num` and
//   `td.blob-code` cells (what most "Files changed" pages still use).
// - new: the React diff view with `tr.diff-line-row` and `td.diff-text-cell`
//   cells (the new "Files changed" experience and commit pages).
// Both layouts come in a unified view (one code cell per row) and a split
// view (PR 7.2): each row holds the old file on the left and the new file on
// the right, so a row can carry two lines, a removed one and an added one.
// Which of them a click means is read from the cell it landed in. Lines are
// always given in unified order (a change's removed lines, then its added
// lines), whichever view the page uses, so the model sees the same diff.
//
// Click-to-explain listens on the document, not on each diff, so files that
// GitHub loads later (as you scroll a large PR, or with "Load diff") work as
// soon as they are on the page, with no watcher.

export type DiffSide = 'added' | 'removed' | 'context';

export interface DiffLine {
  filePath: string;
  // Line number in the new file for added and context lines, and in the old
  // file for removed lines.
  lineNumber: number;
  side: DiffSide;
  // The line's code, without the leading +, - or space marker.
  text: string;
}

// Returns the diff line that `target` (usually a click's event.target) is in,
// or null if it is not on a code line of a diff: outside any diff, on a hunk
// header (`@@ ... @@`), on an "expand" row, or in an inline comment.
export function locateLine(target: EventTarget | null): DiffLine | null {
  const found = findRow(target);
  return found ? lineAt(found, target) : null;
}

// Returns the table row of the diff line `target` is in (the element the
// explanation popup is placed next to), or null wherever locateLine returns
// null.
export function locateRow(target: EventTarget | null): Element | null {
  const found = findRow(target);
  return found && lineAt(found, target) ? found.row : null;
}

// The hunk a diff line belongs to: its `@@ ... @@` header and every code line
// between that header and the next one, in page order.
export interface DiffHunk {
  // The header text, such as "@@ -41,7 +41,7 @@ heading", or '' when the
  // page shows no header above the lines (for example a brand-new file).
  header: string;
  lines: DiffLine[];
  // Position in `lines` of the line that `target` is on.
  index: number;
}

// Returns the hunk around the diff line that `target` is in, or null wherever
// locateLine returns null. Lines never cross a hunk header, so a hunk only
// holds lines GitHub shows together. Inline comment rows are skipped.
export function locateHunk(target: EventTarget | null): DiffHunk | null {
  const found = findRow(target);
  const line = found && lineAt(found, target);
  return found && line ? hunkAround(found, line) : null;
}

function hunkAround({ row, layout }: FoundRow, line: DiffLine): DiffHunk {
  let first = row;
  let header = '';
  for (let r = row.previousElementSibling; r; r = r.previousElementSibling) {
    if (layout.isBoundary(r)) {
      header = layout.headerText(r);
      break;
    }
    first = r;
  }
  const lines: DiffLine[] = [];
  for (let r: Element | null = first; r && !layout.isBoundary(r); r = r.nextElementSibling) {
    lines.push(...linesOf(layout, r, null));
  }
  const ordered = unifiedOrder(lines);
  const index = ordered.findIndex((l) => l.side === line.side && l.lineNumber === line.lineNumber);
  return { header, lines: ordered, index };
}

// A block of diff lines the user selected (PR 4.4): every code line from
// `start` to `end` in page order, whichever was selected first.
export interface DiffRange {
  // The code line rows in the range, for highlighting.
  rows: Element[];
  // The range's lines, with the header of any hunk the range crosses in
  // between, in page order.
  items: Array<{ line: DiffLine } | { header: string }>;
  // The hunks around the first and the last line, for the lines before and
  // after the range.
  first: DiffHunk;
  last: DiffHunk;
}

// Returns the lines from the row `start` is in to the row `end` is in,
// 'other-file' when they are in two different files, or null when either is
// not on a code line. The order of `start` and `end` does not matter.
export function locateRange(
  start: EventTarget | null,
  end: EventTarget | null,
): DiffRange | 'other-file' | null {
  const a = findRow(start);
  const b = findRow(end);
  if (!a || !b || !lineAt(a, start) || !lineAt(b, end)) return null;
  // Both layouts use one table per file.
  if (a.layout !== b.layout || a.row.closest('table') !== b.row.closest('table')) {
    return 'other-file';
  }
  const { layout } = a;
  // In split view, a range started and ended on one side holds only that
  // side's lines (GitHub selects text on one side at a time); otherwise both.
  const columnA = columnOf(a.row, start);
  const column = columnA === columnOf(b.row, end) ? columnA : null;
  const backwards = (a.row.compareDocumentPosition(b.row) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  const [firstRow, lastRow] = backwards ? [b.row, a.row] : [a.row, b.row];

  const rows: Element[] = [];
  const items: DiffRange['items'] = [];
  let pending: DiffLine[] = [];
  const flush = () => {
    for (const line of unifiedOrder(pending)) items.push({ line });
    pending = [];
  };
  for (let r: Element | null = firstRow; r; r = r.nextElementSibling) {
    if (layout.isBoundary(r)) {
      flush();
      const header = layout.headerText(r);
      if (header) items.push({ header });
    } else {
      const lines = linesOf(layout, r, column);
      if (lines.length) {
        rows.push(r);
        pending.push(...lines);
      }
    }
    if (r === lastRow) break;
  }
  flush();
  const lines = items.flatMap((item) => ('line' in item ? [item.line] : []));
  if (!lines.length) return null;
  return {
    rows,
    items,
    first: hunkAround({ row: firstRow, layout }, lines[0]!),
    last: hunkAround({ row: lastRow, layout }, lines.at(-1)!),
  };
}

// The left (old file) or right (new file) half of a split view row.
type Column = 'left' | 'right';

interface Layout {
  // Matches a row of this layout's diff table.
  row: string;
  // Reads a code line row: a unified row when `column` is null, or one side
  // of a split row. Null for any other row, or an empty side.
  readLine(row: Element, column: Column | null): DiffLine | null;
  // True for rows that separate hunks: hunk headers and "expand" rows.
  isBoundary(row: Element): boolean;
  headerText(row: Element): string;
}

interface FoundRow {
  row: Element;
  layout: Layout;
}

function findRow(target: EventTarget | null): FoundRow | null {
  const element = toElement(target);
  if (!element) return null;
  for (const layout of [classic, react]) {
    const row = element.closest(layout.row);
    if (row) return { row, layout };
  }
  return null;
}

// A split view row has four cells (old number, old code, new number, new
// code) in both layouts; a unified row has three, a hunk header one or two.
function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter((cell) => cell.tagName === 'TD');
}

function isSplit(row: Element): boolean {
  return cellsOf(row).length === 4;
}

// Which half of a split row `target` is in; null in a unified row, or when
// the target is the row itself rather than one of its cells.
function columnOf(row: Element, target: EventTarget | null): Column | null {
  if (!isSplit(row)) return null;
  const cell = toElement(target)?.closest('td');
  const index = cell ? cellsOf(row).indexOf(cell) : -1;
  if (index < 0) return null;
  return index < 2 ? 'left' : 'right';
}

// The line `target` is on. A split row given as a whole means its new line,
// or its old line when the right side is empty.
function lineAt({ row, layout }: FoundRow, target: EventTarget | null): DiffLine | null {
  if (!isSplit(row)) return layout.readLine(row, null);
  const column = columnOf(row, target);
  if (column) return layout.readLine(row, column);
  return layout.readLine(row, 'right') ?? layout.readLine(row, 'left');
}

// The code lines in a row: one in a unified row; in a split row, the removed
// line and the added line (only one side's when `column` is given). An
// unchanged line shows on both sides of a split row but is one line.
function linesOf(layout: Layout, row: Element, column: Column | null): DiffLine[] {
  if (!isSplit(row)) {
    const line = layout.readLine(row, null);
    return line ? [line] : [];
  }
  const left = layout.readLine(row, 'left');
  const right = layout.readLine(row, 'right');
  if (right?.side === 'context') return [right];
  if (left?.side === 'context') return [left];
  return [column !== 'right' && left, column !== 'left' && right].filter(
    (line): line is DiffLine => !!line,
  );
}

// Puts lines in the order a unified diff shows them: each change's removed
// lines before its added lines. Split view pairs them up side by side, so
// its rows read removed, added, removed, added. Unified rows are already in
// this order.
function unifiedOrder(lines: DiffLine[]): DiffLine[] {
  const ordered: DiffLine[] = [];
  let added: DiffLine[] = [];
  for (const line of lines) {
    if (line.side === 'removed') ordered.push(line);
    else if (line.side === 'added') added.push(line);
    else {
      ordered.push(...added, line);
      added = [];
    }
  }
  return [...ordered, ...added];
}

function toElement(target: EventTarget | null): Element | null {
  // Clicks on text report the Text node as the target in some cases.
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

// --- Classic layout ---------------------------------------------------------
//
// <copilot-diff-entry data-file-path="src/a.ts">
//   <div class="file" data-tagsearch-path="src/a.ts"> ... <table class="diff-table">
//     <tr class="js-expandable-line">                                 hunk header
//       <td class="blob-num blob-num-expandable">...</td>
//       <td class="blob-code blob-code-hunk">@@ -41,7 +41,7 @@ ...</td>
//     <tr>
//       <td class="blob-num blob-num-addition empty-cell"></td>       old number
//       <td class="blob-num blob-num-addition" data-line-number="44"> new number
//       <td class="blob-code blob-code-addition">
//         <span class="blob-code-inner" data-code-marker="+">code</span>

const classic: Layout = {
  row: 'table.diff-table tr',
  readLine(row, column) {
    const cells = cellsOf(row);
    const code = column
      ? cells[column === 'left' ? 1 : 3]
      : row.querySelector('td.blob-code:not(.blob-code-hunk)');
    if (!code?.matches('td.blob-code:not(.blob-code-hunk)')) return null;
    // An empty side of a split row has no side class, so it is skipped too.
    const side = classicSide(code);
    if (!side) return null;
    // Unified rows have two number cells: old file, then new file. Split
    // rows have one in front of each side's code. An unchanged line is
    // numbered in the new file, whichever side was clicked.
    const numbers = column ? [cells[0], cells[2]] : Array.from(row.querySelectorAll('td.blob-num'));
    const numberCell = side === 'removed' ? numbers[0] : numbers[1];
    const lineNumber = Number(numberCell?.getAttribute('data-line-number'));
    const filePath = filePathFor(row);
    if (!filePath || !Number.isInteger(lineNumber) || lineNumber < 1) return null;

    const text = code.querySelector('.blob-code-inner')?.textContent ?? code.textContent ?? '';
    return { filePath, lineNumber, side, text };
  },
  isBoundary: (row) => row.querySelector('td.blob-code-hunk, td.blob-num-expandable') !== null,
  headerText: (row) => row.querySelector('td.blob-code-hunk')?.textContent?.trim() ?? '',
};

function classicSide(code: Element): DiffSide | null {
  if (code.classList.contains('blob-code-addition')) return 'added';
  if (code.classList.contains('blob-code-deletion')) return 'removed';
  if (code.classList.contains('blob-code-context')) return 'context';
  return null;
}

// --- New (React) layout -----------------------------------------------------
//
// <table aria-label="Diff for: src/a.ts" data-diff-anchor="diff-<hash>">
//   <tr class="diff-line-row">                                         hunk header
//     <td class="diff-hunk-cell"><code class="diff-text-cell hunk">
//       <div class="diff-text-inner">@@ -41,7 +41,7 @@ ...</div>
//   <tr class="diff-line-row">
//     <td class="diff-line-number"><code></code></td>                  old number
//     <td class="diff-line-number"><code>44</code></td>                new number
//     <td class="diff-text-cell" data-line-anchor="diff-<hash>R44">
//       <code class="diff-text addition">
//         <span class="diff-text-marker">+</span><div class="diff-text-inner">code</div>
//
// Hunk headers have a `code.diff-text-cell` inside, so the code cell is
// matched as a `td`.

const react: Layout = {
  row: 'table[data-diff-anchor] tr.diff-line-row',
  readLine(row, column) {
    const cells = cellsOf(row);
    const cell = column ? cells[column === 'left' ? 1 : 3] : row.querySelector('td.diff-text-cell');
    // An empty side of a split row is a `td.empty-diff-line`.
    const code = cell?.matches('td.diff-text-cell') && cell.querySelector('code.diff-text');
    if (!cell || !code) return null;

    const side: DiffSide = code.classList.contains('addition')
      ? 'added'
      : code.classList.contains('deletion')
        ? 'removed'
        : 'context';
    // The anchor ends in L<n> (old file) or R<n> (new file). An unchanged
    // line is numbered in the new file, whichever side of a split row it is.
    const numbered = side === 'context' && column === 'left' ? cells[3] : cell;
    const anchor = /[LR](\d+)$/.exec(numbered?.getAttribute('data-line-anchor') ?? '');
    const lineNumber = anchor ? Number(anchor[1]) : NaN;
    const filePath = filePathFor(row);
    if (!filePath || !Number.isInteger(lineNumber) || lineNumber < 1) return null;

    const text = code.querySelector('.diff-text-inner')?.textContent ?? '';
    return { filePath, lineNumber, side, text };
  },
  isBoundary: (row) => row.querySelector('td.diff-hunk-cell') !== null,
  headerText: (row) =>
    row.querySelector('td.diff-hunk-cell .diff-text-inner')?.textContent?.trim() ?? '',
};

// --- File path (both layouts) -----------------------------------------------

const TABLE_LABEL_PREFIX = 'Diff for: ';

function filePathFor(row: Element): string | null {
  const tagged = row.closest('[data-file-path], [data-tagsearch-path]');
  const path =
    tagged?.getAttribute('data-file-path') ?? tagged?.getAttribute('data-tagsearch-path');
  if (path) return path;

  const label = row.closest('table')?.getAttribute('aria-label') ?? '';
  if (label.startsWith(TABLE_LABEL_PREFIX)) return label.slice(TABLE_LABEL_PREFIX.length);
  return null;
}
