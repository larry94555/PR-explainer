import { describe, expect, it, vi } from 'vitest';
import {
  ChromeAiClient,
  CHROME_BUILT_IN_MODEL,
  type PromptApiLike,
} from '../src/llm/chromeAiClient';
import {
  CHROME_AI_PORT,
  offscreenDocument,
  OffscreenAiClient,
  serveChromeAi,
} from '../src/llm/offscreenAi';
import type { PortLike } from '../src/messaging/protocol';
import { LlmError } from '../src/llm/types';

/** Two ends of a port, as chrome.runtime.connect gives them, delivering messages asynchronously. */
function portPair(name: string) {
  const make = () => ({
    message: [] as ((m: unknown) => void)[],
    disconnect: [] as (() => void)[],
  });
  const a = make();
  const b = make();
  let open = true;
  const end = (mine: typeof a, theirs: typeof a): PortLike => ({
    name,
    postMessage: (m) => {
      if (!open) throw new Error('Attempting to use a disconnected port object');
      const copy = structuredClone(m);
      queueMicrotask(() => theirs.message.forEach((l) => l(copy)));
    },
    disconnect: () => {
      if (!open) return;
      open = false;
      queueMicrotask(() => theirs.disconnect.forEach((l) => l()));
    },
    onMessage: { addListener: (l) => mine.message.push(l) },
    onDisconnect: { addListener: (l) => mine.disconnect.push(l) },
  });
  return { worker: end(a, b), page: end(b, a), isOpen: () => open };
}

/** The offscreen document's side served with a fake Prompt API, and a worker client talking to it. */
function connected(api: PromptApiLike | undefined, ensureDocument = vi.fn(async () => {})) {
  const listeners: ((port: PortLike) => void)[] = [];
  serveChromeAi(
    { onConnect: { addListener: (l) => listeners.push(l) } },
    new ChromeAiClient(() => api),
  );
  const ports: ReturnType<typeof portPair>[] = [];
  const client = new OffscreenAiClient({
    ensureDocument,
    connect: ({ name }) => {
      const pair = portPair(name);
      ports.push(pair);
      listeners.forEach((l) => l(pair.page));
      return pair.worker;
    },
  });
  return { client, ports, ensureDocument };
}

function fakeApi(pieces: string[], gate?: Promise<void>): PromptApiLike & { aborted: boolean } {
  const api = {
    aborted: false,
    availability: async () => 'available',
    create: async () => ({
      contextWindow: 6144,
      promptStreaming: (_input: string, options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener('abort', () => (api.aborted = true));
        let i = 0;
        return new ReadableStream<string>({
          async pull(controller) {
            if (i === 1) await gate;
            if (i < pieces.length) controller.enqueue(pieces[i++]!);
            else controller.close();
          },
        });
      },
      destroy: () => {},
    }),
  };
  return api;
}

const MESSAGES = [
  { role: 'system' as const, content: 'You explain code.' },
  { role: 'user' as const, content: 'Explain a + b' },
];

describe('the built-in model through the offscreen document (PR 11.13)', () => {
  it('opens the document, then streams the answer piece by piece over a port', async () => {
    const { client, ports, ensureDocument } = connected(fakeApi(['It adds', ' them.']));
    const stream = client.chatStream(MESSAGES, { model: '', temperature: 0.2 });
    const pieces: string[] = [];
    let next = await stream.next();
    while (!next.done) {
      pieces.push(next.value);
      next = await stream.next();
    }
    expect(ensureDocument).toHaveBeenCalledTimes(1);
    expect(ports[0]!.worker.name).toBe(CHROME_AI_PORT);
    expect(pieces).toEqual(['It adds', ' them.']);
    expect(next.value).toEqual({ model: CHROME_BUILT_IN_MODEL, doneReason: 'stop' });
    expect(ports[0]!.isOpen()).toBe(false);
  });

  it('answers whole, says whether it is ready, and passes the context window on', async () => {
    const { client } = connected(fakeApi(['OK']));
    await expect(client.chat(MESSAGES, { model: '' })).resolves.toEqual({
      content: 'OK',
      model: CHROME_BUILT_IN_MODEL,
    });
    await expect(client.availability()).resolves.toBe('available');
    await expect(client.listModels()).resolves.toEqual([{ name: CHROME_BUILT_IN_MODEL }]);
    await expect(client.modelContext('')).resolves.toMatchObject({ maxTokens: 6144 });
    await expect(client.loadModel('')).resolves.toBeUndefined();
  });

  it('Stop closes the port, which stops the answer in the document', async () => {
    let release!: () => void;
    const api = fakeApi(['First', ' second'], new Promise<void>((r) => (release = r)));
    const { client, ports } = connected(api);
    const stop = new AbortController();
    const stream = client.chatStream(MESSAGES, { model: '', signal: stop.signal });
    expect(await stream.next()).toEqual({ done: false, value: 'First' });
    const next = stream.next();
    stop.abort();
    await expect(next).rejects.toMatchObject({ kind: 'aborted' });
    expect(ports[0]!.isOpen()).toBe(false);
    await vi.waitFor(() => expect(api.aborted).toBe(true));
    release();
  });

  it('honours Stop while the document is still opening: nothing is sent (review on #82)', async () => {
    let opened!: () => void;
    const ensureDocument = vi.fn(() => new Promise<void>((resolve) => (opened = resolve)));
    const { client, ports } = connected(fakeApi(['x']), ensureDocument);
    const stop = new AbortController();
    const answer = client.chat(MESSAGES, { model: '', signal: stop.signal });
    await vi.waitFor(() => expect(ensureDocument).toHaveBeenCalled());
    stop.abort();
    await expect(answer).rejects.toMatchObject({ kind: 'aborted' });
    opened();
    await new Promise((r) => setTimeout(r, 0));
    expect(ports).toHaveLength(0);
  });

  it('sends nothing when Stop comes as the document finishes opening (review on #82)', async () => {
    const stop = new AbortController();
    const { client, ports } = connected(
      fakeApi(['x']),
      vi.fn(async () => {
        stop.abort();
      }),
    );
    await expect(client.chat(MESSAGES, { model: '', signal: stop.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(ports).toHaveLength(0);
  });

  it('passes the error kind back, so the popup can say what to do', async () => {
    const { client } = connected(undefined);
    const error = await client.chat(MESSAGES, { model: '' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'unavailable' });
    await expect(client.availability()).resolves.toBe('unsupported');
  });

  it('fails clearly when the document cannot be opened or closes before answering', async () => {
    const { client } = connected(
      fakeApi(['x']),
      vi.fn(async () => {
        throw new Error('Only a single offscreen document may be created.');
      }),
    );
    await expect(client.chat(MESSAGES, { model: '' })).rejects.toMatchObject({
      kind: 'built-in-error',
      message: expect.stringContaining('Only a single offscreen'),
    });

    const silent = new OffscreenAiClient({
      ensureDocument: async () => {},
      connect: ({ name }) => {
        const pair = portPair(name);
        // Nothing listens: Chrome closes the port.
        pair.page.disconnect();
        return pair.worker;
      },
    });
    await expect(silent.chat(MESSAGES, { model: '' })).rejects.toMatchObject({
      kind: 'built-in-error',
      message: expect.stringContaining('closed before answering'),
    });
  });

  it('ignores ports with another name', () => {
    const listeners: ((port: PortLike) => void)[] = [];
    serveChromeAi(
      { onConnect: { addListener: (l) => listeners.push(l) } },
      new ChromeAiClient(() => undefined),
    );
    const other = portPair('pr-explainer:chat');
    const heard = vi.fn();
    other.worker.onMessage.addListener(heard);
    listeners.forEach((l) => l(other.page));
    other.worker.postMessage({ op: 'availability' });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(heard).not.toHaveBeenCalled();
        resolve();
      }, 0),
    );
  });
});

describe('opening the offscreen document (PR 11.13)', () => {
  const runtime = (open: number) => ({
    getContexts: vi.fn(async () => Array.from({ length: open }, () => ({}))),
    getURL: (path: string) => `chrome-extension://id/${path}`,
  });

  it('opens offscreen.html once, sharing one creation between calls at once', async () => {
    let finish!: () => void;
    const offscreen = {
      createDocument: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    };
    const run = runtime(0);
    const ensure = offscreenDocument(offscreen, run);
    const both = Promise.all([ensure(), ensure()]);
    await vi.waitFor(() => expect(offscreen.createDocument).toHaveBeenCalledTimes(1));
    finish();
    await both;
    expect(offscreen.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'offscreen.html', reasons: ['WORKERS'] }),
    );
    expect(run.getContexts).toHaveBeenCalledWith({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: ['chrome-extension://id/offscreen.html'],
    });
  });

  it('opens nothing when it is already open, as after a worker restart', async () => {
    const offscreen = { createDocument: vi.fn(async () => {}) };
    await offscreenDocument(offscreen, runtime(1))();
    expect(offscreen.createDocument).not.toHaveBeenCalled();
  });
});
