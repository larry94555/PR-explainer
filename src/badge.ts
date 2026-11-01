// The small "PR Explainer active" badge shown in the bottom right corner of
// PR pages. It lives in a Shadow DOM so GitHub's CSS cannot restyle it and
// its CSS cannot leak into GitHub.

import { parsePrUrl, type PrRef } from './prUrl';

export const BADGE_ID = 'pr-explainer-badge';
export const BADGE_TEXT = 'PR Explainer active';

const STYLE = `
  :host { all: initial; }
  .badge {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    padding: 4px 10px;
    border-radius: 999px;
    background: #1f6feb;
    color: #ffffff;
    font: 600 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    user-select: none;
  }
`;

export function findBadge(doc: Document): HTMLElement | null {
  return doc.getElementById(BADGE_ID);
}

// Adds the badge for `pr`, or updates it if it is already on the page.
export function showBadge(doc: Document, pr: PrRef): HTMLElement {
  let host = findBadge(doc);
  if (!host) {
    host = doc.createElement('div');
    host.id = BADGE_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const label = doc.createElement('div');
    label.className = 'badge';
    label.textContent = BADGE_TEXT;
    shadow.append(style, label);
    doc.body.append(host);
  }
  const label = host.shadowRoot?.querySelector<HTMLElement>('.badge');
  if (label) label.title = `${pr.owner}/${pr.repo}#${pr.number} (${pr.tab})`;
  return host;
}

export function removeBadge(doc: Document): void {
  findBadge(doc)?.remove();
}

// Shows the badge if `url` is a PR page and removes it otherwise.
// Returns the PR it found, or null.
export function syncBadge(doc: Document, url: string): PrRef | null {
  const pr = parsePrUrl(url);
  if (pr) showBadge(doc, pr);
  else removeBadge(doc);
  return pr;
}
