// The small "PR Explainer active" badge shown in the bottom right corner of
// PR pages. It lives in a Shadow DOM so GitHub's CSS cannot restyle it and
// its CSS cannot leak into GitHub.

import { parsePrUrl, type PrRef } from './prUrl';

export const BADGE_ID = 'pr-explainer-badge';
export const BADGE_TEXT = 'PR Explainer active';
export const BADGE_TEXT_OFF = 'PR Explainer off';

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
  .badge.off {
    background: #6e7781;
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
  host.dataset.pr = `${pr.owner}/${pr.repo}#${pr.number} (${pr.tab})`;
  updateTooltip(host);
  return host;
}

// Shows whether click-to-explain is on: "PR Explainer active" in blue, or
// "PR Explainer off" in grey after the toolbar button turned it off.
// Does nothing if the badge is not on the page.
export function setBadgeEnabled(doc: Document, enabled: boolean): void {
  const label = findBadge(doc)?.shadowRoot?.querySelector<HTMLElement>('.badge');
  if (!label) return;
  label.textContent = enabled ? BADGE_TEXT : BADGE_TEXT_OFF;
  label.classList.toggle('off', !enabled);
}

// Sets the second tooltip line, for example "Service worker: connected".
// Does nothing if the badge is not on the page.
export function setBadgeStatus(doc: Document, status: string): void {
  const host = findBadge(doc);
  if (!host) return;
  host.dataset.status = status;
  updateTooltip(host);
}

function updateTooltip(host: HTMLElement): void {
  const label = host.shadowRoot?.querySelector<HTMLElement>('.badge');
  if (!label) return;
  label.title = [host.dataset.pr, host.dataset.status].filter(Boolean).join('\n');
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
