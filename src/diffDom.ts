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
  const element = toElement(target);
  if (!element) return null;
  return locateClassic(element) ?? locateNew(element);
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
//     <tr>
//       <td class="blob-num blob-num-addition empty-cell"></td>       old number
//       <td class="blob-num blob-num-addition" data-line-number="44"> new number
//       <td class="blob-code blob-code-addition">
//         <span class="blob-code-inner" data-code-marker="+">code</span>

function locateClassic(element: Element): DiffLine | null {
  const row = element.closest('table.diff-table tr');
  if (!row) return null;
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
}

function classicSide(code: Element): DiffSide | null {
  if (code.classList.contains('blob-code-addition')) return 'added';
  if (code.classList.contains('blob-code-deletion')) return 'removed';
  if (code.classList.contains('blob-code-context')) return 'context';
  return null;
}

// --- New (React) layout -----------------------------------------------------
//
// <table aria-label="Diff for: src/a.ts" data-diff-anchor="diff-<hash>">
//   <tr class="diff-line-row">
//     <td class="diff-line-number"><code></code></td>                  old number
//     <td class="diff-line-number"><code>44</code></td>                new number
//     <td class="diff-text-cell" data-line-anchor="diff-<hash>R44">
//       <code class="diff-text addition">
//         <span class="diff-text-marker">+</span><div class="diff-text-inner">code</div>
//
// Hunk headers are `td.diff-hunk-cell` (with a `code.diff-text-cell` inside),
// so the code cell is matched as a `td`.

function locateNew(element: Element): DiffLine | null {
  const row = element.closest('table[data-diff-anchor] tr.diff-line-row');
  if (!row) return null;
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
}

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
