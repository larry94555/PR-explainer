// Code facts (PR 9.12): what the extension already knows about the clicked
// code without asking the model, shown at the top of the popup as it opens.
// The file and line, the function or block GitHub names in the hunk header
// (the text after `@@ … @@`), and what kind of change it is. Everything is
// read from the diff on the page (src/diffDom.ts), so no request is sent and
// the line is there from the first moment, whatever the model is doing.

import { locateHunk, type DiffHunk, type DiffLine, type DiffRange } from './diffDom';

export interface CodeFacts {
  /** The file and line(s), such as "src/a.ts, line 12". */
  where: string;
  /** The function or block from the hunk header, when the header names one. */
  scope?: string;
  /** "Added line", "Removed line", "Unchanged line", "Changed line, was:", or a selection's counts. */
  change: string;
  /** The old version of a changed line, shown after "Changed line, was:". */
  was?: string;
}

/** The longest old version shown; longer ones are cut short with "…". */
export const MAX_WAS_LENGTH = 80;

/**
 * The function or block named in a hunk header: the text after the second
 * `@@`, or undefined when there is none (a new file, or a hunk at the top).
 */
export function scopeFromHeader(header: string): string | undefined {
  const match = /^@@[^@]*@@(.*)$/.exec(header.trim());
  const scope = match?.[1]?.trim();
  return scope || undefined;
}

/** The facts for the diff line `target` is on, or null when it is not on a code line. */
export function lineFacts(target: EventTarget | null): CodeFacts | null {
  const hunk = locateHunk(target);
  return hunk ? factsFromHunk(hunk) : null;
}

/** The DOM-free half of lineFacts: the facts for the line at `hunk.index`. */
export function factsFromHunk(hunk: DiffHunk): CodeFacts {
  const line = hunk.lines[hunk.index]!;
  const scope = scopeFromHeader(hunk.header);
  const was = line.side === 'added' ? oldVersion(hunk.lines, hunk.index) : undefined;
  const where =
    `${line.filePath}, line ${line.lineNumber}` +
    (line.side === 'removed' ? ' of the old file' : '');
  return {
    where,
    ...(scope && { scope }),
    ...(was !== undefined
      ? { change: 'Changed line, was:', was: shorten(was) }
      : { change: KIND[line.side] }),
  };
}

const KIND: Record<DiffLine['side'], string> = {
  added: 'Added line',
  removed: 'Removed line',
  context: 'Unchanged line',
};

/**
 * The old version of the added line at `index`, when it is next to it: in
 * unified order a change is its removed lines, then its added lines, and the
 * k-th added line pairs with the k-th removed one, as GitHub's split view
 * shows them side by side. Undefined when the change has no removed line in
 * that position (a line only added).
 */
function oldVersion(lines: readonly DiffLine[], index: number): string | undefined {
  let firstAdded = index;
  while (firstAdded > 0 && lines[firstAdded - 1]!.side === 'added') firstAdded--;
  let firstRemoved = firstAdded;
  while (firstRemoved > 0 && lines[firstRemoved - 1]!.side === 'removed') firstRemoved--;
  const position = index - firstAdded;
  const removed = firstAdded - firstRemoved;
  return position < removed ? lines[firstRemoved + position]!.text : undefined;
}

function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_WAS_LENGTH ? `${trimmed.slice(0, MAX_WAS_LENGTH - 1)}…` : trimmed;
}

/** The facts for a selected block (src/selection.ts). */
export function selectionFacts(range: DiffRange): CodeFacts {
  const lines = range.items.flatMap((item) => ('line' in item ? [item.line] : []));
  const scope = scopeFromHeader(range.first.header);
  return { where: blockWhere(lines), ...(scope && { scope }), change: blockCounts(lines) };
}

/** "src/a.ts, lines 40 to 52", in the new file unless only removed lines are selected. */
function blockWhere(lines: readonly DiffLine[]): string {
  const newLines = lines.filter((l) => l.side !== 'removed');
  const numbers = (newLines.length ? newLines : lines).map((l) => l.lineNumber);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const span = low === high ? `line ${low}` : `lines ${low} to ${high}`;
  return `${lines[0]!.filePath}, ${span}${newLines.length ? '' : ' of the old file'}`;
}

/** "12 lines selected, 8 added and 4 removed". */
export function blockCounts(lines: readonly DiffLine[]): string {
  const count = (side: DiffLine['side']) => lines.filter((l) => l.side === side).length;
  const kinds = (
    [
      [count('added'), 'added'],
      [count('removed'), 'removed'],
      [count('context'), 'unchanged'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  const list =
    kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : (kinds[0] ?? '');
  const total = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} selected`;
  return list ? `${total}, ${list}` : total;
}
