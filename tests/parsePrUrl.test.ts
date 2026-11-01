import { parsePrUrl } from '../src/prUrl';

describe('parsePrUrl', () => {
  it.each([
    ['https://github.com/owner/repo/pull/123', 'conversation'],
    ['https://github.com/owner/repo/pull/123/', 'conversation'],
    ['https://github.com/owner/repo/pull/123/commits', 'commits'],
    ['https://github.com/owner/repo/pull/123/commits/0a1b2c3', 'commits'],
    ['https://github.com/owner/repo/pull/123/checks', 'checks'],
    ['https://github.com/owner/repo/pull/123/files', 'files'],
    ['https://github.com/owner/repo/pull/123/files/0a1b2c3..4d5e6f7', 'files'],
    ['https://github.com/owner/repo/pull/123/changes', 'files'],
  ] as const)('reads %s as the %s tab', (url, tab) => {
    expect(parsePrUrl(url)).toEqual({ owner: 'owner', repo: 'repo', number: 123, tab });
  });

  it('ignores query strings and hashes', () => {
    expect(
      parsePrUrl('https://github.com/owner/repo/pull/7/files?w=1&diff=split#diff-abc'),
    ).toEqual({ owner: 'owner', repo: 'repo', number: 7, tab: 'files' });
    expect(parsePrUrl('https://github.com/owner/repo/pull/7#issuecomment-1')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 7,
      tab: 'conversation',
    });
  });

  it('keeps owner and repo names with dots, dashes and underscores', () => {
    expect(parsePrUrl('https://github.com/my-org/my_repo.js/pull/1')).toMatchObject({
      owner: 'my-org',
      repo: 'my_repo.js',
    });
  });

  it.each([
    'https://github.com/owner/repo/issues/123',
    'https://github.com/owner/repo/pulls',
    'https://github.com/owner/repo/pull',
    'https://github.com/owner/repo/pull/',
    'https://github.com/owner/repo/pull/new/main',
    'https://github.com/owner/repo/pull/0',
    'https://github.com/owner/repo/pull/12abc',
    'https://github.com/owner/repo/pull/123/unknown-tab',
    'https://github.com/owner/repo/pull/123/checks/extra',
    'https://github.com/owner//pull/123',
    'https://github.com/owner/repo',
    'https://github.com/pulls',
  ])('returns null for the non-PR GitHub URL %s', (url) => {
    expect(parsePrUrl(url)).toBeNull();
  });

  it.each([
    'http://github.com/owner/repo/pull/123',
    'https://gist.github.com/owner/repo/pull/123',
    'https://github.com.evil.example/owner/repo/pull/123',
    'https://gitlab.com/owner/repo/pull/123',
    'https://github.com:8443/owner/repo/pull/123',
    'not a url',
    '',
  ])('returns null for the non-GitHub URL %s', (url) => {
    expect(parsePrUrl(url)).toBeNull();
  });
});
