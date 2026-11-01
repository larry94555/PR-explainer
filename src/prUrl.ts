// Recognizes GitHub pull request URLs, for example
// https://github.com/owner/repo/pull/123/files?w=1#diff-abc.

export type PrTab = 'conversation' | 'commits' | 'checks' | 'files';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  tab: PrTab;
}

// The path segment after /pull/<number>, mapped to the tab it shows.
// GitHub's newer "Files changed" view lives at /changes instead of /files.
const TABS: Record<string, PrTab> = {
  '': 'conversation',
  commits: 'commits',
  checks: 'checks',
  files: 'files',
  changes: 'files',
};

// Returns the PR that `url` points at, or null if it is not a github.com PR page.
// Query strings and hashes are ignored.
export function parsePrUrl(url: string): PrRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port !== '') {
    return null;
  }

  // "/owner/repo/pull/123/files/" -> ['owner', 'repo', 'pull', '123', 'files']
  const segments = parsed.pathname.replace(/\/$/, '').split('/').slice(1);
  if (segments.includes('')) return null;
  const [owner, repo, pull, num, tabSegment = '', ...rest] = segments;
  if (!owner || !repo || pull !== 'pull' || !num || !/^[1-9]\d*$/.test(num)) return null;

  const tab = TABS[tabSegment];
  if (!tab) return null;
  // Only commits (/commits/<sha>) and files (/files/<range>) have deeper pages.
  if (rest.length > 0 && tab !== 'commits' && tab !== 'files') return null;

  return { owner, repo, number: Number(num), tab };
}
