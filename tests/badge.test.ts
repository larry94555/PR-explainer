import { BADGE_ID, BADGE_TEXT, findBadge, removeBadge, showBadge, syncBadge } from '../src/badge';

const PR_URL = 'https://github.com/owner/repo/pull/42/files';
const ISSUE_URL = 'https://github.com/owner/repo/issues/42';

function badgeLabel(): HTMLElement | null | undefined {
  return findBadge(document)?.shadowRoot?.querySelector<HTMLElement>('.badge');
}

describe('badge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows "PR Explainer active" inside a shadow root on a PR page', () => {
    expect(syncBadge(document, PR_URL)).toMatchObject({ number: 42, tab: 'files' });
    const host = document.getElementById(BADGE_ID);
    expect(host?.parentElement).toBe(document.body);
    expect(host?.shadowRoot).not.toBeNull();
    expect(badgeLabel()?.textContent).toBe(BADGE_TEXT);
    expect(badgeLabel()?.title).toBe('owner/repo#42 (files)');
  });

  it('keeps its text and styles out of the page DOM', () => {
    syncBadge(document, PR_URL);
    expect(document.body.textContent).not.toContain(BADGE_TEXT);
    expect(document.querySelector('style')).toBeNull();
  });

  it('shows no badge on a non-PR page', () => {
    expect(syncBadge(document, ISSUE_URL)).toBeNull();
    expect(findBadge(document)).toBeNull();
  });

  it('adds only one badge when synced repeatedly, and updates its tooltip', () => {
    syncBadge(document, PR_URL);
    syncBadge(document, 'https://github.com/owner/repo/pull/43');
    expect(document.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
    expect(badgeLabel()?.title).toBe('owner/repo#43 (conversation)');
  });

  it('removes the badge after navigating from a PR to a non-PR page', () => {
    syncBadge(document, PR_URL);
    syncBadge(document, ISSUE_URL);
    expect(findBadge(document)).toBeNull();
  });

  it('can be shown and removed directly', () => {
    showBadge(document, { owner: 'o', repo: 'r', number: 1, tab: 'commits' });
    expect(findBadge(document)).not.toBeNull();
    removeBadge(document);
    removeBadge(document); // removing twice is harmless
    expect(findBadge(document)).toBeNull();
  });
});
