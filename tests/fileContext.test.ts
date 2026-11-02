import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFileContext,
  createFileContextLoader,
  findEnclosingBlock,
  headShaFromPage,
  MAX_BLOCK_LINES,
  rawFileUrls,
  WINDOW_LINES,
  type CodeSpan,
} from '../src/fileContext';
import type { PrRef } from '../src/prUrl';

const lines = (text: string) => text.replace(/^\n/, '').split('\n');

// The block around line `n`, as [first line, last line], or null.
function blockAt(text: string, language: string, n: number, end = n) {
  const block = findEnclosingBlock(lines(text), n, end, language);
  return block && [block.start, block.end];
}

const TS = `
import { x } from './x';

export function totals(items: Item[]): number {
  let sum = 0;
  for (const item of items) {
    if (item.price > 0) {
      sum += item.price;
    }
  }
  return sum;
}

const label = 'not a block {';
export class Cart {
  // a comment with a brace }
  add(
    item: Item,
    count: number,
  ): void {
    this.items.push({ item, count });
  }
}
`;

describe('findEnclosingBlock with braces', () => {
  it('finds the function around a line, not the loop or if inside it', () => {
    expect(blockAt(TS, 'TypeScript', 7)).toEqual([3, 11]);
    expect(blockAt(TS, 'TypeScript', 4)).toEqual([3, 11]);
  });

  it('prefers the named function to a callback inside it', () => {
    const code = `
export function ask(fresh: boolean): Stream {
  const helper = (n: number): number => {
    return n + 1;
  };
  return deps.explain(
    text,
    (chunk) => {
      reply += chunk;
    },
  );
}

describe('totals', () => {
  it('adds', () => {
    items.forEach((item) => {
      expect(item).toBeDefined();
    });
  });
});`;
    expect(blockAt(code, 'TypeScript', 8)).toEqual([1, 11]);
    // A function stored in a const is named.
    expect(blockAt(code, 'TypeScript', 3)).toEqual([2, 4]);
    // With no named function around it, the nearest callback: here forEach's.
    expect(blockAt(code, 'TypeScript', 16)).toEqual([15, 17]);
  });

  it('gives the function itself for a click on its first line', () => {
    expect(blockAt(TS, 'TypeScript', 3)).toEqual([3, 11]);
  });

  it('starts a method at its signature when the parameters span lines', () => {
    const block = findEnclosingBlock(lines(TS), 20, 20, 'TypeScript')!;
    expect(block).toEqual({ start: 16, end: 21, headerEnd: 19 });
  });

  it('ignores braces in strings and comments', () => {
    // Line 13's "{" and line 15's "}" would otherwise end the class early.
    expect(blockAt(TS, 'TypeScript', 15)).toEqual([14, 22]);
  });

  it('gives null for a line outside any block', () => {
    expect(blockAt(TS, 'TypeScript', 1)).toBeNull();
    expect(blockAt(TS, 'TypeScript', 13)).toBeNull();
  });

  it('takes the block that holds a whole selection', () => {
    expect(blockAt(TS, 'TypeScript', 5, 9)).toEqual([3, 11]);
    expect(blockAt(TS, 'TypeScript', 10, 14)).toBeNull();
  });

  it('handles a "{" on its own line (Java, C#)', () => {
    const java = `
class Shop
{
    public int Total()
    {
        return 1;
    }
}`;
    expect(blockAt(java, 'C#', 5)).toEqual([3, 6]);
  });

  it('handles Go functions', () => {
    const go = `
package main

func add(a int, b int) int {
\tif a > 0 {
\t\treturn a + b
\t}
\treturn b
}`;
    expect(blockAt(go, 'Go', 5)).toEqual([3, 8]);
  });

  it('falls back to the nearest block when no function is around the line', () => {
    const json = `
{
  "name": "x",
  "scripts": {
    "test": "vitest"
  }
}`;
    expect(blockAt(json, 'JSON', 4)).toEqual([3, 5]);
  });
});

describe('findEnclosingBlock by indentation', () => {
  const PY = `
import os

class Loader:
    def load(self,
             path):
        if not path:
            return None
        # a comment
        with open(path) as f:
            return f.read()

    def other(self):
        pass
`;

  it('finds the Python function around a line, not the if inside it', () => {
    expect(blockAt(PY, 'Python', 6)).toEqual([4, 10]);
    expect(blockAt(PY, 'Python', 10)).toEqual([4, 10]);
  });

  it('starts at the def when the signature spans lines', () => {
    expect(findEnclosingBlock(lines(PY), 7, 7, 'Python')).toEqual({
      start: 4,
      end: 10,
      headerEnd: 5,
    });
  });

  it('gives the class for a line between its methods, or a block that spans them', () => {
    expect(blockAt(PY, 'Python', 11)).toEqual([3, 13]);
    expect(blockAt(PY, 'Python', 12, 13)).toEqual([12, 13]);
    expect(blockAt(PY, 'Python', 4, 13)).toEqual([3, 13]);
  });

  it('includes Ruby\'s closing "end"', () => {
    const rb = `
class Cart
  def total
    items.sum do |item|
      item.price
    end
  end
end`;
    expect(blockAt(rb, 'Ruby', 5)).toEqual([2, 6]);
  });

  it('finds nothing in plain text or Markdown', () => {
    expect(blockAt('# Title\n  indented:\n    more', 'Markdown', 3)).toBeNull();
    expect(blockAt('a {\n  b\n}', 'Plain text', 2)).toBeNull();
  });
});

const span = (startLine: number, text: string, endLine = startLine): CodeSpan => ({
  filePath: 'src/cart.ts',
  startLine,
  endLine,
  text,
});

describe('buildFileContext', () => {
  const file = lines(TS).join('\n') + '\n';

  it('gives the enclosing block with its opening marked as the header', () => {
    expect(buildFileContext(file, span(20, '    this.items.push({ item, count });'))).toEqual({
      kind: 'block',
      startLine: 16,
      lines: lines(TS).slice(15, 21),
      focusStart: 20,
      focusEnd: 20,
      headerLines: 4,
    });
  });

  it('gives a window of lines when there is no block', () => {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    const context = buildFileContext(many, { ...span(30, 'line 30'), filePath: 'notes.txt' })!;
    expect(context.kind).toBe('window');
    expect(context.startLine).toBe(30 - WINDOW_LINES);
    expect(context.lines).toHaveLength(2 * WINDOW_LINES + 1);
    expect(context.headerLines).toBe(0);
    // Near the start of the file the window is cut short.
    expect(buildFileContext(many, { ...span(2, 'line 2'), filePath: 'a.md' })!.startLine).toBe(1);
  });

  it('sends a window instead of a block that is too long', () => {
    const body = Array.from({ length: MAX_BLOCK_LINES + 10 }, (_, i) => `  call(${i});`);
    const huge = ['function big() {', ...body, '}'].join('\n');
    const context = buildFileContext(huge, span(500, '  call(498);'))!;
    expect(context.kind).toBe('window');
    expect(context.lines).toHaveLength(2 * WINDOW_LINES + 1);
  });

  it('gives null when the file does not have the diff line there', () => {
    expect(buildFileContext(file, span(20, 'something else'))).toBeNull();
    expect(buildFileContext(file, span(99, 'x'))).toBeNull();
  });

  it('reads Windows line endings', () => {
    const crlf = file.replaceAll('\n', '\r\n');
    expect(buildFileContext(crlf, span(4, '  let sum = 0;'))!.lines[0]).toBe(
      'export function totals(items: Item[]): number {',
    );
  });
});

const PR: PrRef = { owner: 'octo', repo: 'shop', number: 7, tab: 'files' };
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('headShaFromPage and rawFileUrls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it("reads the head commit from GitHub's page data", () => {
    document.body.innerHTML = `<script type="application/json">{"pr":{"headRefOid":"${SHA}"}}</script>`;
    expect(headShaFromPage(document, PR)).toBe(SHA);
  });

  it("takes the most common commit in the page's file links", () => {
    document.body.innerHTML = [
      `<a href="/octo/shop/blob/${OTHER}/old.ts">View file</a>`,
      `<a href="/octo/shop/blob/${SHA}/a.ts">View file</a>`,
      `<a href="/octo/shop/blob/${SHA}/b.ts">View file</a>`,
      `<a href="/someone/else/blob/${OTHER}/c.ts">elsewhere</a>`,
      `<a href="/someone/else/blob/${OTHER}/d.ts">elsewhere</a>`,
    ].join('');
    expect(headShaFromPage(document, PR)).toBe(SHA);
  });

  it('gives null when the page does not say', () => {
    document.body.innerHTML = '<a href="/octo/shop/blob/main/a.ts">a</a>';
    expect(headShaFromPage(document, PR)).toBeNull();
  });

  it("lists the page's raw URL first, then raw.githubusercontent.com", () => {
    expect(rawFileUrls(PR, 'src/my file#1.ts', SHA)).toEqual([
      `/octo/shop/raw/${SHA}/src/my%20file%231.ts`,
      'https://raw.githubusercontent.com/octo/shop/refs/pull/7/head/src/my%20file%231.ts',
    ]);
    expect(rawFileUrls(PR, 'a.ts', null)).toEqual([
      'https://raw.githubusercontent.com/octo/shop/refs/pull/7/head/a.ts',
    ]);
  });
});

describe('createFileContextLoader', () => {
  const file = lines(TS).join('\n');
  const click = span(4, '  let sum = 0;');

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('fetches each file once and finds the block for each click', async () => {
    const fetchText = vi.fn<(url: string) => Promise<string>>(async () => file);
    const loader = createFileContextLoader({ doc: document, fetchText });
    expect((await loader.load(PR, click))!.startLine).toBe(3);
    expect(
      (await loader.load(PR, span(20, '    this.items.push({ item, count });')))!.startLine,
    ).toBe(16);
    expect(fetchText).toHaveBeenCalledOnce();
    expect(fetchText.mock.calls[0]![0]).toContain('raw.githubusercontent.com');

    loader.forget();
    await loader.load(PR, click);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it("tries raw.githubusercontent.com when the page's raw URL fails", async () => {
    document.body.innerHTML = `<a href="/octo/shop/blob/${SHA}/src/cart.ts">View file</a>`;
    const fetchText = vi.fn(async (url: string) => {
      if (url.startsWith('/')) throw new Error('GitHub answered 404');
      return file;
    });
    const loader = createFileContextLoader({ doc: document, fetchText });
    expect(await loader.load(PR, click)).toBeDefined();
    expect(fetchText.mock.calls.map(([url]) => url)).toEqual(rawFileUrls(PR, 'src/cart.ts', SHA));
  });

  it('gives undefined when the file cannot be read, and tries again next time', async () => {
    const fetchText = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(file);
    const loader = createFileContextLoader({ doc: document, fetchText });
    expect(await loader.load(PR, click)).toBeUndefined();
    expect(await loader.load(PR, click)).toBeDefined();
  });

  it('gives up on a slow fetch after the timeout', async () => {
    vi.useFakeTimers();
    const fetchText = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<string>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const loader = createFileContextLoader({ doc: document, fetchText, timeoutMs: 500 });
    const result = loader.load(PR, click);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeUndefined();
  });

  it('gives undefined for a file that does not match the diff, or is too big', async () => {
    const loader = createFileContextLoader({ doc: document, fetchText: async () => file });
    expect(await loader.load(PR, span(4, 'changed since'))).toBeUndefined();
    const big = createFileContextLoader({
      doc: document,
      fetchText: async () => 'x'.repeat(1_000_001),
    });
    expect(await big.load(PR, click)).toBeUndefined();
  });
});
