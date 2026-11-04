import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanDescription,
  conversationPath,
  createPrMetadataLoader,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  parsePrMetadataHtml,
  readPrMetadata,
  TRIMMED_NOTE,
  trimText,
} from '../src/prMetadata';
import type { PrRef } from '../src/prUrl';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

function page(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const PR: PrRef = { owner: 'larry94555', repo: 'PR-explainer', number: 24, tab: 'files' };
const TITLE = 'Keep one chat conversation across lines (roadmap PR 5.4)';

describe('parsePrMetadataHtml', () => {
  it('reads the title and the description from the Conversation tab', () => {
    const { title, description } = parsePrMetadataHtml(fixture('github-pr-conversation.html'));
    expect(title).toBe(TITLE);
    expect(description).toBe(
      [
        '_Requested by **Larry** · [project thread](https://claude.ai/code/project/chan_01V5D6uXcL3sfNuxsFWFsjw5)_',
        '',
        'Roadmap PR 5.4 (Small), on top of #23 (5.3, merged).',
        '',
        "## Why it's needed",
        'Users reading a PR jump between lines and should not lose the conversation each time.',
        '',
        '## Problem it solves',
        'While the chat panel is open, clicking another diff line adds that code to the conversation instead of opening the popup.',
      ].join('\n'),
    );
  });

  it('never takes a review comment for the description', () => {
    const { description } = parsePrMetadataHtml(fixture('github-pr-conversation.html'));
    expect(description).not.toContain('[codex]');
    expect(parsePrMetadataHtml(fixture('github-pr-conversation-empty.html')).description).toBe('');
  });

  it('reads an empty description as empty', () => {
    expect(parsePrMetadataHtml(fixture('github-pr-conversation-empty.html'))).toEqual({
      title: 'Bump vite',
      description: '',
    });
  });

  it('falls back to the rendered description without the Markdown value', () => {
    const html = fixture('github-pr-conversation.html').replace(
      /<clipboard-copy role="menuitem" data-dd-action-name="pr\.description[\s\S]*?<\/clipboard-copy>/,
      '',
    );
    const { description } = parsePrMetadataHtml(html);
    expect(description).toContain("Why it's needed");
    expect(description).toContain('should not lose the conversation each time.');
  });

  it('takes the title from the page title when there is no header', () => {
    const html = fixture('github-pr-conversation.html').replace(/<h1[\s\S]*?<\/h1>/, '');
    expect(parsePrMetadataHtml(html).title).toBe(TITLE);
  });

  it('gives an empty description for a page without one', () => {
    expect(parsePrMetadataHtml('<p>Not a PR</p>')).toEqual({ title: '', description: '' });
  });
});

describe('readPrMetadata on the Files changed tab', () => {
  it('reads the classic header title and says the description is not on the page', () => {
    expect(readPrMetadata(page(fixture('github-diff-classic.html')))).toEqual({
      title: 'Friendly LLM error messages',
      description: null,
    });
  });
});

describe('trimming', () => {
  it('trims a very long description at a word break and says so', () => {
    const long = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
    const trimmed = cleanDescription(long);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(trimmed.endsWith(`\n${TRIMMED_NOTE}`)).toBe(true);
    const kept = trimmed.slice(0, -TRIMMED_NOTE.length - 1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
  });

  it('trims a long page description the same way', () => {
    const body = 'x '.repeat(5000);
    const html = `<div class="js-command-palette-pull-body"><div class="js-comment-body">${body}</div></div>`;
    const { description } = parsePrMetadataHtml(html);
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(description).toContain(TRIMMED_NOTE);
  });

  it('trims a very long title', () => {
    const html = `<h1><span class="markdown-title">${'Long title '.repeat(100)}</span></h1>`;
    const { title } = parsePrMetadataHtml(html);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('leaves short text alone', () => {
    expect(trimText('short', 10)).toBe('short');
    expect(cleanDescription('  Fix the bug.\r\n\r\n\r\n\r\nThanks  ')).toBe(
      'Fix the bug.\n\nThanks',
    );
  });

  it('cuts text without spaces at the limit', () => {
    expect(trimText('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('createPrMetadataLoader', () => {
  const conversation = fixture('github-pr-conversation.html');

  it('fetches the Conversation tab when the page has no description, once per PR', async () => {
    const fetchHtml = vi.fn(async () => conversation);
    const loader = createPrMetadataLoader({
      doc: page(fixture('github-diff-classic.html')),
      fetchHtml,
    });
    const first = await loader.load(PR);
    // The page's own header wins over the fetched one.
    expect(first.title).toBe('Friendly LLM error messages');
    expect(first.description).toContain('Roadmap PR 5.4');
    expect(fetchHtml).toHaveBeenCalledWith(
      '/larry94555/PR-explainer/pull/24',
      expect.any(AbortSignal),
    );
    await loader.load({ ...PR, tab: 'conversation' });
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    await loader.load({ ...PR, number: 25 });
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it('is read as the page opens, and a click while that read runs joins it (PR 9.7)', async () => {
    let answer!: (html: string) => void;
    const fetchHtml = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const loader = createPrMetadataLoader({
      doc: page(fixture('github-diff-classic.html')),
      fetchHtml,
    });
    // The page opens: the content script starts the read at once.
    const onOpen = loader.load(PR);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    // The first click comes before GitHub answered: no second fetch.
    const onClick = loader.load(PR);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    answer(conversation);
    expect(await onClick).toEqual(await onOpen);
    expect((await onClick).description).toContain('Roadmap PR 5.4');
    // A later click gets it at once, still from the one fetch.
    await loader.load(PR);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  // The user edits the description on the Conversation tab and comes back to
  // Files changed without a reload.
  function editedSetup() {
    let where = '/larry94555/PR-explainer/pull/24/files';
    const edited = conversation.replaceAll('Roadmap PR 5.4', 'Edited description');
    const fetchHtml = vi
      .fn<(path: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce(conversation)
      .mockResolvedValueOnce(edited);
    const loader = createPrMetadataLoader({
      doc: page(fixture('github-diff-classic.html')),
      fetchHtml,
      currentPage: () => where,
    });
    return { loader, fetchHtml, moveTo: (path: string) => (where = path) };
  }

  it('reads the description again after GitHub moves to another page (forget)', async () => {
    const { loader, fetchHtml } = editedSetup();
    expect((await loader.load(PR)).description).toContain('Roadmap PR 5.4');
    await loader.load(PR);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    loader.forget();
    const { description } = await loader.load(PR);
    expect(description).toContain('Edited description');
    expect(description).not.toContain('Roadmap PR 5.4');
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it('reads it again when the page changed, even without a navigation event', async () => {
    const { loader, fetchHtml, moveTo } = editedSetup();
    await loader.load(PR);
    moveTo('/larry94555/PR-explainer/pull/24/files/abc123');
    expect((await loader.load(PR)).description).toContain('Edited description');
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it('uses the page when it shows the description, without fetching', async () => {
    const fetchHtml = vi.fn(async () => '');
    const loader = createPrMetadataLoader({ doc: page(conversation), fetchHtml });
    const { title, description } = await loader.load(PR);
    expect(title).toBe(TITLE);
    expect(description).toContain('Roadmap PR 5.4');
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('keeps the title and an empty description when the fetch fails, and tries again later', async () => {
    const fetchHtml = vi
      .fn<(path: string, signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(conversation);
    const loader = createPrMetadataLoader({
      doc: page(fixture('github-diff-classic.html')),
      fetchHtml,
    });
    await expect(loader.load(PR)).resolves.toEqual({
      title: 'Friendly LLM error messages',
      description: '',
    });
    expect((await loader.load(PR)).description).toContain('Roadmap PR 5.4');
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it('gives up on a slow fetch after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchHtml = vi.fn(
        (_path: string, signal: AbortSignal) =>
          new Promise<string>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      );
      const loader = createPrMetadataLoader({
        doc: page(fixture('github-diff-classic.html')),
        fetchHtml,
        timeoutMs: 1000,
      });
      const result = loader.load(PR);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toEqual({
        title: 'Friendly LLM error messages',
        description: '',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds the Conversation tab path', () => {
    expect(conversationPath(PR)).toBe('/larry94555/PR-explainer/pull/24');
  });
});
