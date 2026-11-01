// Line context: the clicked diff line plus the lines around it from the same
// hunk, the hunk header, and the file's language. This is what the model
// will be given to explain the line (PR 3.3 builds the prompt from it).
import { locateHunk, type DiffHunk, type DiffLine } from './diffDom';

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
