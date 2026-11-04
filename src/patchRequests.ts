// Line requests from the PR's diff (PR 10.4), not from the page.
//
// A click builds its request from the hunk GitHub draws on the page
// (lineRequest in src/clickHandler.ts). GitHub does not draw a file until you
// scroll near it, and folds big ones, so lines further down a PR cannot be
// explained ahead from the page. GitHub's API returns every file's diff at
// once (`/repos/{owner}/{repo}/pulls/{n}/files`, the `patch` of each file),
// and this file turns it into the same requests a click on each line would
// send: each patch hunk becomes the DiffHunk the page would give
// (src/diffDom.ts), and requestFromHunk builds the request from it, as a
// click does. Same text, same code span, so the same prompt and the same
// cache key, and a later click on the line finds the answer
// (tests/patchRequests.test.ts checks this against saved GitHub pages).
//
// As Explain ahead does (PR 9.10), only added lines are built (a changed
// line's new version is an added line), and blank lines and lines that only
// close a block are skipped. Files GitHub leaves out of the API's diff (too
// big, binary or empty, or renamed with no change) are listed, and are left
// to be explained from the page once it draws them.
//
// The list is fetched once per PR and head commit. It is read without your
// GitHub sign-in (the API does not take the site's cookies), so it works for
// public repositories; for a private one GitHub answers 404 and the result
// says so, and everything works from the page as before. It only builds
// requests: Explain ahead's Whole PR (PR 10.6) sends them, one request per
// hunk (PR 10.5), through aheadLines.
//
// This file is part of the content script, which must not share runtime code
// with the service worker (see src/content.ts).

import { requestFromHunk, type ExplainRequest } from './clickHandler';
import type { DiffHunk, DiffLine } from './diffDom';
import { worthExplaining, type AheadLine } from './explainAhead';
import type { PrRef } from './prUrl';

/** One file of the API's answer; only the fields used here. */
export interface PrFile {
  filename: string;
  status: string;
  changes?: number;
  /** Left out by GitHub for big and binary files. */
  patch?: string;
}

/** A changed line and the request a click on it would send. */
export interface PatchLine {
  /** Names the line as Explain on hover and Explain ahead do, such as "src/a.ts:added:12". */
  key: string;
  filePath: string;
  lineNumber: number;
  /** Which hunk of the PR the line is in, counted from 0 across all files (for PR 10.5). */
  hunk: number;
  /** The line's code. */
  text: string;
  /** The hunk itself, as the page would give it, for one request per hunk (PR 10.5). */
  diff: DiffHunk;
  request: ExplainRequest;
}

/** Why a file has no lines here. */
export type LeftOutReason = 'too big' | 'binary or empty' | 'renamed only';

export interface LeftOutFile {
  filePath: string;
  reason: LeftOutReason;
}

/** The requests built from a PR's diff. */
export interface PatchRequests {
  /** How many files the PR changes. */
  files: number;
  /** How many changed lines have a request (after skipping blank and closing lines). */
  lines: PatchLine[];
  /** Files with no diff in the API, to be explained from the page when drawn. */
  leftOut: LeftOutFile[];
  /** False when the PR has more files than the API lists (3,000). */
  complete: boolean;
}

export type PatchResult =
  | ({ status: 'done'; headSha: string | null } & PatchRequests)
  | { status: 'unavailable'; reason: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The hunks of one file's patch, as the page shows them (src/diffDom.ts): the
 * header as GitHub draws it, and the lines in unified order, each numbered in
 * the new file (added and unchanged lines) or the old file (removed lines).
 * `index` is 0; requestsFromFiles sets it for each line.
 */
export function parsePatch(filePath: string, patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // A file's last line may end with "\r" when the file uses Windows line
  // endings; the page shows the line without it.
  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw.trim(), lines: [], index: 0 };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    const text = raw.slice(1).replace(/\r$/, '');
    let line: DiffLine | null = null;
    if (marker === '+') line = { filePath, lineNumber: newLine++, side: 'added', text };
    else if (marker === '-') line = { filePath, lineNumber: oldLine++, side: 'removed', text };
    else if (marker === ' ') {
      line = { filePath, lineNumber: newLine++, side: 'context', text };
      oldLine++;
    }
    // Anything else, such as "\ No newline at end of file", is not a line.
    if (line) current.lines.push(line);
  }
  return hunks;
}

function leftOutReason(file: PrFile): LeftOutReason {
  if (file.status === 'renamed' && !file.changes) return 'renamed only';
  return file.changes ? 'too big' : 'binary or empty';
}

/** Builds the request for every added line worth explaining, in the PR's order. */
export function requestsFromFiles(files: readonly PrFile[]): Omit<PatchRequests, 'complete'> {
  const lines: PatchLine[] = [];
  const leftOut: LeftOutFile[] = [];
  let hunkCount = 0;
  for (const file of files) {
    if (typeof file.patch !== 'string' || file.patch === '') {
      leftOut.push({ filePath: file.filename, reason: leftOutReason(file) });
      continue;
    }
    for (const hunk of parsePatch(file.filename, file.patch)) {
      hunk.lines.forEach((line, index) => {
        if (line.side !== 'added' || !worthExplaining(line.text)) return;
        lines.push({
          key: `${line.filePath}:added:${line.lineNumber}`,
          filePath: line.filePath,
          lineNumber: line.lineNumber,
          hunk: hunkCount,
          text: line.text,
          diff: hunk,
          request: requestFromHunk({ ...hunk, index }),
        });
      });
      hunkCount++;
    }
  }
  return { files: files.length, lines, leftOut };
}

/** The API's page size, and how many pages it serves (3,000 files). */
export const FILES_PER_PAGE = 100;
export const MAX_PAGES = 30;
/** How long to wait for one page of the list. */
export const PAGE_TIMEOUT_MS = 10_000;

/** The API address of one page of a PR's files. */
export function filesUrl(pr: Pick<PrRef, 'owner' | 'repo' | 'number'>, page: number): string {
  const repo = `${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;
  return `https://api.github.com/repos/${repo}/pulls/${pr.number}/files?per_page=${FILES_PER_PAGE}&page=${page}`;
}

export interface PatchRequestLoaderDeps {
  /** Fetches an API address and reads its JSON. Rejects on a failed request. */
  fetchJson(url: string, signal: AbortSignal): Promise<unknown>;
  /** The head commit the page shows (headShaFromPage, src/fileContext.ts), or null. */
  headSha(pr: PrRef): string | null;
  timeoutMs?: number;
}

export interface PatchRequestLoader {
  /**
   * The requests for every changed line of `pr`. Never rejects. Fetched once
   * per PR and head commit: a push gives a new head and a new list. A failed
   * read is tried again on the next load.
   */
  load(pr: PrRef): Promise<PatchResult>;
  /**
   * For every page change: forgets lists read when the head commit was not
   * known, since the PR may have moved on. Lists with a known head are kept.
   */
  forget(): void;
}

function isFileList(value: unknown): value is PrFile[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        typeof (file as PrFile).filename === 'string' &&
        typeof (file as PrFile).status === 'string',
    )
  );
}

export function createPatchRequestLoader(deps: PatchRequestLoaderDeps): PatchRequestLoader {
  const loaded = new Map<string, { sha: string | null; result: Promise<PatchResult> }>();
  const timeoutMs = deps.timeoutMs ?? PAGE_TIMEOUT_MS;

  const readPage = async (pr: PrRef, page: number): Promise<PrFile[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = await deps.fetchJson(filesUrl(pr, page), controller.signal);
      if (!isFileList(body)) throw new Error('GitHub sent something that is not a file list');
      return body;
    } finally {
      clearTimeout(timer);
    }
  };

  const read = async (pr: PrRef, sha: string | null): Promise<PatchResult> => {
    const files: PrFile[] = [];
    let complete = false;
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await readPage(pr, page);
        files.push(...batch);
        if (batch.length < FILES_PER_PAGE) {
          complete = true;
          break;
        }
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return { status: 'done', headSha: sha, ...requestsFromFiles(files), complete };
  };

  return {
    load(pr) {
      const sha = deps.headSha(pr);
      const key = `${pr.owner}/${pr.repo}#${pr.number}@${sha ?? ''}`.toLowerCase();
      const known = loaded.get(key);
      if (known) return known.result;
      const entry = {
        sha,
        result: read(pr, sha).then((result) => {
          if (result.status !== 'done' && loaded.get(key) === entry) loaded.delete(key);
          return result;
        }),
      };
      loaded.set(key, entry);
      return entry.result;
    },
    forget() {
      for (const [key, entry] of loaded) if (entry.sha === null) loaded.delete(key);
    },
  };
}

/** One line for the console and the debug window, such as "3 files, 42 lines, 1 left out". */
export function describePatchResult(result: PatchResult): string {
  if (result.status !== 'done') return `PR files could not be read: ${result.reason}`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [plural(result.files, 'file'), plural(result.lines.length, 'line')];
  if (result.leftOut.length) parts.push(`${result.leftOut.length} left out`);
  if (!result.complete) parts.push('more files than GitHub lists');
  return parts.join(', ');
}

/**
 * The lines for Explain ahead's Whole PR (PR 10.6), in the PR's order. Lines
 * of one hunk share an id, so they go in one request (PR 10.5).
 */
export function aheadLines(requests: Pick<PatchRequests, 'lines'>): AheadLine[] {
  return requests.lines.map((line, order) => ({
    key: line.key,
    text: line.text,
    filePath: line.filePath,
    order,
    request: () => line.request,
    hunk: { id: `patch:${line.hunk}`, read: () => line.diff },
  }));
}
