import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { locateHunk, type DiffHunk } from '../src/diffDom';
import { contextFromHunk, extractContext, formatContext, languageFor } from '../src/lineContext';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';
const HEADER =
  "@@ -41,7 +41,7 @@ Update this table (and the PR's heading) when a roadmap PR merges.";

// The one hunk in both fixtures, written diff style.
const HUNK = [
  ' | 2.1 | Settings storage | Small | ✅ Done ([#7](https://github.com/larry94555/PR-explainer/pull/7)) |',
  ' | 2.2 | Ollama client: list models and non-streaming chat | Medium | ✅ Done ([#8](https://github.com/larry94555/PR-explainer/pull/8)) |',
  ' | 2.3 | Settings page UI | Medium | ✅ Done ([#9](https://github.com/larry94555/PR-explainer/pull/9)) |',
  '-| 2.4 | Friendly LLM error messages | Small | Not started |',
  '+| 2.4 | Friendly LLM error messages | Small | ✅ Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)) |',
  ' | 3.1 | Diff line locator | Medium | Not started |',
  ' | 3.2 | Hunk context extractor | Small | Not started |',
  ' | 3.3 | Explanation prompt and response parser | Medium | Not started |',
];

afterEach(() => {
  document.body.innerHTML = '';
});

const layouts = [
  {
    name: 'classic',
    file: 'github-diff-classic.html',
    // Each number cell has an id: <anchor>L<old> or <anchor>R<new>.
    code: (id: string) =>
      document.getElementById(`${ANCHOR}${id}`)!.closest('tr')!.querySelector('.blob-code-inner')!,
    headerRow: () => document.querySelector('td.blob-code-hunk')!.closest('tr')!,
  },
  {
    name: 'new (React)',
    file: 'github-diff-new.html',
    code: (id: string) =>
      document.querySelector(`td[data-line-anchor="${ANCHOR}${id}"] .diff-text-inner`)!,
    headerRow: () => document.querySelector('td.diff-hunk-cell')!.closest('tr')!,
  },
];

describe.each(layouts)('extractContext on the $name layout', ({ file, code, headerRow }) => {
  beforeEach(() => {
    document.body.innerHTML = fixture(file);
  });

  it('takes lines before and after a line in the middle of the hunk', () => {
    const context = extractContext(code('R45'), { before: 2, after: 1 })!;
    expect(context.line).toMatchObject({ lineNumber: 45, side: 'context' });
    expect(context.before).toEqual(HUNK.slice(3, 5));
    expect(context.after).toEqual(HUNK.slice(6, 7));
    expect(context.hunkHeader).toBe(HEADER);
    expect(context.language).toBe('Markdown');
  });

  it('keeps both sides of a change, with + and - markers', () => {
    const context = extractContext(code('R44'), { before: 1, after: 1 })!;
    expect(context.before).toEqual([HUNK[3]]);
    expect(context.line.side).toBe('added');
    expect(context.after).toEqual([HUNK[5]]);
  });

  it('stops at the start and end of the hunk', () => {
    const first = extractContext(code('R41'), { before: 10, after: 10 })!;
    expect(first.before).toEqual([]);
    expect(first.after).toEqual(HUNK.slice(1));
    const last = extractContext(code('R47'), { before: 10, after: 10 })!;
    expect(last.before).toEqual(HUNK.slice(0, 7));
    expect(last.after).toEqual([]);
  });

  it('does not cross into the next hunk', () => {
    // Turn the middle of the hunk into a second hunk by adding a header row.
    const second = headerRow().cloneNode(true) as Element;
    second.querySelector('.blob-code-hunk, .diff-text-inner')!.textContent = '@@ -46,2 +46,2 @@';
    code('R46').closest('tr')!.before(second);

    const above = extractContext(code('R45'), { before: 10, after: 10 })!;
    expect(above.after).toEqual([]);
    expect(above.hunkHeader).toBe(HEADER);
    const below = extractContext(code('R46'), { before: 10, after: 10 })!;
    expect(below.before).toEqual([]);
    expect(below.after).toEqual([HUNK[7]]);
    expect(below.hunkHeader).toBe('@@ -46,2 +46,2 @@');
  });

  it('skips rows that are not code lines, such as inline comments', () => {
    const comment = document.createElement('tr');
    comment.className = 'inline-comments diff-line-row';
    comment.innerHTML = '<td colspan="3">Looks good to me</td>';
    code('R45').closest('tr')!.after(comment);
    expect(extractContext(code('R45'), { before: 0, after: 1 })!.after).toEqual([HUNK[6]]);
  });

  it('returns null for hunk headers and clicks outside a diff', () => {
    expect(extractContext(headerRow().lastElementChild)).toBeNull();
    expect(extractContext(document.querySelector('h1'))).toBeNull();
    expect(extractContext(null)).toBeNull();
  });

  it('uses 10 lines each way by default', () => {
    const context = extractContext(code('R44'))!;
    expect(context.before).toEqual(HUNK.slice(0, 4));
    expect(context.after).toEqual(HUNK.slice(5));
  });
});

describe('contextFromHunk', () => {
  const lines = [1, 2, 3, 4, 5].map((n) => ({
    filePath: 'src/a.ts',
    lineNumber: n,
    side: 'context' as const,
    text: `line ${n}`,
  }));
  const hunk: DiffHunk = { header: '@@ -1,5 +1,5 @@', lines, index: 2 };

  it('treats negative counts as zero', () => {
    const context = contextFromHunk(hunk, { before: -1, after: -3 });
    expect(context.before).toEqual([]);
    expect(context.after).toEqual([]);
  });

  it('formats the block sent to the model', () => {
    const removed = {
      ...hunk,
      lines: lines.map((l, i) => (i === 2 ? { ...l, side: 'removed' as const } : l)),
    };
    expect(formatContext(contextFromHunk(removed, { before: 1, after: 1 }))).toBe(
      [
        'File: src/a.ts (TypeScript)',
        'Clicked line: removed, line 3 of the old file',
        '-line 3',
        '',
        'Surrounding diff (the clicked line starts with >):',
        '@@ -1,5 +1,5 @@',
        ' line 2',
        '>-line 3',
        ' line 4',
      ].join('\n'),
    );
  });

  it('leaves out an empty hunk header', () => {
    const text = formatContext(contextFromHunk({ ...hunk, header: '' }, { before: 0, after: 0 }));
    expect(text.endsWith('starts with >):\n> line 3')).toBe(true);
  });
});

describe('locateHunk', () => {
  it('returns the whole hunk and the clicked position', () => {
    document.body.innerHTML = fixture('github-diff-classic.html');
    const hunk = locateHunk(document.getElementById(`${ANCHOR}L44`))!;
    expect(hunk.lines).toHaveLength(8);
    expect(hunk.index).toBe(3);
    expect(hunk.lines[hunk.index]!.side).toBe('removed');
  });
});

describe('languageFor', () => {
  it.each([
    ['src/content.ts', 'TypeScript'],
    ['src/App.tsx', 'TypeScript (TSX)'],
    ['lib/index.js', 'JavaScript'],
    ['app/main.py', 'Python'],
    ['cmd/server.go', 'Go'],
    ['src/lib.rs', 'Rust'],
    ['Main.java', 'Java'],
    ['styles/site.CSS', 'CSS'],
    ['.github/workflows/ci.yml', 'YAML'],
    ['docs/roadmap.md', 'Markdown'],
    ['Dockerfile', 'Dockerfile'],
    ['build/Makefile', 'Makefile'],
    ['.gitignore', 'Plain text'],
    ['LICENSE', 'Plain text'],
    ['data.unknownext', 'Plain text'],
  ])('%s is %s', (path, language) => {
    expect(languageFor(path)).toBe(language);
  });
});
