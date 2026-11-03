// @vitest-environment node
// PR 9.2: every GitHub request the content script makes is recorded as a
// round trip, and the privacy rules from PR 7.4 still hold.
import {
  BlockedRequestError,
  createGithubFetch,
  createGithubRoundTrips,
  type FetchLike,
} from '../src/net/githubFetch';

const PAGE = 'https://github.com/owner/repo/pull/7/files';

function setup(base: FetchLike = async () => new Response('<html>hello</html>')) {
  let t = 0;
  const time = { now: () => t, advance: (ms: number) => void (t += ms) };
  const trips = createGithubRoundTrips(time.now);
  const fetch = createGithubFetch(vi.fn(base), () => PAGE, trips);
  return { trips, fetch, time };
}

describe('GitHub round trips (PR 9.2)', () => {
  it('records each request with its endpoint, purpose, times, status and size', async () => {
    const { trips, fetch, time } = setup(async () => {
      time.advance(30);
      return new Response('<html>hello</html>');
    });
    time.advance(10);
    const response = await fetch('/owner/repo/pull/7', {}, 'PR description');
    expect(await response.text()).toBe('<html>hello</html>');
    expect(trips.since(0)).toEqual([
      {
        target: 'github',
        method: 'GET',
        endpoint: 'github.com/owner/repo/pull/7',
        purpose: 'PR description',
        cause: 'click',
        startMs: 10,
        durationMs: 30,
        status: 'done',
        httpStatus: 200,
        bytesSent: 0,
        bytesReceived: 18,
      },
    ]);
  });

  it('records a failed request and an HTTP error', async () => {
    const { trips, fetch } = setup(async (url) => {
      if (url.includes('missing')) return new Response('nope', { status: 404 });
      throw new TypeError('Failed to fetch');
    });
    await (await fetch('/owner/repo/raw/abc/missing.ts', {}, 'file at head')).text();
    await expect(fetch('/owner/repo/pull/7', {}, 'PR description')).rejects.toThrow();
    expect(trips.since(0).map((t) => [t.purpose, t.status, t.httpStatus, t.error])).toEqual([
      ['file at head', 'failed', 404, 'HTTP 404'],
      ['PR description', 'failed', undefined, 'Failed to fetch'],
    ]);
  });

  it('records a cancelled request', async () => {
    const { trips, fetch } = setup(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    await expect(fetch('/owner/repo/pull/7', {}, 'PR description')).rejects.toThrow();
    expect(trips.since(0)[0]).toMatchObject({ status: 'cancelled' });
  });

  it('still refuses other hosts, and records the refused request without sending it', async () => {
    const base = vi.fn<FetchLike>(async () => new Response('ok'));
    const trips = createGithubRoundTrips(() => 0);
    const fetch = createGithubFetch(base, () => PAGE, trips);
    await expect(fetch('https://evil.example/steal', {}, 'file at head')).rejects.toBeInstanceOf(
      BlockedRequestError,
    );
    expect(base).not.toHaveBeenCalled();
    expect(trips.since(0)[0]).toMatchObject({
      endpoint: 'evil.example/steal',
      status: 'refused',
      error: expect.stringContaining('only GitHub is allowed'),
    });
  });

  it('gives a click the round trips it waited on, marking ones from before it', async () => {
    const { trips, fetch, time } = setup(async () => {
      time.advance(100);
      return new Response('x');
    });
    // Read when the page opened and done long before the click: not the click's.
    await (await fetch('/owner/repo/pull/7', {}, 'PR description')).text();
    time.advance(1_000);
    // Started just before the click, and still running when it came.
    let release!: () => void;
    const slow = setup(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response('x');
    });
    const pending = slow.fetch('/owner/repo/pull/7', {}, 'PR description');
    slow.time.advance(50);
    const clickAt = slow.time.now();
    release();
    await (await pending).text();
    expect(slow.trips.since(clickAt)[0]).toMatchObject({ cause: 'page', startMs: -50 });

    const clickAt2 = time.now();
    await (await fetch('/owner/repo/raw/abc/a.ts', {}, 'file at head')).text();
    expect(trips.since(clickAt2).map((t) => [t.purpose, t.cause, t.startMs])).toEqual([
      ['file at head', 'click', 0],
    ]);
  });

  it('works without a log, as before', async () => {
    const fetch = createGithubFetch(
      async () => new Response('ok'),
      () => PAGE,
    );
    expect(await (await fetch('/owner/repo/pull/7')).text()).toBe('ok');
  });
});
