// Expanded file context (PR 6.3): the function or block the clicked code sits
// in, read from the full file at the PR's head commit. The diff often shows
// only a few lines of a long function, so the model would otherwise not know
// what the function is for.
//
// The content script fetches the file (it has the user's GitHub cookies for
// private repos) and finds the enclosing block here, by braces for C-like
// languages and by indentation for Python, Ruby and YAML. When no block is
// found it sends a fixed window of lines instead. The service worker turns
// the result into a part of the prompt that is cut first when the prompt is
// too long (src/explain/fitPrompt.ts).
//
// Removed lines are not in the head file, so they get no file context. Any
// failure (a fetch error, a slow fetch, a file that does not match the diff)
// just leaves the file context out; the explanation goes ahead without it.

import type { FileContext } from './explain/explainPrompt';
import { languageFor } from './lineContext';
import type { PrRef } from './prUrl';

/** The clicked line or selected block, in the new (head) file. */
export interface CodeSpan {
  filePath: string;
  /** First and last line, 1-based, in the new file. */
  startLine: number;
  endLine: number;
  /** The code on `startLine` as the diff shows it, to check the fetched file matches. */
  text: string;
}

/** Lines taken on each side of the code when no enclosing block is found. */
export const WINDOW_LINES = 15;
/** Blocks longer than this are sent as a window instead (a whole class, say). */
export const MAX_BLOCK_LINES = 1000;
/** Files larger than this many characters are not used. */
export const MAX_FILE_CHARS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 3000;

/** A block of the file, 1-based and inclusive. `headerEnd` is the last line of its opening. */
export interface Block {
  start: number;
  end: number;
  headerEnd: number;
}

type Style = 'braces' | 'python' | 'ruby' | 'none';

const INDENT_STYLES: Record<string, Style> = {
  Python: 'python',
  YAML: 'python',
  Ruby: 'ruby',
};
const NO_BLOCKS = new Set(['Plain text', 'Markdown']);

function styleFor(language: string): Style {
  return INDENT_STYLES[language] ?? (NO_BLOCKS.has(language) ? 'none' : 'braces');
}

// Control-flow blocks are skipped when looking for the enclosing function.
const CONTROL =
  /^(}\s*)?(if|else|for|foreach|while|do|switch|try|catch|finally|return|elif|except|with|unless|until|case|begin)\b/;
const FUNCTION_WORDS =
  /\b(function|class|interface|enum|struct|impl|trait|fn|func|fun|def|module|namespace|object|record)\b|=>/;

/** True when a block's opening line looks like a function, method or type. */
function isFunctionLike(header: string): boolean {
  const text = header.trim();
  if (CONTROL.test(text)) return false;
  return FUNCTION_WORDS.test(text) || /\w\s*\(/.test(text);
}

// An unnamed function: an arrow or `function (…)` written as a call's
// argument, such as `items.map((item) => {`, or one on its own line.
const ARROW = String.raw`(async\s+)?(\([^()]*\)|\w+)\s*(:\s*[\w.<>\[\]| ]*)?=>`;
const ANONYMOUS = new RegExp(
  String.raw`^(${ARROW}|(async\s+)?function\s*\()|[(,]\s*(${ARROW}|(async\s+)?function\s*\()`,
);

/** True for a named function, method or type, the block most worth showing. */
function isNamedFunction(header: string): boolean {
  return isFunctionLike(header) && !ANONYMOUS.test(header.trim());
}

// The line with string literals and comments blanked out, so braces and
// parentheses inside them are not counted. `inComment` carries an open /* */
// comment from one line to the next. Strings that span lines are not tracked.
function codeOnly(line: string, state: { inComment: boolean }): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (state.inComment) {
      if (c === '*' && line[i + 1] === '/') {
        state.inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') {
      state.inComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    out += c;
  }
  return out;
}

const count = (text: string, char: string) => text.split(char).length - 1;

// Moves a block's start up over the rest of a signature that spans lines,
// such as parameters on their own lines, or a "{" alone on its line.
function signatureStart(code: string[], open: number): number {
  let start = open;
  if (code[start]!.trim() === '{' && start > 0) start--;
  let depth = count(code[start]!, ')') - count(code[start]!, '(');
  while (depth > 0 && start > 0) {
    start--;
    depth += count(code[start]!, ')') - count(code[start]!, '(');
  }
  return start;
}

function braceBlocks(lines: string[]): Block[] {
  const state = { inComment: false };
  const code = lines.map((line) => codeOnly(line, state));
  const open: number[] = [];
  const blocks: Block[] = [];
  code.forEach((line, i) => {
    for (const c of line) {
      if (c === '{') open.push(i);
      else if (c === '}') {
        const from = open.pop();
        // A block opened and closed on one line, such as `{ a: 1 }`, is not a block here.
        if (from !== undefined && from < i) {
          blocks.push({ start: signatureStart(code, from) + 1, end: i + 1, headerEnd: from + 1 });
        }
      }
    }
  });
  return blocks;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string | undefined) => line === undefined || line.trim() === '';

function indentBlocks(lines: string[], style: 'python' | 'ruby'): Block[] {
  const isHeader = (line: string) => {
    const text = line.replace(/\s+#.*$/, '').trimEnd();
    return style === 'python'
      ? text.endsWith(':')
      : /^\s*(def|class|module|if|unless|while|until|case|begin)\b/.test(text) ||
          /\bdo(\s*\|[^|]*\|)?$/.test(text);
  };
  // Comments dropped, so parentheses in them do not move a signature's start.
  const code = lines.map((l) => l.replace(/#.*$/, ''));
  const blocks: Block[] = [];
  lines.forEach((line, i) => {
    if (isBlank(line) || !isHeader(line)) return;
    // A signature over several lines is indented from its first line.
    const start = signatureStart(code, i);
    const indent = indentOf(lines[start]!);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]!) <= indent) {
        // Ruby closes a block with `end` at the header's indentation.
        if (style === 'ruby' && indentOf(lines[j]!) === indent && /^\s*end\b/.test(lines[j]!)) {
          end = j;
        }
        break;
      }
      end = j;
    }
    if (end > i) blocks.push({ start: start + 1, end: end + 1, headerEnd: i + 1 });
  });
  return blocks;
}

/**
 * The block that holds lines `startLine` to `endLine` (1-based): the nearest
 * named function, method or type around them, else the nearest unnamed
 * function (a callback, such as a test's), else the nearest block of any kind. Null when the code is not inside a block, or the language has
 * none (plain text, Markdown).
 */
export function findEnclosingBlock(
  lines: string[],
  startLine: number,
  endLine: number,
  language: string,
): Block | null {
  const style = styleFor(language);
  if (style === 'none') return null;
  const blocks = style === 'braces' ? braceBlocks(lines) : indentBlocks(lines, style);
  const around = blocks
    .filter((b) => b.start <= startLine && b.end >= endLine)
    // Innermost first.
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  const header = (b: Block) => lines.slice(b.start - 1, b.headerEnd).join(' ');
  // A named function first, so a callback inside it does not hide it.
  return (
    around.find((b) => isNamedFunction(header(b))) ??
    around.find((b) => isFunctionLike(header(b))) ??
    around[0] ??
    null
  );
}

/**
 * The file context for `span` in `fileText`: its enclosing block, or a
 * window of WINDOW_LINES on each side. Null when the file does not have the
 * diff's code at `span.startLine` (the head has moved on, say).
 */
export function buildFileContext(fileText: string, span: CodeSpan): FileContext | null {
  const lines = fileText.replace(/\r\n?/g, '\n').split('\n');
  if (fileText.endsWith('\n')) lines.pop();
  const { startLine, endLine } = span;
  if (startLine < 1 || endLine > lines.length) return null;
  if (lines[startLine - 1]!.trimEnd() !== span.text.trimEnd()) return null;

  const block = findEnclosingBlock(lines, startLine, endLine, languageFor(span.filePath));
  const kind = block && block.end - block.start < MAX_BLOCK_LINES ? 'block' : 'window';
  const first = kind === 'block' ? block!.start : Math.max(1, startLine - WINDOW_LINES);
  const last = kind === 'block' ? block!.end : Math.min(lines.length, endLine + WINDOW_LINES);
  return {
    kind,
    startLine: first,
    lines: lines.slice(first - 1, last),
    focusStart: startLine,
    focusEnd: endLine,
    headerLines: kind === 'block' ? block!.headerEnd - block!.start + 1 : 0,
  };
}

/**
 * The head commit the page shows, when it says: from GitHub's embedded page
 * data, or the most common commit in the page's links to files in this repo
 * (the Files changed tab's "View file" links). Used to fetch the file from a
 * private repo; public repos also work without it.
 */
export function headShaFromPage(doc: Document, pr: Pick<PrRef, 'owner' | 'repo'>): string | null {
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    const found = /"head(?:Ref)?Oid"\s*:\s*"([0-9a-f]{40})"/.exec(script.textContent ?? '');
    if (found) return found[1]!;
  }
  const prefix = `/${pr.owner}/${pr.repo}/blob/`.toLowerCase();
  const counts = new Map<string, number>();
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')!;
    if (!href.toLowerCase().startsWith(prefix)) continue;
    const sha = /^([0-9a-f]{40})\//.exec(href.slice(prefix.length))?.[1];
    if (sha) counts.set(sha, (counts.get(sha) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [sha, n] of counts) if (!best || n > counts.get(best)!) best = sha;
  return best;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Where the file can be read, most likely first: the page's own raw URL at
 * the head commit (works for private repos while signed in), then the PR's
 * head on raw.githubusercontent.com (public repos).
 */
export function rawFileUrls(pr: PrRef, filePath: string, headSha: string | null): string[] {
  const path = encodePath(filePath);
  return [
    ...(headSha ? [`/${pr.owner}/${pr.repo}/raw/${headSha}/${path}`] : []),
    `https://raw.githubusercontent.com/${pr.owner}/${pr.repo}/refs/pull/${pr.number}/head/${path}`,
  ];
}

export interface FileContextLoaderDeps {
  doc: Document;
  /** Fetches a file's text. Rejects on a failed request. */
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  timeoutMs?: number;
}

export interface FileContextLoader {
  /** The file context for `span`, or undefined when it cannot be had. Never rejects. */
  load(pr: PrRef, span: CodeSpan): Promise<FileContext | undefined>;
  /** Forgets fetched files, so a push to the PR is picked up after a navigation. */
  forget(): void;
}

export function createFileContextLoader(deps: FileContextLoaderDeps): FileContextLoader {
  const files = new Map<string, Promise<string | null>>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const fetchFile = async (pr: PrRef, filePath: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (const url of rawFileUrls(pr, filePath, headShaFromPage(deps.doc, pr))) {
        if (controller.signal.aborted) break;
        try {
          const text = await deps.fetchText(url, controller.signal);
          return text.length <= MAX_FILE_CHARS ? text : null;
        } catch {
          // Try the next place.
        }
      }
      throw new Error('not found');
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async load(pr, span) {
      const key = `${pr.owner}/${pr.repo}#${pr.number}:${span.filePath}`;
      let file = files.get(key);
      if (!file) {
        const entry = fetchFile(pr, span.filePath).catch(() => {
          // A failed fetch is tried again on the next click.
          if (files.get(key) === entry) files.delete(key);
          return null;
        });
        file = entry;
        files.set(key, entry);
      }
      const text = await file;
      return (text !== null && buildFileContext(text, span)) || undefined;
    },
    forget() {
      files.clear();
    },
  };
}
