// @vitest-environment node
// PR 7.4: code from a PR may only go to GitHub (where it came from) and to
// the LLM on this computer. These tests check the two guarded fetches, and
// scan the source so a new fetch (or any other way to reach the network)
// that skips them fails here.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { describeLlmError } from '../src/llm/describeLlmError';
import { OllamaClient } from '../src/llm/ollamaClient';
import { LlmError } from '../src/llm/types';
import {
  allowedGithubUrl,
  BlockedRequestError,
  createGithubFetch,
  type FetchLike,
} from '../src/net/githubFetch';
import { createLlmFetch, localLlmOrigin } from '../src/net/llmFetch';

const PAGE = 'https://github.com/owner/repo/pull/7/files';
const LLM = 'http://localhost:11434';

const okFetch = () => vi.fn<FetchLike>(async () => new Response('ok'));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

describe('createGithubFetch (content script)', () => {
  it.each([
    ['/owner/repo/pull/7', 'https://github.com/owner/repo/pull/7'],
    ['/owner/repo/raw/abc/src/a.ts', 'https://github.com/owner/repo/raw/abc/src/a.ts'],
    ['https://github.com/owner/repo/pull/7', 'https://github.com/owner/repo/pull/7'],
    [
      'https://raw.githubusercontent.com/owner/repo/refs/pull/7/head/a.ts',
      'https://raw.githubusercontent.com/owner/repo/refs/pull/7/head/a.ts',
    ],
  ])('sends %s to %s', async (input, sent) => {
    const base = okFetch();
    const init = { credentials: 'same-origin' as const };
    const response = await createGithubFetch(base, () => PAGE)(input, init);
    expect(await response.text()).toBe('ok');
    expect(base).toHaveBeenCalledExactlyOnceWith(sent, { ...init, redirect: 'error' });
  });

  it.each([
    'https://example.com/collect',
    'http://github.com/owner/repo', // not https
    'https://github.com.evil.example/owner/repo',
    'https://gist.github.com/owner/abc',
    'https://api.github.com/repos/owner/repo',
    'https://user:secret@github.com/owner/repo',
    'https://github.com:8443/owner/repo',
    '//example.com/collect', // protocol-relative
    'http://localhost:11434/api/chat', // the LLM is reached only from the service worker
    'javascript:alert(1)',
    'data:text/plain,hi',
  ])('refuses %s without sending anything', async (input) => {
    const base = okFetch();
    const error = await rejection(createGithubFetch(base, () => PAGE)(input));
    expect(error).toBeInstanceOf(BlockedRequestError);
    expect((error as Error).message).toContain(input);
    expect(base).not.toHaveBeenCalled();
  });

  it('resolves relative paths against the current page each time', async () => {
    let page = PAGE;
    const base = okFetch();
    const githubFetch = createGithubFetch(base, () => page);
    page = 'https://example.com/elsewhere';
    // Off GitHub a relative path is not GitHub, so it is refused.
    await expect(githubFetch('/owner/repo')).rejects.toBeInstanceOf(BlockedRequestError);
    expect(base).not.toHaveBeenCalled();
  });

  it('reports which URLs are GitHub', () => {
    expect(allowedGithubUrl('/a', PAGE)?.href).toBe('https://github.com/a');
    expect(allowedGithubUrl('https://example.com/a', PAGE)).toBeNull();
    expect(allowedGithubUrl('http://[bad', PAGE)).toBeNull();
  });
});

describe('createLlmFetch (service worker and settings page)', () => {
  it('sends requests to the configured local server', async () => {
    const base = okFetch();
    await createLlmFetch(LLM, base)(`${LLM}/api/chat`, { method: 'POST' });
    expect(base).toHaveBeenCalledExactlyOnceWith(`${LLM}/api/chat`, {
      method: 'POST',
      redirect: 'error',
    });
  });

  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
    'https://localhost',
  ])('accepts %s as on this computer', (url) => {
    expect(localLlmOrigin(url)).toBe(new URL(url).origin);
  });

  it.each([
    'http://192.168.1.20:11434',
    'https://ollama.example.com',
    'http://localhost.example.com:11434',
    'http://user:pw@localhost:11434',
    'ftp://localhost',
    'not a url',
  ])('treats %s as not on this computer, and sends nothing to it', async (url) => {
    expect(localLlmOrigin(url)).toBeNull();
    const base = okFetch();
    const error = await rejection(createLlmFetch(url, base)(`${url}/api/chat`));
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('blocked');
    expect(base).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost:8080/api/chat', // another port
    'http://127.0.0.1:11434/api/chat', // same machine, but not the URL that was set
    'https://example.com/collect',
    'http://user:pw@localhost:11434/api/chat',
    '/api/chat',
  ])('refuses %s when the LLM is at localhost:11434', async (input) => {
    const base = okFetch();
    const error = await rejection(createLlmFetch(LLM, base)(input));
    expect((error as LlmError).kind).toBe('blocked');
    expect(base).not.toHaveBeenCalled();
  });

  it('guards OllamaClient, even with a fetch passed in', async () => {
    const base = okFetch();
    const client = new OllamaClient({ baseUrl: 'https://ollama.example.com', fetch: base });
    const error = await rejection(client.listModels());
    expect((error as LlmError).kind).toBe('blocked');
    expect(base).not.toHaveBeenCalled();
    expect(describeLlmError(error, { url: 'https://ollama.example.com' }).message).toContain(
      'only sends code to an LLM on this computer',
    );
  });
});

// Two real HTTP servers on this computer: "allowed" answers every request
// with a redirect to "outside", which counts what reaches it. The guards are
// given Node's real fetch, pointed at "allowed", so this checks the browser
// behaviour the guards rely on, not a fake.
describe('redirects are refused, so they cannot reach another host', () => {
  let outside: Server;
  let allowed: Server;
  let outsideHits = 0;
  let allowedUrl = '';
  let status = 302;

  const listen = (server: Server) =>
    new Promise<string>((done) =>
      server.listen(0, '127.0.0.1', () => {
        done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      }),
    );

  beforeAll(async () => {
    outside = createServer((_req, res) => {
      outsideHits++;
      res.end('collected');
    });
    const outsideUrl = await listen(outside);
    allowed = createServer((_req, res) => {
      res.writeHead(status, { Location: `${outsideUrl}/collect` });
      res.end();
    });
    allowedUrl = await listen(allowed);
  });

  afterAll(() => {
    outside.close();
    allowed.close();
  });

  beforeEach(() => {
    outsideHits = 0;
  });

  it.each([301, 302, 303, 307, 308])(
    'the LLM fetch fails on a %i and sends nothing to the other address',
    async (code) => {
      status = code;
      const llmFetch = createLlmFetch(allowedUrl);
      const error = await rejection(
        llmFetch(`${allowedUrl}/api/chat`, { method: 'POST', body: 'secret code' }),
      );
      expect(error).toBeInstanceOf(TypeError); // fetch's own "redirect mode is error"
      expect(outsideHits).toBe(0);
    },
  );

  it('OllamaClient reports a redirect as a failed connection, not an answer', async () => {
    status = 307;
    const client = new OllamaClient({ baseUrl: allowedUrl });
    const error = await rejection(client.listModels());
    expect((error as LlmError).kind).toBe('connection');
    expect(outsideHits).toBe(0);
  });

  it.each([301, 302, 307])(
    'the GitHub fetch fails on a %i and sends nothing to the other address',
    async (code) => {
      status = code;
      // Real fetch, with github.com swapped for the local "allowed" server
      // after the guard has checked the URL.
      const githubFetch = createGithubFetch(
        (input, init) => fetch(input.replace('https://github.com', allowedUrl), init),
        () => PAGE,
      );
      const error = await rejection(githubFetch('/owner/repo/raw/abc/a.ts'));
      expect(error).toBeInstanceOf(TypeError);
      expect(outsideHits).toBe(0);
    },
  );

  it('without the guard, the same redirect does reach the other address', async () => {
    // Shows the test above would catch a guard that let redirects through.
    status = 302;
    expect(await (await fetch(`${allowedUrl}/x`)).text()).toBe('collected');
    expect(outsideHits).toBe(1);
  });
});

// --- Source scan --------------------------------------------------------

const srcDir = resolve(import.meta.dirname, '../src');
const NET_DIR = 'net/';

function sourceFiles(dir = srcDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|html)$/.test(entry.name) ? [path] : [];
  });
}

// Drops comments, so a comment that mentions fetch( is not flagged.
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// Ways a script can send data off the page or worker. Only src/net/ may fetch;
// nothing may use the others.
const NETWORK_APIS: [string, RegExp][] = [
  ['fetch', /(?<![\w.]|\.\s*)fetch\s*\(|globalThis\.fetch|window\.fetch|self\.fetch/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['importScripts', /\bimportScripts\b/],
  // A link the user clicks is fine; a script, image or stylesheet loaded from
  // the web is a request.
  ['a remote script, image or stylesheet', /\bsrc\s*=\s*["'`]https?:|<link[^>]*href=["']https?:/],
];

describe('every network request goes through a guarded fetch', () => {
  const files = sourceFiles().map((path) => ({
    name: relative(srcDir, path).split('\\').join('/'),
    text: code(path),
  }));

  it('finds the source files', () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining(['content.ts', 'background.ts', 'net/githubFetch.ts']),
    );
  });

  it.each(NETWORK_APIS)('only src/net/ calls %s', (api, pattern) => {
    const offenders = files
      .filter((f) => pattern.test(f.text))
      .map((f) => f.name)
      .filter((name) => !(api === 'fetch' && name.startsWith(NET_DIR)));
    expect(offenders).toEqual([]);
  });

  it('flags a direct fetch, so the scan itself works', () => {
    const [, pattern] = NETWORK_APIS[0]!;
    expect(pattern.test("await fetch('https://example.com')")).toBe(true);
    expect(pattern.test('const r = await fetch (url);')).toBe(true);
    expect(pattern.test('globalThis.fetch(url)')).toBe(true);
    expect(pattern.test('await githubFetch(path)')).toBe(false);
    expect(pattern.test('await this.fetch(url)')).toBe(false);
    expect(pattern.test('deps.fetchText(url)')).toBe(false);
  });
});

// Follows relative imports (not `import type`, which leaves no code) from an
// entry, giving every module it bundles.
function bundled(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(
      /^(?:import|export)\s+(type\s+)?[^;]*?from\s+'(\.[^']+)'/gm,
    )) {
      if (match[1]) continue;
      const target = resolve(dirname(path), match[2]!);
      visit(target.endsWith('.ts') ? target : `${target}.ts`);
    }
  };
  visit(resolve(srcDir, entry));
  return new Set([...seen].map((p) => relative(srcDir, p).split('\\').join('/')));
}

describe('each side of the extension has only its own guard', () => {
  const content = bundled('content.ts');
  const worker = new Set([...bundled('background.ts'), ...bundled('options/main.ts')]);

  it('the content script reaches GitHub only, never the LLM directly', () => {
    expect(content.has('net/githubFetch.ts')).toBe(true);
    expect(content.has('net/llmFetch.ts')).toBe(false);
    expect([...content].filter((m) => m.startsWith('llm/'))).toEqual([]);
  });

  it('the service worker and settings page reach the LLM only, never GitHub', () => {
    expect(worker.has('net/llmFetch.ts')).toBe(true);
    expect(worker.has('net/githubFetch.ts')).toBe(false);
  });

  it('the content script shares no code with them, so content.js stays one classic script', () => {
    expect([...content].filter((m) => worker.has(m))).toEqual([]);
  });
});
