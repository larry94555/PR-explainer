import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { locateHunk, locateLine, locateRange, locateRow, type DiffRange } from '../src/diffDom';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

const PATH = 'docs/roadmap.md';
const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`fixture has no ${selector}`);
  return found;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('locateLine on the classic diff layout', () => {
  beforeEach(() => {
    document.body.innerHTML = fixture('github-diff-classic.html');
  });

  // In the classic layout each number cell has an id: <anchor>L<old> or <anchor>R<new>.
  function codeOf(numberId: string): Element {
    return el(`#${numberId}`).closest('tr')!.querySelector('.blob-code-inner')!;
  }

  it('finds an added line from a click on its code', () => {
    expect(locateLine(codeOf(`${ANCHOR}R44`))).toEqual({
      filePath: PATH,
      lineNumber: 44,
      side: 'added',
      text: '| 2.4 | Friendly LLM error messages | Small | ✅ Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)) |',
    });
  });

  it('finds a removed line, numbered in the old file', () => {
    expect(locateLine(codeOf(`${ANCHOR}L44`))).toEqual({
      filePath: PATH,
      lineNumber: 44,
      side: 'removed',
      text: '| 2.4 | Friendly LLM error messages | Small | Not started |',
    });
  });

  it('finds a context line, numbered in the new file', () => {
    expect(locateLine(codeOf(`${ANCHOR}R45`))).toEqual({
      filePath: PATH,
      lineNumber: 45,
      side: 'context',
      text: '| 3.1 | Diff line locator | Medium | Not started |',
    });
  });

  it('gives the same answer for a click on the line number as on the code', () => {
    expect(locateLine(el(`#${ANCHOR}R45`))).toEqual(locateLine(codeOf(`${ANCHOR}R45`)));
    expect(locateLine(el(`#${ANCHOR}L45`))).toEqual(locateLine(codeOf(`${ANCHOR}R45`)));
  });

  it('finds the line from a click on a nested highlight span or a text node', () => {
    const highlight = codeOf(`${ANCHOR}R44`).querySelector('.x')!;
    expect(locateLine(highlight)?.lineNumber).toBe(44);
    expect(locateLine(highlight.firstChild)?.side).toBe('added');
  });

  it('returns null for the hunk header and expand rows', () => {
    expect(locateLine(el('.blob-code-hunk'))).toBeNull();
    expect(locateLine(el('.blob-num-expandable'))).toBeNull();
  });

  it('returns null outside a diff', () => {
    expect(locateLine(el('.gh-header-title'))).toBeNull();
    expect(locateLine(el('.file-header a'))).toBeNull();
    expect(locateLine(document.body)).toBeNull();
    expect(locateLine(null)).toBeNull();
  });

  it('falls back to data-tagsearch-path when there is no data-file-path', () => {
    el('copilot-diff-entry').removeAttribute('data-file-path');
    expect(locateLine(codeOf(`${ANCHOR}R44`))?.filePath).toBe(PATH);
  });
});

describe('locateLine on the new (React) diff layout', () => {
  beforeEach(() => {
    document.body.innerHTML = fixture('github-diff-new.html');
  });

  function codeOf(lineAnchor: string): Element {
    return el(`td[data-line-anchor="${lineAnchor}"] .diff-text-inner`);
  }

  it('finds an added line from a click on its code', () => {
    expect(locateLine(codeOf(`${ANCHOR}R44`))).toEqual({
      filePath: PATH,
      lineNumber: 44,
      side: 'added',
      text: '| 2.4 | Friendly LLM error messages | Small | ✅ Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)) |',
    });
  });

  it('finds a removed line, numbered in the old file, without the marker', () => {
    expect(locateLine(codeOf(`${ANCHOR}L44`))).toEqual({
      filePath: PATH,
      lineNumber: 44,
      side: 'removed',
      text: '| 2.4 | Friendly LLM error messages | Small | Not started |',
    });
  });

  it('finds a context line, numbered in the new file', () => {
    expect(locateLine(codeOf(`${ANCHOR}R45`))).toMatchObject({
      lineNumber: 45,
      side: 'context',
      text: '| 3.1 | Diff line locator | Medium | Not started |',
    });
  });

  it('gives the same answer for a click on the line number or the +/- marker', () => {
    const row = codeOf(`${ANCHOR}R44`).closest('tr')!;
    const expected = locateLine(codeOf(`${ANCHOR}R44`));
    expect(locateLine(row.querySelector('td.diff-line-number'))).toEqual(expected);
    expect(locateLine(row.querySelector('.diff-text-marker'))).toEqual(expected);
  });

  it('returns null for the hunk header', () => {
    expect(locateLine(el('td.diff-hunk-cell'))).toBeNull();
    expect(locateLine(el('code.diff-text-cell.hunk'))).toBeNull();
  });

  it('returns null outside a diff', () => {
    expect(locateLine(el('h1'))).toBeNull();
    expect(locateLine(el('.file-header code'))).toBeNull();
  });

  it('prefers a data-file-path on a wrapper over the table label', () => {
    el(`#${ANCHOR}`).setAttribute('data-file-path', 'renamed/path.md');
    expect(locateLine(codeOf(`${ANCHOR}R44`))?.filePath).toBe('renamed/path.md');
  });

  it('returns null when the file path cannot be found', () => {
    el('table').removeAttribute('aria-label');
    expect(locateLine(codeOf(`${ANCHOR}R44`))).toBeNull();
  });
});

// Split view (PR 7.2): each row holds the old file on the left and the new
// file on the right. Both fixtures are tests/manifest.test.ts from PR #28.
const SPLIT_PATH = 'tests/manifest.test.ts';
const SPLIT_HUNK_1 = "@@ -43,9 +45,9 @@ describe('manifest.json', () => {";
const SPLIT_HUNK_2 = "@@ -54,15 +56,16 @@ describe('manifest.json', () => {";

const splitLayouts = [
  { name: 'classic', file: 'github-diff-classic-split.html' },
  { name: 'new (React)', file: 'github-diff-new-split.html' },
];

describe.each(splitLayouts)('split view on the $name layout', ({ file }) => {
  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  // The code rows in page order (hunk headers left out), and their four
  // cells: old number, old code, new number, new code.
  const codeRows = () =>
    [...document.querySelectorAll('tbody tr')].filter((r) => r.children.length === 4);
  const cell = (rowIndex: number, cellIndex: number) => codeRows()[rowIndex]!.children[cellIndex]!;
  // The row whose new (or old) side has this line number.
  const rowWith = (column: 'left' | 'right', n: number) => {
    const at = column === 'left' ? 1 : 3;
    const found = codeRows().findIndex((r) => {
      const line = locateLine(r.children[at]!);
      return line?.lineNumber === n && (column === 'right' || line.side !== 'context');
    });
    if (found < 0) throw new Error(`no ${column} line ${n}`);
    return found;
  };
  // Lines written as "a48" (added line 48), "r46" (removed) or "c49" (unchanged).
  const short = (lines: { side: string; lineNumber: number }[]) =>
    lines.map((l) => `${l.side[0]}${l.lineNumber}`).join(' ');

  it('treats a click on the left of a changed row as the removed line, in the old file', () => {
    const row = rowWith('left', 46);
    expect(locateLine(cell(row, 1))).toEqual({
      filePath: SPLIT_PATH,
      lineNumber: 46,
      side: 'removed',
      text: "  it('injects one content script, only on PR URLs', () => {",
    });
    // The line number cell and a nested span give the same answer.
    expect(locateLine(cell(row, 0))).toEqual(locateLine(cell(row, 1)));
    const span = cell(row, 1).querySelector('.diff-text-inner span, .blob-code-inner span');
    expect(locateLine(span ?? cell(row, 1))).toEqual(locateLine(cell(row, 1)));
  });

  it('treats a click on the right of the same row as the added line, in the new file', () => {
    const row = rowWith('left', 46);
    expect(locateLine(cell(row, 3))).toMatchObject({
      filePath: SPLIT_PATH,
      lineNumber: 48,
      side: 'added',
    });
    expect(locateLine(cell(row, 3))!.text).toMatch(/^ {2}it\('injects one content script/);
    expect(locateLine(cell(row, 2))).toEqual(locateLine(cell(row, 3)));
  });

  it('numbers an unchanged line in the new file on either side', () => {
    const row = rowWith('right', 49);
    expect(locateLine(cell(row, 1))).toEqual(locateLine(cell(row, 3)));
    expect(locateLine(cell(row, 1))).toMatchObject({ lineNumber: 49, side: 'context' });
  });

  it('reads added-only and removed-only rows, and ignores their empty side', () => {
    const added = rowWith('right', 59);
    expect(locateLine(cell(added, 3))).toMatchObject({ lineNumber: 59, side: 'added' });
    expect(locateLine(cell(added, 1))).toBeNull();
    expect(locateLine(cell(added, 0))).toBeNull();
    expect(locateRow(cell(added, 1))).toBeNull();

    const removed = rowWith('left', 62);
    expect(locateLine(cell(removed, 1))).toMatchObject({ lineNumber: 62, side: 'removed' });
    expect(locateLine(cell(removed, 3))).toBeNull();
    expect(locateRow(cell(removed, 3))).toBeNull();
    expect(locateRow(cell(removed, 1))).toBe(codeRows()[removed]);
  });

  it('reads a row given as a whole as its new line, or its old line when that is all it has', () => {
    expect(locateLine(codeRows()[rowWith('left', 46)]!)).toMatchObject({ side: 'added' });
    expect(locateLine(codeRows()[rowWith('left', 62)]!)).toMatchObject({ side: 'removed' });
  });

  it('returns null for hunk headers', () => {
    const headers = [...document.querySelectorAll('tbody tr')].filter((r) => r.children.length < 4);
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(locateLine(header.firstElementChild)).toBeNull();
  });

  it('gives the hunk in unified order: each change removed lines first, every line once', () => {
    const hunk = locateHunk(cell(rowWith('left', 46), 3))!;
    expect(hunk.header).toBe(SPLIT_HUNK_1);
    expect(short(hunk.lines)).toBe('c45 c46 c47 r46 a48 c49 r48 a50 c51 c52 c53');
    expect(short([hunk.lines[hunk.index]!])).toBe('a48');
    // The left side of the same row points at the removed line in the same hunk.
    const left = locateHunk(cell(rowWith('left', 46), 1))!;
    expect(left.lines).toEqual(hunk.lines);
    expect(short([left.lines[left.index]!])).toBe('r46');
  });

  it('keeps added-only and removed-only rows of a hunk in place', () => {
    const hunk = locateHunk(cell(rowWith('left', 63), 1))!;
    expect(hunk.header).toBe(SPLIT_HUNK_2);
    expect(short(hunk.lines)).toBe(
      'c56 c57 c58 a59 a60 a61 a62 a63 c64 c65 c66 c67 c68 r62 r63 r64 r65 c69 c70 c71',
    );
    expect(short([hunk.lines[hunk.index]!])).toBe('r63');
  });

  const items = (range: DiffRange | 'other-file' | null) =>
    range && range !== 'other-file'
      ? range.items.map((i) => ('line' in i ? short([i.line]) : i.header)).join(' ')
      : range;

  it('selects one side only when a range starts and ends on that side', () => {
    const from = rowWith('right', 47);
    const to = rowWith('right', 51);
    expect(items(locateRange(cell(from, 1), cell(to, 1)))).toBe('c47 r46 c49 r48 c51');
    expect(items(locateRange(cell(from, 3), cell(to, 3)))).toBe('c47 a48 c49 a50 c51');
  });

  it('selects both sides, in unified order, for a range that crosses sides', () => {
    const range = locateRange(cell(rowWith('right', 51), 3), cell(rowWith('right', 47), 1));
    expect(items(range)).toBe('c47 r46 a48 c49 r48 a50 c51');
    expect((range as DiffRange).rows).toHaveLength(5);
  });

  it('puts the header between the lines of a range that crosses hunks', () => {
    const range = locateRange(cell(rowWith('right', 52), 3), cell(rowWith('right', 57), 3));
    expect(items(range)).toBe(`c52 c53 ${SPLIT_HUNK_2} c56 c57`);
    const { first, last } = range as DiffRange;
    expect(first.header).toBe(SPLIT_HUNK_1);
    expect(short([first.lines[first.index]!])).toBe('c52');
    expect(last.header).toBe(SPLIT_HUNK_2);
    expect(short([last.lines[last.index]!])).toBe('c57');
  });
});
