// DiffDom: turns a click inside a GitHub PR diff into "which file, which
// line, which side". Every GitHub-specific CSS selector lives in this file,
// so when GitHub changes its markup only this file needs a fix.
//
// GitHub currently serves two diff layouts, and both are supported:
// - classic: server-rendered `table.diff-table` with `td.blob-num` and
//   `td.blob-code` cells (what most "Files changed" pages still use).
// - new: the React diff view with `tr.diff-line-row` and `td.diff-text-cell`
//   cells (the new "Files changed" experience and commit pages).
// Only the unified view is handled for now; split view comes in PR 7.2.

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
  return found ? found.layout.readLine(found.row) : null;
}

// Returns the table row of the diff line `target` is in (the element the
// explanation popup is placed next to), or null wherever locateLine returns
// null.
export function locateRow(target: EventTarget | null): Element | null {
  const found = findRow(target);
  return found && found.layout.readLine(found.row) ? found.row : null;
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
  if (!found) return null;
  const { row, layout } = found;
  const line = layout.readLine(row);
  if (!line) return null;

  const before: DiffLine[] = [];
  let header = '';
  for (let r = row.previousElementSibling; r; r = r.previousElementSibling) {
    if (layout.isBoundary(r)) {
      header = layout.headerText(r);
      break;
    }
    const l = layout.readLine(r);
    if (l) before.unshift(l);
  }
  const after: DiffLine[] = [];
  for (let r = row.nextElementSibling; r && !layout.isBoundary(r); r = r.nextElementSibling) {
    const l = layout.readLine(r);
    if (l) after.push(l);
  }
  return { header, lines: [...before, line, ...after], index: before.length };
}

interface Layout {
  // Matches a row of this layout's diff table.
  row: string;
  // Reads a code line row; null for any other row.
  readLine(row: Element): DiffLine | null;
  // True for rows that separate hunks: hunk headers and "expand" rows.
  isBoundary(row: Element): boolean;
  headerText(row: Element): string;
}

function findRow(target: EventTarget | null): { row: Element; layout: Layout } | null {
  const element = toElement(target);
  if (!element) return null;
  for (const layout of [classic, react]) {
    const row = element.closest(layout.row);
    if (row) return { row, layout };
  }
  return null;
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
  readLine(row) {
    const code = row.querySelector('td.blob-code:not(.blob-code-hunk)');
    if (!code) return null;
    const side = classicSide(code);
    if (!side) return null;
    // Unified rows have two number cells: old file, then new file.
    const numbers = row.querySelectorAll('td.blob-num');
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
  readLine(row) {
    const cell = row.querySelector('td.diff-text-cell');
    const code = cell?.querySelector('code.diff-text');
    if (!cell || !code) return null;

    const side: DiffSide = code.classList.contains('addition')
      ? 'added'
      : code.classList.contains('deletion')
        ? 'removed'
        : 'context';
    // The anchor ends in L<n> (old file) or R<n> (new file).
    const anchor = /[LR](\d+)$/.exec(cell.getAttribute('data-line-anchor') ?? '');
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
