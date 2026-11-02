// PR title and description (PR 6.1): what the pull request says it is for,
// so the model can tie "Why it's needed" to the PR's stated goal.
//
// The Files changed tab shows the title but not the description, so when the
// page has no description it is read from the PR's Conversation tab, fetched
// once per PR with the user's GitHub cookies (a same-origin request, so
// private repos work while signed in). Reading never fails: anything that goes
// wrong leaves the description empty and the explanation goes ahead without
// it.
//
// This file is part of the content script, which must not share runtime code
// with the service worker (see src/content.ts).

import type { PrRef } from './prUrl';

export interface PrMetadata {
  title: string;
  /** Plain text or Markdown; empty when the PR has none or it could not be read. */
  description: string;
}

/** The longest title and description sent to the model, in characters. */
export const MAX_TITLE_LENGTH = 300;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const TRIMMED_NOTE = '… (description trimmed)';

/** How long to wait for the Conversation tab before explaining without it. */
export const DEFAULT_FETCH_TIMEOUT_MS = 3000;

// GitHub's placeholder for a PR with an empty description.
const NO_DESCRIPTION = 'No description provided.';

const TITLE_SELECTORS = [
  // Classic header (Files changed and older Conversation pages).
  '.gh-header-title .js-issue-title',
  '.js-issue-title',
  // The React Conversation page's header.
  'h1 .markdown-title',
];

// The raw Markdown behind the PR description's "Copy Markdown" menu item,
// and the rendered description, which only the PR description (not review
// comments) is inside.
const DESCRIPTION_MARKDOWN = 'clipboard-copy[data-dd-action-name="pr.description.copy_markdown"]';
const DESCRIPTION_BODY = '.js-command-palette-pull-body .js-comment-body';

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cuts `text` to `max` characters at a word break, marking that it was cut. */
export function trimText(text: string, max: number, note = '…'): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - note.length);
  const cut = text.slice(0, room);
  const space = cut.search(/\s\S*$/);
  return `${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()}${note}`;
}

/** Tidies a description: drops HTML comments and extra blank lines, and trims it. */
export function cleanDescription(text: string): string {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned === NO_DESCRIPTION) return '';
  return trimText(cleaned, MAX_DESCRIPTION_LENGTH, `\n${TRIMMED_NOTE}`);
}

// "Title by user · Pull Request #24 · owner/repo · GitHub" -> "Title".
function titleFromPageTitle(text: string): string {
  return collapse(text.replace(/ by \S+ · Pull Request #\d+ · .*$/, ''));
}

function readTitle(doc: Document): string {
  for (const selector of TITLE_SELECTORS) {
    const text = collapse(doc.querySelector(selector)?.textContent ?? '');
    if (text) return text;
  }
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
  return titleFromPageTitle(og || doc.title);
}

/**
 * The description on `doc`, or null when the page does not show one (the
 * Files changed tab). An empty string means the PR has no description.
 */
function readDescription(doc: Document): string | null {
  const markdown = doc.querySelector(DESCRIPTION_MARKDOWN)?.getAttribute('value');
  if (markdown != null) return cleanDescription(markdown);
  const body = doc.querySelector(DESCRIPTION_BODY);
  if (body) return cleanDescription(body.textContent ?? '');
  return null;
}

/**
 * Reads the title and description from a PR page. `description` is null when
 * the page has no description section, so the caller knows to look on the
 * Conversation tab.
 */
export function readPrMetadata(doc: Document): { title: string; description: string | null } {
  return {
    title: trimText(readTitle(doc), MAX_TITLE_LENGTH),
    description: readDescription(doc),
  };
}

/** Reads the title and description from the Conversation tab's HTML. */
export function parsePrMetadataHtml(html: string): PrMetadata {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { title, description } = readPrMetadata(doc);
  return { title, description: description ?? '' };
}

/** The Conversation tab's address, relative to github.com. */
export function conversationPath(pr: Pick<PrRef, 'owner' | 'repo' | 'number'>): string {
  return `/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}

export interface PrMetadataLoaderDeps {
  /** The current page. */
  doc: Document;
  /** Fetches a github.com path's HTML. Rejects on a failed request. */
  fetchHtml(path: string, signal: AbortSignal): Promise<string>;
  timeoutMs?: number;
}

export interface PrMetadataLoader {
  /** The PR's title and description. Never rejects. Asked once per PR. */
  load(pr: PrRef): Promise<PrMetadata>;
}

export function createPrMetadataLoader(deps: PrMetadataLoaderDeps): PrMetadataLoader {
  const loaded = new Map<string, Promise<PrMetadata>>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  // Resolves with `ok: false` when the Conversation tab could not be read.
  const fetchConversation = async (
    pr: PrRef,
    title: string,
  ): Promise<{ metadata: PrMetadata; ok: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const html = await deps.fetchHtml(conversationPath(pr), controller.signal);
      const fetched = parsePrMetadataHtml(html);
      return {
        metadata: { title: title || fetched.title, description: fetched.description },
        ok: true,
      };
    } catch {
      return { metadata: { title, description: '' }, ok: false };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    load(pr) {
      const key = conversationPath(pr);
      const known = loaded.get(key);
      if (known) return known;
      const page = readPrMetadata(deps.doc);
      if (page.description !== null) {
        const result = Promise.resolve({ title: page.title, description: page.description });
        loaded.set(key, result);
        return result;
      }
      const result = fetchConversation(pr, page.title).then(({ metadata, ok }) => {
        // A failed fetch is tried again on the next click.
        if (!ok) loaded.delete(key);
        return metadata;
      });
      loaded.set(key, result);
      return result;
    },
  };
}
