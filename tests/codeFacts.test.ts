import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  blockCounts,
  lineFacts,
  MAX_WAS_LENGTH,
  scopeFromHeader,
  selectionFacts,
  factsFromHunk,
} from '../src/codeFacts';
import { locateLine, locateRange, type DiffLine, type DiffRange } from '../src/diffDom';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

afterEach(() => {
  document.body.innerHTML = '';
});

/** The code cell of the line with this side and number (either side for an unchanged line). */
function cellFor(side: DiffLine['side'], lineNumber: number): Element {
  const found = [...document.querySelectorAll('td')].find((td) => {
    const line = locateLine(td);
    return line?.side === side && line.lineNumber === lineNumber;
  });
  if (!found) throw new Error(`no ${side} line ${lineNumber}`);
  return found;
}

describe('scopeFromHeader', () => {
  it('reads the text after the second @@', () => {
    expect(scopeFromHeader("@@ -43,9 +45,9 @@ describe('manifest.json', () => {")).toBe(
      "describe('manifest.json', () => {",
    );
    expect(scopeFromHeader('  @@ -1 +1 @@   function a() {  ')).toBe('function a() {');
  });

  it('gives nothing when the header names no function or block', () => {
    expect(scopeFromHeader('@@ -0,0 +1,12 @@')).toBeUndefined();
    expect(scopeFromHeader('@@ -1,3 +1,4 @@   ')).toBeUndefined();
    expect(scopeFromHeader('')).toBeUndefined();
  });
});

const ROADMAP_SCOPE = "Update this table (and the PR's heading) when a roadmap PR merges.";

describe.each([
  { name: 'classic', file: 'github-diff-classic.html' },
  { name: 'new (React)', file: 'github-diff-new.html' },
])('lineFacts on the unified $name layout', ({ file }) => {
  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  it('gives the path, line number and function, and the old version of a changed line', () => {
    expect(lineFacts(cellFor('added', 44))).toEqual({
      where: 'docs/roadmap.md, line 44',
      scope: ROADMAP_SCOPE,
      change: 'Changed line, was:',
      was: '| 2.4 | Friendly LLM error messages | Small | Not started |',
    });
  });

  it('calls a removed line removed, numbered in the old file', () => {
    expect(lineFacts(cellFor('removed', 44))).toEqual({
      where: 'docs/roadmap.md, line 44 of the old file',
      scope: ROADMAP_SCOPE,
      change: 'Removed line',
    });
  });

  it('calls an unchanged line unchanged', () => {
    expect(lineFacts(cellFor('context', 45))).toMatchObject({
      where: 'docs/roadmap.md, line 45',
      change: 'Unchanged line',
    });
  });

  it('gives no function when the hunk header names none', () => {
    const header = [...document.querySelectorAll('td')].find((td) =>
      td.textContent?.trim().startsWith('@@'),
    )!;
    const inner = header.querySelector('.diff-text-inner') ?? header;
    inner.textContent = '@@ -41,7 +41,7 @@';
    expect(lineFacts(cellFor('added', 44))).not.toHaveProperty('scope');
  });

  it('gives nothing off a code line', () => {
    expect(lineFacts(document.body)).toBeNull();
    expect(lineFacts(null)).toBeNull();
  });
});

describe.each([
  { name: 'classic', file: 'github-diff-classic-split.html' },
  { name: 'new (React)', file: 'github-diff-new-split.html' },
])('lineFacts on the split $name layout', ({ file }) => {
  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  const SCOPE = "describe('manifest.json', () => {";

  it('gives the old version on the left of the same row for a changed line', () => {
    expect(lineFacts(cellFor('added', 48))).toEqual({
      where: 'tests/manifest.test.ts, line 48',
      scope: SCOPE,
      change: 'Changed line, was:',
      was: "it('injects one content script, only on PR URLs', () => {",
    });
  });

  it('gives no old version for an added line with no removed line next to it', () => {
    // Line 60 has the same text as removed line 62, but further down: not next to it.
    for (const n of [59, 60]) {
      expect(lineFacts(cellFor('added', n))).toEqual({
        where: `tests/manifest.test.ts, line ${n}`,
        scope: SCOPE,
        change: 'Added line',
      });
    }
  });

  it('calls a removed line removed', () => {
    expect(lineFacts(cellFor('removed', 62))).toMatchObject({
      where: 'tests/manifest.test.ts, line 62 of the old file',
      change: 'Removed line',
    });
  });

  it('counts a selection across both sides', () => {
    const range = locateRange(cellFor('removed', 46), cellFor('added', 50)) as DiffRange;
    expect(selectionFacts(range)).toEqual({
      where: 'tests/manifest.test.ts, lines 48 to 50',
      scope: SCOPE,
      change: '5 lines selected, 2 added, 2 removed and 1 unchanged',
    });
  });

  it('counts a selection of removed lines only, in the old file', () => {
    const range = locateRange(cellFor('removed', 62), cellFor('removed', 65)) as DiffRange;
    expect(selectionFacts(range)).toMatchObject({
      where: 'tests/manifest.test.ts, lines 62 to 65 of the old file',
      change: '4 lines selected, 4 removed',
    });
  });
});

describe('factsFromHunk', () => {
  const line = (side: DiffLine['side'], lineNumber: number, text: string): DiffLine => ({
    filePath: 'a.ts',
    lineNumber,
    side,
    text,
  });

  it('pairs each added line with the removed line in the same place of its change', () => {
    const lines = [
      line('removed', 1, 'old one'),
      line('removed', 2, 'old two'),
      line('added', 1, 'new one'),
      line('added', 2, 'new two'),
      line('added', 3, 'new three'),
    ];
    const at = (index: number) => factsFromHunk({ header: '', lines, index });
    expect(at(2).was).toBe('old one');
    expect(at(3).was).toBe('old two');
    expect(at(4)).toEqual({ where: 'a.ts, line 3', change: 'Added line' });
  });

  it('cuts a long old version short', () => {
    const long = 'x'.repeat(200);
    const lines = [line('removed', 1, `   ${long}`), line('added', 1, 'y')];
    const was = factsFromHunk({ header: '', lines, index: 1 }).was!;
    expect(was).toHaveLength(MAX_WAS_LENGTH);
    expect(was.endsWith('…')).toBe(true);
    expect(was.startsWith('x')).toBe(true);
  });
});

describe('blockCounts', () => {
  const lines = (...sides: DiffLine['side'][]) =>
    sides.map((side, i) => ({ filePath: 'a.ts', lineNumber: i + 1, side, text: '' }));

  it('says how many lines and of which kind', () => {
    expect(blockCounts(lines(...Array(8).fill('added'), ...Array(4).fill('removed')))).toBe(
      '12 lines selected, 8 added and 4 removed',
    );
    expect(blockCounts(lines('context', 'context'))).toBe('2 lines selected, 2 unchanged');
    expect(blockCounts(lines('added'))).toBe('1 line selected, 1 added');
  });
});
