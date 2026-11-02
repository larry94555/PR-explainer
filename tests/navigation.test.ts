import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrMetadataLoader } from '../src/prMetadata';
import {
  closeDetached,
  DiffPageFeatures,
  pageOf,
  POLL_MS,
  REDRAW_MERGE_MS,
  showsDiffs,
  watchNavigation,
} from '../src/navigation';

const BASE = 'https://github.com/owner/repo/pull/42';
const CONVERSATION = BASE;
const FILES = `${BASE}/files`;
const CHANGES = `${BASE}/changes`;
const COMMIT = `${BASE}/commits/abc123`;
const ISSUE = 'https://github.com/owner/repo/issues/7';

describe('pageOf', () => {
  it('drops the query, the hash and a trailing slash', () => {
    expect(pageOf(`${FILES}?w=1#diff-abcR12`)).toBe(FILES);
    expect(pageOf(`${FILES}/`)).toBe(FILES);
    expect(pageOf(CONVERSATION)).not.toBe(pageOf(FILES));
  });
});

describe('showsDiffs', () => {
  it.each([FILES, CHANGES, `${FILES}?w=1`, `${BASE}/commits`, COMMIT])('is true on %s', (url) => {
    expect(showsDiffs(url)).toBe(true);
  });

  it.each([CONVERSATION, `${BASE}/checks`, ISSUE, 'https://github.com/owner/repo'])(
    'is false on %s',
    (url) => {
      expect(showsDiffs(url)).toBe(false);
    },
  );
});

describe('DiffPageFeatures', () => {
  function setup() {
    const detach = vi.fn();
    const attach = vi.fn(() => detach);
    return { attach, detach, features: new DiffPageFeatures(attach) };
  }

  it('attaches on entering the Files tab and detaches on leaving it', () => {
    const { attach, detach, features } = setup();
    features.sync(CONVERSATION);
    expect(attach).not.toHaveBeenCalled();
    features.sync(FILES);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(features.attached).toBe(true);
    features.sync(CONVERSATION);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(features.attached).toBe(false);
  });

  it('does not attach twice while staying on pages with diffs', () => {
    const { attach, detach, features } = setup();
    features.sync(FILES);
    features.sync(FILES);
    features.sync(`${FILES}?w=1`);
    features.sync(COMMIT);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
  });

  it('attaches again after coming back, once each time', () => {
    const { attach, detach, features } = setup();
    for (let i = 0; i < 3; i++) {
      features.sync(FILES);
      features.sync(ISSUE);
    }
    expect(attach).toHaveBeenCalledTimes(3);
    expect(detach).toHaveBeenCalledTimes(3);
  });

  it('runs a real click handler once per click after many moves', () => {
    const onClick = vi.fn();
    const features = new DiffPageFeatures(() => {
      document.addEventListener('click', onClick);
      return () => document.removeEventListener('click', onClick);
    });
    for (const url of [FILES, CONVERSATION, FILES, FILES, CONVERSATION, CHANGES]) {
      features.sync(url);
    }
    document.body.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    features.sync(CONVERSATION);
    document.body.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('watchNavigation', () => {
  let stop: (() => void) | undefined;
  // A stand-in window whose address the test sets, as GitHub's pushState
  // would; jsdom cannot move to github.com.
  let win: Window & { location: { href: string } };
  let document: EventTarget;
  let navigation: EventTarget | undefined;

  function makeWindow(withNavigation = false, doc: EventTarget = new EventTarget()) {
    document = doc;
    navigation = withNavigation ? new EventTarget() : undefined;
    win = Object.assign(new EventTarget(), {
      location: { href: CONVERSATION },
      document,
      navigation,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: number) => clearInterval(id),
    }) as unknown as typeof win;
  }
  function fakeAddress(url: string): void {
    win.location.href = url;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    makeWindow();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('reports a move found by turbo:load, with the page it came from', () => {
    const onChange = vi.fn();
    stop = watchNavigation(win, onChange);
    fakeAddress(FILES);
    document.dispatchEvent(new Event('turbo:load'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(FILES, CONVERSATION);
  });

  it('reports back and forward (popstate) and turbo:render', () => {
    const onChange = vi.fn();
    stop = watchNavigation(win, onChange);
    fakeAddress(FILES);
    win.dispatchEvent(new PopStateEvent('popstate'));
    fakeAddress(CONVERSATION);
    document.dispatchEvent(new Event('turbo:render'));
    expect(onChange.mock.calls).toEqual([
      [FILES, CONVERSATION],
      [CONVERSATION, FILES],
    ]);
  });

  it('finds a pushState move with no event by checking the address', () => {
    const onChange = vi.fn();
    stop = watchNavigation(win, onChange);
    fakeAddress(CHANGES);
    vi.advanceTimersByTime(POLL_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(CHANGES, CONVERSATION);
  });

  it("checks just after the Navigation API's navigate event", () => {
    makeWindow(true);
    const onChange = vi.fn();
    stop = watchNavigation(win, onChange);
    navigation!.dispatchEvent(new Event('navigate'));
    // The address changes after the event is sent.
    fakeAddress(FILES);
    vi.advanceTimersByTime(0);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(FILES, CONVERSATION);
  });

  it('reports each move once, however many events and checks see it', () => {
    const onChange = vi.fn();
    stop = watchNavigation(win, onChange);
    fakeAddress(FILES);
    document.dispatchEvent(new Event('turbo:render'));
    document.dispatchEvent(new Event('turbo:load'));
    win.dispatchEvent(new PopStateEvent('popstate'));
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a change to only the hash or query', () => {
    const onChange = vi.fn();
    fakeAddress(FILES);
    stop = watchNavigation(win, onChange);
    fakeAddress(`${FILES}#diff-abcR12`);
    vi.advanceTimersByTime(POLL_MS);
    fakeAddress(`${FILES}?w=1#diff-abcR12`);
    document.dispatchEvent(new Event('turbo:load'));
    expect(onChange).not.toHaveBeenCalled();
    // The previous page given for the next move is the latest address.
    fakeAddress(CONVERSATION);
    vi.advanceTimersByTime(POLL_MS);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(CONVERSATION, `${FILES}?w=1#diff-abcR12`);
  });

  it('reports a Turbo redraw of the same page once per visit', () => {
    const onChange = vi.fn();
    const onRedraw = vi.fn();
    stop = watchNavigation(win, onChange, { onRedraw });
    // Turbo sends turbo:render and then turbo:load for one visit.
    document.dispatchEvent(new Event('turbo:render'));
    document.dispatchEvent(new Event('turbo:load'));
    expect(onRedraw).toHaveBeenCalledExactlyOnceWith(CONVERSATION);
    vi.advanceTimersByTime(REDRAW_MERGE_MS);
    document.dispatchEvent(new Event('turbo:load'));
    expect(onRedraw).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not also report a redraw for the Turbo events of a move', () => {
    const onChange = vi.fn();
    const onRedraw = vi.fn();
    stop = watchNavigation(win, onChange, { onRedraw });
    fakeAddress(FILES);
    vi.advanceTimersByTime(POLL_MS);
    document.dispatchEvent(new Event('turbo:render'));
    document.dispatchEvent(new Event('turbo:load'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(FILES, CONVERSATION);
    expect(onRedraw).not.toHaveBeenCalled();
  });

  it('ignores popstate and address checks on the same page for redraws', () => {
    const onRedraw = vi.fn();
    stop = watchNavigation(win, vi.fn(), { onRedraw });
    win.dispatchEvent(new PopStateEvent('popstate'));
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(onRedraw).not.toHaveBeenCalled();
  });

  it('reads an edited PR description again after a same-page Turbo redraw', async () => {
    const conversation = readFileSync(
      resolve(import.meta.dirname, 'fixtures', 'github-pr-conversation.html'),
      'utf8',
    );
    const page = new DOMParser().parseFromString(conversation, 'text/html');
    makeWindow(false, page);
    const fetchHtml = vi.fn(async () => '');
    const loader = createPrMetadataLoader({
      doc: page,
      fetchHtml,
      currentPage: () => new URL(win.location.href).pathname,
    });
    const pr = {
      owner: 'larry94555',
      repo: 'PR-explainer',
      number: 42,
      tab: 'conversation' as const,
    };
    stop = watchNavigation(win, () => loader.forget(), { onRedraw: () => loader.forget() });
    expect((await loader.load(pr)).description).toContain('Roadmap PR 5.4');

    // The description is edited and Turbo redraws the same address.
    const edited = new DOMParser().parseFromString(
      conversation.replaceAll('Roadmap PR 5.4', 'Edited description'),
      'text/html',
    );
    page.body.replaceWith(page.adoptNode(edited.body));
    page.dispatchEvent(new Event('turbo:render'));
    page.dispatchEvent(new Event('turbo:load'));

    const { description } = await loader.load(pr);
    expect(description).toContain('Edited description');
    expect(description).not.toContain('Roadmap PR 5.4');
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('stops listening and checking when stopped', () => {
    const onChange = vi.fn();
    watchNavigation(win, onChange)();
    fakeAddress(FILES);
    document.dispatchEvent(new Event('turbo:load'));
    win.dispatchEvent(new PopStateEvent('popstate'));
    vi.advanceTimersByTime(POLL_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drives DiffPageFeatures across back-and-forth tab switches', () => {
    const detach = vi.fn();
    const attach = vi.fn(() => detach);
    const features = new DiffPageFeatures(attach);
    features.sync(win.location.href);
    stop = watchNavigation(win, (url) => features.sync(url));
    for (let i = 0; i < 4; i++) {
      fakeAddress(FILES);
      document.dispatchEvent(new Event('turbo:load'));
      vi.advanceTimersByTime(POLL_MS);
      fakeAddress(CONVERSATION);
      win.dispatchEvent(new PopStateEvent('popstate'));
    }
    expect(attach).toHaveBeenCalledTimes(4);
    expect(detach).toHaveBeenCalledTimes(4);
  });
});

describe('closeDetached', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes only the UI whose element is no longer on the page', () => {
    const onPage = { host: document.createElement('div'), close: vi.fn() };
    document.body.append(onPage.host);
    const replaced = { host: document.createElement('div'), close: vi.fn() };
    closeDetached([onPage, replaced, null, undefined]);
    expect(onPage.close).not.toHaveBeenCalled();
    expect(replaced.close).toHaveBeenCalledTimes(1);
  });
});
