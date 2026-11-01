import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { locateLine } from '../src/diffDom';

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
