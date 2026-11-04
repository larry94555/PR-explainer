import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lineRequest } from '../src/clickHandler';
import { addedLineCells, locateHunk, type DiffHunk } from '../src/diffDom';
import { explainCacheKey } from '../src/explain/explainCache';
import { buildExplainPrompt } from '../src/explain/explainPrompt';
import { hunkRequest } from '../src/explainAhead';
import {
  aheadLines,
  createPatchRequestLoader,
  describePatchResult,
  filesUrl,
  FILES_PER_PAGE,
  MAX_PAGES,
  parsePatch,
  requestsFromFiles,
  type PatchResult,
  type PrFile,
} from '../src/patchRequests';
import type { PrRef } from '../src/prUrl';

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');

// The API's answers for the PRs the saved pages come from (trimmed to a few
// files): PR 10 for github-diff-classic.html and github-diff-new.html (the new
// layout's page is a commit of PR 10 with the same patch), PR 28 for the two
// split pages (the new layout's commit has the same patch for its file).
const PR_10_FILES = JSON.parse(fixture('github-pr-10-files.json')) as PrFile[];
const PR_28_FILES = JSON.parse(fixture('github-pr-28-files.json')) as PrFile[];

const PAGES = [
  ['github-diff-classic.html', PR_10_FILES],
  ['github-diff-new.html', PR_10_FILES],
  ['github-diff-classic-split.html', PR_28_FILES],
  ['github-diff-new-split.html', PR_28_FILES],
] as const;

afterEach(() => {
  document.body.innerHTML = '';
});

/** Every code cell on the page, unified rows and both halves of split rows. */
function codeCells(): Element[] {
  return Array.from(
    document.querySelectorAll(
      'table.diff-table td.blob-code:not(.blob-code-hunk), table[data-diff-anchor] td.diff-text-cell',
    ),
  ).filter((cell) => locateHunk(cell) !== null);
}

function hunksOf(files: readonly PrFile[]): DiffHunk[] {
  return files.flatMap((file) => (file.patch ? parsePatch(file.filename, file.patch) : []));
}

describe('parsePatch', () => {
  it('numbers added and unchanged lines in the new file and removed ones in the old', () => {
    const [hunk, ...rest] = parsePatch(
      'a.ts',
      '@@ -10,4 +10,4 @@ function f() {\n one\n-two\n+TWO\n three\n\\ No newline at end of file',
    );
    expect(rest).toEqual([]);
    expect(hunk).toEqual({
      header: '@@ -10,4 +10,4 @@ function f() {',
      index: 0,
      lines: [
        { filePath: 'a.ts', lineNumber: 10, side: 'context', text: 'one' },
        { filePath: 'a.ts', lineNumber: 11, side: 'removed', text: 'two' },
        { filePath: 'a.ts', lineNumber: 11, side: 'added', text: 'TWO' },
        { filePath: 'a.ts', lineNumber: 12, side: 'context', text: 'three' },
      ],
    });
  });

  it('reads several hunks, a one-line hunk header, empty lines and Windows line endings', () => {
    const hunks = parsePatch('a.ts', '@@ -1 +1 @@\n-a\r\n+b\r\n@@ -20,2 +20,3 @@\n x\n+\n y');
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1 +1 @@', '@@ -20,2 +20,3 @@']);
    expect(hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b']);
    expect(hunks[1]!.lines).toEqual([
      { filePath: 'a.ts', lineNumber: 20, side: 'context', text: 'x' },
      { filePath: 'a.ts', lineNumber: 21, side: 'added', text: '' },
      { filePath: 'a.ts', lineNumber: 22, side: 'context', text: 'y' },
    ]);
  });

  it('reads a new file from line 1', () => {
    const [hunk] = parsePatch('n.ts', '@@ -0,0 +1,2 @@\n+a\n+b');
    expect(hunk!.lines.map((l) => [l.side, l.lineNumber])).toEqual([
      ['added', 1],
      ['added', 2],
    ]);
  });
});

describe.each(PAGES)('the patch against the saved page %s', (page, files) => {
  beforeEach(() => {
    document.body.innerHTML = fixture(page);
  });

  it('gives every drawn hunk exactly as the page reads it, for every line', () => {
    const fromPatch = hunksOf(files);
    const cells = codeCells();
    expect(cells.length).toBeGreaterThan(5);
    for (const cell of cells) {
      const drawn = locateHunk(cell)!;
      const match = fromPatch.find(
        (h) => h.header === drawn.header && h.lines[0]!.filePath === drawn.lines[0]!.filePath,
      );
      expect(match, drawn.header).toBeDefined();
      expect({ ...match!, index: drawn.index }).toEqual(drawn);
    }
  });

  it('builds the same request as a click for every added line drawn', () => {
    const built = new Map(requestsFromFiles(files).lines.map((line) => [line.key, line]));
    const cells = addedLineCells(document);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const click = lineRequest(cell)!.request;
      const key = `${click.subject.filePath}:added:${click.subject.startLine}`;
      // Lines Explain ahead skips (blank, closing brackets) are skipped here too.
      if (!/[^\s)}\];,]/.test(click.code!.text)) {
        expect(built.has(key)).toBe(false);
        continue;
      }
      expect(built.get(key)?.request, key).toEqual(click);
    }
  });

  it('gives Whole PR (PR 10.6) every line, in order, with its hunk for one request per hunk', () => {
    const built = requestsFromFiles(files);
    const lines = aheadLines(built);
    expect(lines.map((l) => l.key)).toEqual(built.lines.map((l) => l.key));
    expect(lines.map((l) => l.order)).toEqual(built.lines.map((_, i) => i));
    lines.forEach((line, i) => {
      expect(line.filePath).toBe(built.lines[i]!.filePath);
      expect(line.request()).toBe(built.lines[i]!.request);
      expect(line.hunk!.id).toBe(`patch:${built.lines[i]!.hunk}`);
    });
    // Each hunk's lines make one request, which names every one of them.
    for (const id of new Set(lines.map((l) => l.hunk!.id))) {
      const ofHunk = lines.filter((l) => l.hunk!.id === id);
      const request = hunkRequest(ofHunk)!;
      expect(request.lines.map((l) => l.label)).toEqual(ofHunk.map((l) => l.key));
      expect(request.lines.map((l) => l.request)).toEqual(ofHunk.map((l) => l.request()));
    }
  });

  it('gives the same prompt and cache key as a click', async () => {
    const [cell] = addedLineCells(document);
    const click = lineRequest(cell!)!.request;
    const line = requestsFromFiles(files).lines.find(
      (l) => l.filePath === click.subject.filePath && l.lineNumber === click.subject.startLine,
    )!;
    const prInfo = { title: 'A PR', description: 'Why' };
    const keyOf = (text: string) =>
      explainCacheKey({
        pr: 'larry94555/PR-explainer#10',
        model: 'qwen2.5-coder:1.5b',
        temperature: 0.2,
        maxResponseTokens: 200,
        messages: buildExplainPrompt(text, prInfo),
      });
    expect(buildExplainPrompt(line.request.text, prInfo)).toEqual(
      buildExplainPrompt(click.text, prInfo),
    );
    expect(await keyOf(line.request.text)).toBe(await keyOf(click.text));
  });
});

describe('requestsFromFiles', () => {
  it('builds a changed line with its old version, and no request for removed lines', () => {
    const { lines } = requestsFromFiles(PR_28_FILES);
    const manifest = lines.filter((l) => l.filePath === 'public/manifest.json');
    // "-matches … pull/*" then "+matches …": one changed line.
    expect(manifest.map((l) => l.key)).toEqual(['public/manifest.json:added:25']);
    expect(manifest[0]!.request.facts).toMatchObject({ change: 'Changed line, was:' });
    expect(lines.some((l) => l.key.includes(':removed:'))).toBe(false);
  });

  it('builds lines of files the page has not drawn, in the PR order', () => {
    const { lines, files } = requestsFromFiles(PR_10_FILES);
    expect(files).toBe(3);
    // The saved page only draws docs/roadmap.md's first hunk.
    const paths = [...new Set(lines.map((l) => l.filePath))];
    expect(paths).toEqual(['docs/roadmap.md', 'src/llm/describeLlmError.ts', 'src/llm/types.ts']);
    const added = lines.filter((l) => l.filePath === 'src/llm/describeLlmError.ts');
    expect(added[0]).toMatchObject({ lineNumber: 1 });
    expect(added[0]!.request.code).toMatchObject({ startLine: 1, endLine: 1 });
  });

  it('numbers hunks across the whole PR', () => {
    const { lines } = requestsFromFiles(PR_28_FILES);
    const hunks = [...new Set(lines.map((l) => l.hunk))];
    expect(hunks).toEqual([...hunks].sort((a, b) => a - b));
    expect(hunks[0]).toBe(0);
    const tests = lines.filter((l) => l.filePath === 'tests/manifest.test.ts');
    expect(new Set(tests.map((l) => l.hunk)).size).toBeGreaterThan(1);
  });

  it('skips blank lines and lines that only close a block', () => {
    const { lines } = requestsFromFiles([
      {
        filename: 'a.ts',
        status: 'modified',
        changes: 4,
        patch: '@@ -1,0 +1,4 @@\n+f();\n+\n+  });\n+}',
      },
    ]);
    expect(lines.map((l) => l.key)).toEqual(['a.ts:added:1']);
  });

  it('lists the files GitHub leaves out, and why', () => {
    const { leftOut } = requestsFromFiles([
      ...PR_28_FILES,
      { filename: 'big.json', status: 'modified', changes: 90_000 },
      { filename: 'new-name.ts', status: 'renamed', changes: 0 },
    ]);
    expect(leftOut).toEqual([
      {
        filePath: 'docs/screenshots/pr-7.1/1-one-popup-after-tab-switches.png',
        reason: 'binary or empty',
      },
      { filePath: 'big.json', reason: 'too big' },
      { filePath: 'new-name.ts', reason: 'renamed only' },
    ]);
  });
});

describe('createPatchRequestLoader', () => {
  const PR: PrRef = { owner: 'larry94555', repo: 'PR-explainer', number: 10, tab: 'files' };

  function setup(options: { pages?: unknown[]; fail?: Error; sha?: () => string | null } = {}) {
    const urls: string[] = [];
    let sha = options.sha ?? (() => 'a'.repeat(40));
    const loader = createPatchRequestLoader({
      fetchJson: async (url) => {
        urls.push(url);
        if (options.fail) throw options.fail;
        const page = Number(new URL(url).searchParams.get('page'));
        return (options.pages ?? [PR_10_FILES])[page - 1] ?? [];
      },
      headSha: () => sha(),
    });
    return { loader, urls, setSha: (next: () => string | null) => void (sha = next) };
  }

  it('reads the API once per head commit', async () => {
    const env = setup();
    const [a, b] = await Promise.all([env.loader.load(PR), env.loader.load(PR)]);
    expect(a).toBe(b);
    expect(await env.loader.load(PR)).toBe(a);
    expect(env.urls).toEqual([filesUrl(PR, 1)]);
    expect(a).toMatchObject({ status: 'done', headSha: 'a'.repeat(40), files: 3, complete: true });
    // A push to the PR gives a new head and a new read.
    env.setSha(() => 'b'.repeat(40));
    await env.loader.load(PR);
    expect(env.urls).toHaveLength(2);
    // A page change keeps lists whose head is known.
    env.loader.forget();
    await env.loader.load(PR);
    expect(env.urls).toHaveLength(2);
  });

  it('reads again after a page change when the head is not known', async () => {
    const env = setup({ sha: () => null });
    await env.loader.load(PR);
    await env.loader.load(PR);
    env.loader.forget();
    await env.loader.load(PR);
    expect(env.urls).toHaveLength(2);
  });

  it('reads every page of a PR with many files, and says when GitHub lists no more', async () => {
    const full = Array.from({ length: FILES_PER_PAGE }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'added',
      changes: 1,
      patch: '@@ -0,0 +1 @@\n+x();',
    }));
    const env = setup({ pages: [full, PR_10_FILES] });
    const result = await env.loader.load(PR);
    expect(env.urls).toEqual([filesUrl(PR, 1), filesUrl(PR, 2)]);
    expect(result).toMatchObject({ files: FILES_PER_PAGE + 3, complete: true });

    const huge = setup({ pages: Array.from({ length: MAX_PAGES + 5 }, () => full) });
    expect(await huge.loader.load(PR)).toMatchObject({ complete: false });
    expect(huge.urls).toHaveLength(MAX_PAGES);
  });

  it('never rejects, and tries again after a failure (a private repository)', async () => {
    const env = setup({ fail: new Error('GitHub answered 404') });
    expect(await env.loader.load(PR)).toEqual({
      status: 'unavailable',
      reason: 'GitHub answered 404',
    });
    await env.loader.load(PR);
    expect(env.urls).toHaveLength(2);
  });

  it('treats an answer that is not a file list as unavailable', async () => {
    const env = setup({ pages: [{ message: 'API rate limit exceeded' }] });
    expect(await env.loader.load(PR)).toMatchObject({ status: 'unavailable' });
  });

  it('stops waiting for a page that takes too long', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const loader = createPatchRequestLoader({
        fetchJson: (_url, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
        headSha: () => null,
        timeoutMs: 50,
      });
      const result = loader.load(PR);
      await vi.advanceTimersByTimeAsync(50);
      expect(aborted).toBe(true);
      expect(await result).toMatchObject({ status: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('filesUrl and describePatchResult', () => {
  it('addresses one page of the PR files on the GitHub API', () => {
    expect(filesUrl({ owner: 'o', repo: 'r', number: 7 }, 2)).toBe(
      'https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=2',
    );
  });

  it('sums up a result for the debug window', () => {
    const done: PatchResult = {
      status: 'done',
      headSha: null,
      ...requestsFromFiles(PR_28_FILES),
      complete: true,
    };
    expect(describePatchResult(done)).toMatch(/^3 files, \d+ lines, 1 left out$/);
    expect(describePatchResult({ status: 'unavailable', reason: 'GitHub answered 404' })).toBe(
      'PR files could not be read: GitHub answered 404',
    );
  });
});
