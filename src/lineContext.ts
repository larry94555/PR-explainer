// Line context: the clicked diff line plus the lines around it from the same
// hunk, the hunk header, and the file's language. This is what the model
// will be given to explain the line (PR 3.3 builds the prompt from it).
import { locateHunk, type DiffHunk, type DiffLine, type DiffRange } from './diffDom';

export interface ContextOptions {
  // How many lines to take from the hunk before and after the clicked line.
  before: number;
  after: number;
}

export const DEFAULT_CONTEXT: ContextOptions = { before: 10, after: 10 };

export interface LineContext {
  line: DiffLine;
  // Lines are written diff style: "+code", "-code" or " code".
  before: string[];
  after: string[];
  hunkHeader: string;
  // A display name such as "TypeScript", or "Plain text" when unknown.
  language: string;
}

// Returns the context for the diff line `target` is on, or null when it is
// not on a code line (the same cases where locateLine returns null).
export function extractContext(
  target: EventTarget | null,
  options: ContextOptions = DEFAULT_CONTEXT,
): LineContext | null {
  const hunk = locateHunk(target);
  return hunk ? contextFromHunk(hunk, options) : null;
}

// The DOM-free half of extractContext, kept separate so it is easy to test.
export function contextFromHunk(hunk: DiffHunk, options: ContextOptions): LineContext {
  // locateHunk guarantees `index` points into `lines`.
  const line = hunk.lines[hunk.index]!;
  const before = hunk.lines.slice(
    Math.max(0, hunk.index - Math.max(0, options.before)),
    hunk.index,
  );
  const after = hunk.lines.slice(hunk.index + 1, hunk.index + 1 + Math.max(0, options.after));
  return {
    line,
    before: before.map(withMarker),
    after: after.map(withMarker),
    hunkHeader: hunk.header,
    language: languageFor(line.filePath),
  };
}

const MARKERS = { added: '+', removed: '-', context: ' ' } as const;

export function withMarker(line: DiffLine): string {
  return MARKERS[line.side] + line.text;
}

// Plain-text block for the console now and the model later.
export function formatContext(context: LineContext): string {
  const { line } = context;
  const fileSide = line.side === 'removed' ? 'old' : 'new';
  return [
    `File: ${line.filePath} (${context.language})`,
    `Clicked line: ${line.side}, line ${line.lineNumber} of the ${fileSide} file`,
    withMarker(line),
    '',
    'Surrounding diff:',
    ...(context.hunkHeader ? [context.hunkHeader] : []),
    ...context.before,
    withMarker(line),
    ...context.after,
  ].join('\n');
}

// --- Selected blocks (PR 4.4) ------------------------------------------------

/** The most lines one selection may hold, to keep the prompt a sensible size. */
export const MAX_SELECTED_LINES = 100;

export interface SelectionContext {
  filePath: string;
  language: string;
  lines: DiffLine[];
  // The selected lines diff style, with the header of any hunk crossed.
  block: string[];
  // Lines before and after the selection, diff style. `hunkHeader` is the
  // header above the first selected line.
  hunkHeader: string;
  before: string[];
  after: string[];
}

// The context for a selected range of lines (see locateRange in diffDom.ts).
export function selectionContext(
  range: DiffRange,
  options: ContextOptions = DEFAULT_CONTEXT,
): SelectionContext {
  const { first, last } = range;
  const lines = range.items.flatMap((item) => ('line' in item ? [item.line] : []));
  return {
    filePath: lines[0]!.filePath,
    language: languageFor(lines[0]!.filePath),
    lines,
    block: range.items.map((item) => ('line' in item ? withMarker(item.line) : item.header)),
    hunkHeader: first.header,
    before: first.lines
      .slice(Math.max(0, first.index - Math.max(0, options.before)), first.index)
      .map(withMarker),
    after: last.lines
      .slice(last.index + 1, last.index + 1 + Math.max(0, options.after))
      .map(withMarker),
  };
}

function lineSpan(numbers: number[]): string {
  if (numbers.length === 0) return '';
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return low === high ? `line ${low}` : `lines ${low} to ${high}`;
}

// One line saying how big the selection is and where it is, such as
// "5 lines (3 added, 2 unchanged); lines 40 to 44 of the new file".
export function describeSelection(lines: DiffLine[]): string {
  const count = (side: DiffLine['side']) => lines.filter((l) => l.side === side).length;
  const kinds = [
    [count('added'), 'added'],
    [count('removed'), 'removed'],
    [count('context'), 'unchanged'],
  ]
    .filter(([n]) => n)
    .map(([n, label]) => `${n} ${label}`);
  const newSpan = lineSpan(lines.filter((l) => l.side !== 'removed').map((l) => l.lineNumber));
  const oldSpan = lineSpan(lines.filter((l) => l.side === 'removed').map((l) => l.lineNumber));
  const where = [
    newSpan && `${newSpan} of the new file`,
    oldSpan && `${oldSpan} of the old file`,
  ].filter(Boolean);
  return `${lines.length} lines (${kinds.join(', ')}); ${where.join(', ')}`;
}

// Plain-text block for a selection. Its second line starts with
// "Selection:", which tells the service worker to ask about the block as a
// whole (see buildExplainPrompt in src/explain/explainPrompt.ts).
export function formatSelection(context: SelectionContext): string {
  return [
    `File: ${context.filePath} (${context.language})`,
    `Selection: ${describeSelection(context.lines)}`,
    '',
    'Lines before the selection:',
    ...(context.hunkHeader ? [context.hunkHeader] : []),
    ...context.before,
    '',
    'Selected lines:',
    ...context.block,
    '',
    'Lines after the selection:',
    ...context.after,
  ].join('\n');
}

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (TSX)',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript (JSX)',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C/C++ header',
  cc: 'C++',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  scala: 'Scala',
  sh: 'Shell',
  bash: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  md: 'Markdown',
  vue: 'Vue',
  svelte: 'Svelte',
};

const FILE_NAMES: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
};

export function languageFor(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  const dot = name.lastIndexOf('.');
  // No extension, or a dotfile such as ".gitignore".
  if (dot <= 0) return 'Plain text';
  return LANGUAGES[name.slice(dot + 1)] ?? 'Plain text';
}
