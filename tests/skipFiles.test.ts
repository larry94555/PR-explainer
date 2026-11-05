import {
  createGitattributesLoader,
  DEFAULT_SKIP_PATTERNS,
  gitattributesUrl,
  matchesPattern,
  parseGitattributes,
  skipPatternsOf,
  skipReason,
} from '../src/skipFiles';
import type { PrRef } from '../src/prUrl';

const PR: PrRef = { owner: 'octo', repo: 'app', number: 7, tab: 'files' };
const defaults = [...DEFAULT_SKIP_PATTERNS];
const skipped = (path: string, patterns = defaults, attributes = '') =>
  skipReason(path, patterns, parseGitattributes(attributes)) !== null;

describe('the default patterns (PR 11.4)', () => {
  it.each([
    'package-lock.json',
    'web/package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'crates/core/Cargo.lock',
    'go.sum',
    'poetry.lock',
    'static/app.min.js',
    'static/app.min.css',
    'static/app.js.map',
    'src/__snapshots__/view.test.ts.snap',
    'api/user.pb.go',
    'proto/user_pb2.py',
    'dist/index.js',
    'packages/ui/dist/index.js',
    'vendor/github.com/pkg/errors/errors.go',
    'node_modules/left-pad/index.js',
  ])('skips %s', (path) => {
    expect(skipped(path)).toBe(true);
  });

  it.each([
    'src/app.ts',
    'package.json',
    'src/package-lock.json.ts',
    'docs/go.summary.md',
    'src/minify.js',
    'src/map.ts',
    'src/distance.ts',
    'src/vendors.ts',
    'lib/my_dist/file.ts',
  ])('explains %s', (path) => {
    expect(skipped(path)).toBe(false);
  });
});

describe('patterns', () => {
  it('matches a name in any folder, a folder anywhere, or from the top', () => {
    expect(matchesPattern('a/b/c.min.js', '*.min.js')).toBe(true);
    expect(matchesPattern('a/build/c.js', 'build/')).toBe(true);
    // A folder pattern is not a file of that name.
    expect(matchesPattern('a/build', 'build/')).toBe(false);
    // With a slash it is matched from the top.
    expect(matchesPattern('gen/api.ts', 'gen/*.ts')).toBe(true);
    expect(matchesPattern('src/gen/api.ts', 'gen/*.ts')).toBe(false);
    expect(matchesPattern('gen/api.ts', '/gen/*.ts')).toBe(true);
    // "*" stays within a folder; "**" crosses them.
    expect(matchesPattern('gen/v1/api.ts', 'gen/*.ts')).toBe(false);
    expect(matchesPattern('gen/v1/api.ts', 'gen/**/*.ts')).toBe(true);
    expect(matchesPattern('gen/api.ts', 'gen/**/*.ts')).toBe(true);
    expect(matchesPattern('x/y/gen/api.ts', '**/gen/*.ts')).toBe(true);
    expect(matchesPattern('gen/v1/api.ts', 'gen/**')).toBe(true);
    // "?" and character classes.
    expect(matchesPattern('a1.txt', 'a?.txt')).toBe(true);
    expect(matchesPattern('a/1.txt', 'a?1.txt')).toBe(false);
    expect(matchesPattern('v2.json', 'v[0-9].json')).toBe(true);
    expect(matchesPattern('vx.json', 'v[!0-9].json')).toBe(true);
    expect(matchesPattern('v2.json', 'v[!0-9].json')).toBe(false);
    // Dots and other characters are themselves.
    expect(matchesPattern('a-min-js', '*.min.js')).toBe(false);
    expect(matchesPattern('a(1).js', 'a(1).js')).toBe(true);
  });

  it('matches what is inside a folder named without a slash, except in .gitattributes', () => {
    expect(matchesPattern('vendor/lib.js', 'vendor')).toBe(true);
    expect(matchesPattern('vendor/lib.js', 'vendor', true)).toBe(false);
    expect(matchesPattern('vendor', 'vendor', true)).toBe(true);
  });

  it('adds and removes patterns from the setting', () => {
    // Removed: lockfiles are explained.
    const noLocks = defaults.filter((p) => !/lock|go\.sum/.test(p));
    expect(skipped('package-lock.json', noLocks)).toBe(false);
    expect(skipped('yarn.lock', noLocks)).toBe(false);
    expect(skipped('app.min.js', noLocks)).toBe(true);
    // Added.
    expect(skipped('src/generated/api.ts', [...defaults, 'generated/'])).toBe(true);
    // "!" keeps a file a pattern above skips; the last match decides.
    expect(skipped('static/keep.min.js', [...defaults, '!keep.min.js'])).toBe(false);
    expect(skipped('static/keep.min.js', ['!keep.min.js', '*.min.js'])).toBe(true);
    // Nothing set skips nothing.
    expect(skipped('package-lock.json', [])).toBe(false);
  });

  it('reads the setting one pattern per line, without blanks and comments', () => {
    expect(skipPatternsOf('*.min.js\r\n\n  dist/  \n# a note\n!keep.js')).toEqual([
      '*.min.js',
      'dist/',
      '!keep.js',
    ]);
    expect(skipPatternsOf('')).toEqual([]);
    expect(skipPatternsOf(undefined)).toEqual(defaults);
    expect(skipPatternsOf(42)).toEqual(defaults);
  });
});

describe('.gitattributes', () => {
  const ATTRIBUTES = [
    '# Generated code',
    '*.gen.ts linguist-generated',
    'api/client/** linguist-generated=true',
    'third_party/** linguist-vendored',
    '"docs/My Files/*.md" linguist-generated',
    '* text=auto',
    '*.png binary',
    // Negations: real code, even though a pattern or line above says otherwise.
    'api/client/hand-written.ts -linguist-generated',
    'dist/** linguist-vendored=false',
    'package-lock.json !linguist-generated',
  ].join('\n');

  it('reads only the lines that set linguist-generated or linguist-vendored', () => {
    expect(parseGitattributes(ATTRIBUTES)).toEqual([
      { pattern: '*.gen.ts', generated: true },
      { pattern: 'api/client/**', generated: true },
      { pattern: 'third_party/**', vendored: true },
      { pattern: 'docs/My Files/*.md', generated: true },
      { pattern: 'api/client/hand-written.ts', generated: false },
      { pattern: 'dist/**', vendored: false },
      { pattern: 'package-lock.json', generated: false },
    ]);
    expect(parseGitattributes('!*.ts linguist-generated\n\r\n')).toEqual([]);
  });

  it('skips the files it marks generated or vendored', () => {
    const rules = parseGitattributes(ATTRIBUTES);
    expect(skipReason('src/model.gen.ts', defaults, rules)).toBe('generated');
    expect(skipReason('api/client/v1/users.ts', defaults, rules)).toBe('generated');
    expect(skipReason('third_party/zlib/inflate.c', defaults, rules)).toBe('vendored');
    expect(skipReason('docs/My Files/index.md', defaults, rules)).toBe('generated');
    expect(skipReason('src/app.ts', defaults, rules)).toBeNull();
    expect(skipReason('static/app.min.js', defaults, rules)).toBe('pattern');
  });

  it('explains a file it unmarks, even when a line above or a pattern skips it', () => {
    const rules = parseGitattributes(ATTRIBUTES);
    expect(skipReason('api/client/hand-written.ts', defaults, rules)).toBeNull();
    expect(skipReason('dist/index.js', defaults, rules)).toBeNull();
    expect(skipReason('package-lock.json', defaults, rules)).toBeNull();
    // The last line that matches decides.
    const later = parseGitattributes('a.ts -linguist-generated\na.ts linguist-generated');
    expect(skipReason('a.ts', [], later)).toBe('generated');
  });

  it('with no .gitattributes, uses the patterns alone', () => {
    expect(skipReason('package-lock.json', defaults, [])).toBe('pattern');
    expect(skipReason('src/model.gen.ts', defaults, [])).toBeNull();
  });
});

describe('reading .gitattributes once per PR', () => {
  function loaderSetup(
    answer: (url: string) => Promise<string | null>,
    sha: string | null = 'f00',
  ) {
    const fetchText = vi.fn((url: string) => answer(url));
    let head = sha;
    const loader = createGitattributesLoader({ fetchText, headSha: () => head });
    return { loader, fetchText, setHead: (value: string | null) => (head = value) };
  }

  it("reads it from the PR's head commit, or its head ref when the page does not say", () => {
    expect(gitattributesUrl(PR, 'f00')).toBe(
      'https://raw.githubusercontent.com/octo/app/f00/.gitattributes',
    );
    expect(gitattributesUrl(PR, null)).toBe(
      'https://raw.githubusercontent.com/octo/app/refs/pull/7/head/.gitattributes',
    );
  });

  it('fetches once per PR and head commit', async () => {
    const env = loaderSetup(async () => '*.gen.ts linguist-generated');
    const [first, second] = await Promise.all([env.loader.load(PR), env.loader.load(PR)]);
    expect(first).toEqual([{ pattern: '*.gen.ts', generated: true }]);
    expect(second).toBe(first);
    await env.loader.load({ ...PR, tab: 'conversation' });
    expect(env.fetchText).toHaveBeenCalledTimes(1);
    // A new commit is read again.
    env.setHead('ba5');
    await env.loader.load(PR);
    expect(env.fetchText).toHaveBeenCalledTimes(2);
    expect(env.fetchText.mock.calls[1]![0]).toContain('/ba5/');
    // Another PR is its own.
    await env.loader.load({ ...PR, number: 8 });
    expect(env.fetchText).toHaveBeenCalledTimes(3);
  });

  it('gives no rules when the repository has none, and keeps that answer', async () => {
    const env = loaderSetup(async () => null);
    await expect(env.loader.load(PR)).resolves.toEqual([]);
    await env.loader.load(PR);
    expect(env.fetchText).toHaveBeenCalledTimes(1);
  });

  it('gives no rules when the read fails, and tries again next time', async () => {
    const env = loaderSetup(async () => {
      throw new Error('GitHub answered 500');
    });
    await expect(env.loader.load(PR)).resolves.toEqual([]);
    await env.loader.load(PR);
    expect(env.fetchText).toHaveBeenCalledTimes(2);
  });

  it('gives up after its time limit', async () => {
    vi.useFakeTimers();
    try {
      const fetchText = vi.fn(
        (_url: string, signal: AbortSignal) =>
          new Promise<string | null>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      );
      const loader = createGitattributesLoader({ fetchText, headSha: () => 'f00', timeoutMs: 50 });
      const rules = loader.load(PR);
      vi.advanceTimersByTime(50);
      await expect(rules).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets rules read without a known head on a page change', async () => {
    const env = loaderSetup(async () => '', null);
    await env.loader.load(PR);
    env.loader.forget();
    await env.loader.load(PR);
    expect(env.fetchText).toHaveBeenCalledTimes(2);
    env.setHead('f00');
    await env.loader.load(PR);
    env.loader.forget();
    await env.loader.load(PR);
    expect(env.fetchText).toHaveBeenCalledTimes(3);
  });
});
