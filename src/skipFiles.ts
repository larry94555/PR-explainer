// Files Explain ahead leaves alone (PR 11.4): lockfiles, minified bundles,
// snapshots, generated and vendored code. Nobody clicks those lines, but a
// lockfile change can be hundreds of them, so Whole PR (PR 10.6) would spend
// more time on them than on the code that matters.
//
// A file is skipped when:
// - the repository's `.gitattributes` at the PR's head marks it
//   `linguist-generated` or `linguist-vendored`, as GitHub does to fold it in
//   the diff. A path the file marks `-linguist-generated` or
//   `linguist-vendored=false` is never skipped, even when a pattern below
//   matches it (the repository says it is real code), as GitHub's own
//   defaults give way to the same attributes;
// - or else it matches the **Skip in background** setting's patterns
//   (DEFAULT_SKIP_PATTERNS until changed). The last pattern that matches
//   decides, and one starting with `!` keeps a file a pattern above skips.
//
// Patterns are written as in `.gitignore`: one with no slash, such as
// `*.min.js`, matches the file's name in any folder; one ending in a slash,
// such as `dist/`, matches a folder of that name anywhere; any other is
// matched from the top of the repository. `*` stands for any characters but a
// slash, `**` for any folders, `?` for one character.
//
// Only the `.gitattributes` at the top of the repository is read, once per PR
// and head commit, from raw.githubusercontent.com (so public repositories
// only, as Whole PR itself: a private one simply uses the patterns). Hover and
// your own clicks are never skipped.
//
// This file is part of the content script, which must not share runtime code
// with the service worker or the settings page (see src/content.ts), so the
// default patterns are kept in src/settings.ts too, and skipFiles.test.ts
// checks they agree. The roadmap named it src/explain/skipFiles.ts, but that
// folder is the service worker's, and the skipping happens where Explain
// ahead builds its queue.

import type { PrRef } from './prUrl';

/** The chrome.storage.sync key of the setting (storageKey('skipInBackground')). */
export const SKIP_SETTING_KEY = 'settings.skipInBackground';

/** The patterns skipped when the setting has not been changed. */
export const DEFAULT_SKIP_PATTERNS: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  '*.pb.go',
  '*_pb2.py',
  'dist/',
  'vendor/',
  'node_modules/',
];

/**
 * The patterns in the setting's text: one per line, with blank lines and
 * lines starting with `#` left out. Anything but text is the defaults.
 */
export function skipPatternsOf(stored: unknown): string[] {
  if (typeof stored !== 'string') return [...DEFAULT_SKIP_PATTERNS];
  return stored
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The regular expression for a glob with no leading or trailing slash. */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          // "**/" is any folders (or none); a final "**" is everything below.
          if (i + 2 === glob.length) out += '.*';
          else {
            out += '(?:.*/)?';
            i += 1;
          }
          i += 1;
          continue;
        }
      }
      out += '[^/]*';
      while (glob[i + 1] === '*') i++;
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      i = end;
    } else {
      out += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return out;
}

/**
 * Whether `path` (such as "web/dist/app.js") matches `pattern`. With
 * `filesOnly`, as in `.gitattributes`, a pattern names files only, so `vendor`
 * does not match what is inside a vendor folder; otherwise it does.
 */
export function matchesPattern(path: string, pattern: string, filesOnly = false): boolean {
  let glob = pattern;
  const folder = glob.endsWith('/');
  if (folder) glob = glob.replace(/\/+$/, '');
  const anchored = glob.includes('/');
  glob = glob.replace(/^\//, '');
  if (glob === '') return false;
  const start = anchored ? '^' : '(?:^|/)';
  const end = folder ? '/' : filesOnly ? '$' : '(?:/|$)';
  const source = `${start}${globSource(glob)}${end}`;
  let regex = compiled.get(source);
  if (regex === undefined) {
    // A pattern the setting or a .gitattributes got wrong, such as the
    // backwards range in `[z-a].js`, matches nothing rather than stopping
    // Explain ahead (review on #73).
    try {
      regex = new RegExp(source);
    } catch {
      regex = null;
    }
    compiled.set(source, regex);
  }
  return regex?.test(path) ?? false;
}

/** Each pattern's regular expression, or null when it is not a valid one. */
const compiled = new Map<string, RegExp | null>();

/** One line of a `.gitattributes`: its pattern and the linguist attributes it sets. */
export interface AttributeRule {
  pattern: string;
  /** True when the line marks it generated, false when it unmarks it, left out when it says nothing. */
  generated?: boolean;
  vendored?: boolean;
}

/** What `linguist-generated` (or `-vendored`) is set to by `token`, if it names it. */
function attributeValue(token: string, name: string): boolean | undefined {
  if (token === name || token === `${name}=true`) return true;
  if (token === `-${name}` || token === `!${name}` || token === `${name}=false`) return false;
  return undefined;
}

/** The lines of a `.gitattributes` that set `linguist-generated` or `linguist-vendored`. */
export function parseGitattributes(text: string): AttributeRule[] {
  const rules: AttributeRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let pattern: string;
    let rest: string;
    const quoted = /^"((?:[^"\\]|\\.)*)"\s*(.*)$/.exec(line);
    if (quoted) {
      pattern = quoted[1]!.replace(/\\(.)/g, '$1');
      rest = quoted[2]!;
    } else {
      [pattern, rest] = [line.split(/\s+/)[0]!, line.replace(/^\S+\s*/, '')];
    }
    // Git does not allow negative patterns in .gitattributes.
    if (pattern.startsWith('!')) continue;
    const rule: AttributeRule = { pattern };
    for (const token of rest.split(/\s+/)) {
      const generated = attributeValue(token, 'linguist-generated');
      const vendored = attributeValue(token, 'linguist-vendored');
      if (generated !== undefined) rule.generated = generated;
      if (vendored !== undefined) rule.vendored = vendored;
    }
    if (rule.generated !== undefined || rule.vendored !== undefined) rules.push(rule);
  }
  return rules;
}

/** Why a file is skipped, or null when it is explained. */
export type SkipReason = 'generated' | 'vendored' | 'pattern';

/** Why background work skips `path`, from the repository's rules and the setting's patterns. */
export function skipReason(
  path: string,
  patterns: readonly string[],
  rules: readonly AttributeRule[] = [],
): SkipReason | null {
  let generated: boolean | undefined;
  let vendored: boolean | undefined;
  // The last line that matches sets each attribute, as in git.
  for (const rule of rules) {
    if (!matchesPattern(path, rule.pattern, true)) continue;
    if (rule.generated !== undefined) generated = rule.generated;
    if (rule.vendored !== undefined) vendored = rule.vendored;
  }
  if (generated === true) return 'generated';
  if (vendored === true) return 'vendored';
  if (generated === false || vendored === false) return null;
  let skip = false;
  for (const pattern of patterns) {
    const keep = pattern.startsWith('!');
    if (matchesPattern(path, keep ? pattern.slice(1) : pattern)) skip = !keep;
  }
  return skip ? 'pattern' : null;
}

/** Where a PR's `.gitattributes` is read: at its head commit, or its head ref when not known. */
export function gitattributesUrl(
  pr: Pick<PrRef, 'owner' | 'repo' | 'number'>,
  headSha: string | null,
): string {
  const raw = `https://raw.githubusercontent.com/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;
  return `${raw}/${headSha ?? `refs/pull/${pr.number}/head`}/.gitattributes`;
}

/** How long to wait for the `.gitattributes`. */
export const GITATTRIBUTES_TIMEOUT_MS = 10_000;

export interface GitattributesLoaderDeps {
  /** Reads `url` as text, or null when GitHub has no such file (404). Rejects on other failures. */
  fetchText(url: string, signal: AbortSignal): Promise<string | null>;
  /** The head commit the page shows (headShaFromPage, src/fileContext.ts), or null. */
  headSha(pr: PrRef): string | null;
  timeoutMs?: number;
}

export interface GitattributesLoader {
  /**
   * The rules of `pr`'s `.gitattributes`, none when it has none. Never
   * rejects. Read once per PR and head commit; a failed read gives none and
   * is tried again on the next load.
   */
  load(pr: PrRef): Promise<AttributeRule[]>;
  /** For every page change: forgets rules read when the head commit was not known. */
  forget(): void;
}

export function createGitattributesLoader(deps: GitattributesLoaderDeps): GitattributesLoader {
  const loaded = new Map<string, { sha: string | null; rules: Promise<AttributeRule[]> }>();
  const timeoutMs = deps.timeoutMs ?? GITATTRIBUTES_TIMEOUT_MS;

  const read = async (pr: PrRef, sha: string | null): Promise<AttributeRule[] | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const text = await deps.fetchText(gitattributesUrl(pr, sha), controller.signal);
      return text === null ? [] : parseGitattributes(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    load(pr) {
      const sha = deps.headSha(pr);
      const key = `${pr.owner}/${pr.repo}#${pr.number}@${sha ?? ''}`.toLowerCase();
      const known = loaded.get(key);
      if (known) return known.rules;
      const entry = {
        sha,
        rules: read(pr, sha).then((rules) => {
          if (rules === null && loaded.get(key) === entry) loaded.delete(key);
          return rules ?? [];
        }),
      };
      loaded.set(key, entry);
      return entry.rules;
    },
    forget() {
      for (const [key, entry] of loaded) if (entry.sha === null) loaded.delete(key);
    },
  };
}
