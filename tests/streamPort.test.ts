import type { ExplainResult, ExplainStreamOptions } from '../src/explain/explainHandler';
import type { ChatResult } from '../src/chat/chatHandler';
import { openChatStream, openExplainStream, RequestError } from '../src/messaging/client';
import type { PortLike, PortRuntime } from '../src/messaging/protocol';
import {
  CHAT_PORT,
  EXPLAIN_PORT,
  listenForChatPorts,
  listenForExplainPorts,
  serveExplainPort,
  type StreamingChat,
  type StreamingExplain,
} from '../src/messaging/streamPort';

const EXTENSION_ID = 'our-extension-id';

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'A.', why: 'B.', concerns: 'C.' },
  model: 'qwen2.5-coder:7b',
};

/** One end of a fake port. Messages arrive on the other end asynchronously, like Chrome's. */
interface FakePort extends PortLike {
  peer?: FakePort;
  connected: boolean;
  posted: unknown[];
  emitMessage(message: unknown): void;
  emitDisconnect(): void;
}

function fakePort(name: string, sender?: { id?: string }): FakePort {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name,
    sender,
    connected: true,
    posted: [],
    postMessage(message) {
      // Chrome throws when posting to a port that is no longer connected.
      if (!port.connected) throw new Error('Attempting to use a disconnected port object');
      port.posted.push(message);
      const peer = port.peer;
      queueMicrotask(() => peer?.connected && peer.emitMessage(structuredClone(message)));
    },
    disconnect() {
      if (!port.connected) return;
      port.connected = false;
      const peer = port.peer;
      if (peer?.connected) {
        peer.connected = false;
        queueMicrotask(() => peer.emitDisconnect());
      }
    },
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    emitMessage: (message) => messageListeners.forEach((l) => l(message)),
    emitDisconnect: () => disconnectListeners.forEach((l) => l()),
  };
  return port;
}

/** A fake chrome.runtime whose connect() reaches its own onConnect listeners. */
function fakeRuntime(senderId = EXTENSION_ID) {
  const listeners: Array<(port: PortLike) => void> = [];
  const workerPorts: FakePort[] = [];
  const runtime: PortRuntime = {
    id: EXTENSION_ID,
    onConnect: { addListener: (listener) => listeners.push(listener) },
    connect({ name }) {
      const page = fakePort(name);
      const worker = fakePort(name, { id: senderId });
      page.peer = worker;
      worker.peer = page;
      workerPorts.push(worker);
      queueMicrotask(() => listeners.forEach((l) => l(worker)));
      return page;
    },
  };
  return { runtime, workerPorts };
}

/** An explain handler the test drives: it sends chunks and settles when told to. */
function controllableExplain() {
  let options!: ExplainStreamOptions;
  let resolve!: (result: ExplainResult) => void;
  let reject!: (error: unknown) => void;
  const explain = vi.fn<StreamingExplain>((_payload, opts) => {
    options = opts;
    return new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  return {
    explain,
    chunk: (text: string) => options.onChunk?.(text),
    signal: () => options.signal!,
    resolve: (result: ExplainResult) => resolve(result),
    reject: (error: unknown) => reject(error),
  };
}

/** Lets queued messages and promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('explain stream over a port', () => {
  it('forwards chunks in order, then the result', async () => {
    const { runtime } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);

    const chunks: string[] = [];
    const stream = openExplainStream(
      { context: 'the context' },
      (text) => chunks.push(text),
      runtime,
    );
    await flush();
    expect(model.explain).toHaveBeenCalledWith(
      { context: 'the context', fresh: false, cause: 'click' },
      expect.anything(),
    );

    model.chunk('## What');
    model.chunk(' it does');
    model.chunk('\nA.');
    model.resolve(DONE);
    await expect(stream.result).resolves.toEqual(DONE);
    expect(chunks).toEqual(['## What', ' it does', '\nA.']);
  });

  it('passes the PR and the Regenerate flag to the service worker, and a cached answer back', async () => {
    const { runtime } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);

    const stream = openExplainStream(
      { context: 'ctx', pr: 'owner/repo#17', fresh: true },
      () => {},
      runtime,
    );
    await flush();
    expect(model.explain).toHaveBeenCalledWith(
      { context: 'ctx', pr: 'owner/repo#17', fresh: true, cause: 'click' },
      expect.anything(),
    );
    const cached: ExplainResult = { ...DONE, cached: { elapsedMs: 9800, savedAt: 1 } };
    model.resolve(cached);
    await expect(stream.result).resolves.toEqual(cached);
  });

  it('ignores a PR or Regenerate flag of the wrong type', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);
    runtime.connect({ name: EXPLAIN_PORT });
    await flush();
    workerPorts[0]!.emitMessage({
      type: 'start',
      context: 'ctx',
      pr: 17,
      fresh: 'yes',
      cause: 'warmup',
    });
    expect(model.explain).toHaveBeenCalledWith(
      { context: 'ctx', fresh: false, cause: 'click' },
      expect.anything(),
    );
  });

  it('passes on that Explain on hover asked (PR 9.2)', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);
    runtime.connect({ name: EXPLAIN_PORT });
    await flush();
    workerPorts[0]!.emitMessage({ type: 'start', context: 'ctx', cause: 'hover' });
    expect(model.explain).toHaveBeenCalledWith(
      { context: 'ctx', fresh: false, cause: 'hover' },
      expect.anything(),
    );
  });

  it('passes on that Explain ahead asked, and its debug log group (PR 9.10)', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);
    runtime.connect({ name: EXPLAIN_PORT });
    await flush();
    workerPorts[0]!.emitMessage({
      type: 'start',
      context: 'ctx',
      cause: 'ahead',
      debugId: 'ahead-1',
    });
    expect(model.explain).toHaveBeenCalledWith(
      { context: 'ctx', fresh: false, cause: 'ahead', debugId: 'ahead-1' },
      expect.anything(),
    );
  });

  it("passes on the line's name and place for the queue, and the tab that asked (PR 10.3)", async () => {
    const model = controllableExplain();
    const port = fakePort(EXPLAIN_PORT, { id: EXTENSION_ID, tab: { id: 42 } } as never);
    serveExplainPort(port, model.explain);
    port.emitMessage({
      type: 'start',
      context: 'ctx',
      cause: 'hover',
      job: { label: 'src/a.ts:added:3', order: 7, extra: 'dropped' },
    });
    expect(model.explain).toHaveBeenCalledWith(
      {
        context: 'ctx',
        fresh: false,
        cause: 'hover',
        job: { label: 'src/a.ts:added:3', order: 7 },
      },
      expect.objectContaining({ tab: 42 }),
    );
  });

  it('ignores a malformed job, and cuts a long label', async () => {
    const model = controllableExplain();
    const port = fakePort(EXPLAIN_PORT, { id: EXTENSION_ID });
    serveExplainPort(port, model.explain);
    port.emitMessage({ type: 'start', context: 'ctx', job: { label: 3, order: 'x' } });
    expect(model.explain.mock.calls[0]![0]).not.toHaveProperty('job');
    expect(model.explain.mock.calls[0]![1]).not.toHaveProperty('tab');

    const second = controllableExplain();
    const other = fakePort(EXPLAIN_PORT, { id: EXTENSION_ID });
    serveExplainPort(other, second.explain);
    other.emitMessage({
      type: 'start',
      context: 'ctx',
      job: { label: 'x'.repeat(500), order: NaN },
    });
    expect(second.explain.mock.calls[0]![0].job).toEqual({ label: 'x'.repeat(200) });
  });

  it('Stop disconnects the port, which aborts the request in the service worker', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);

    const chunks: string[] = [];
    const stream = openExplainStream({ context: 'ctx' }, (text) => chunks.push(text), runtime);
    await flush();
    model.chunk('first');
    await flush();
    expect(model.signal().aborted).toBe(false);

    stream.stop();
    await flush();
    expect(model.signal().aborted).toBe(true);
    await expect(stream.result).rejects.toMatchObject({ name: 'AbortError' });

    // The handler keeps going for a moment after the abort: nothing it sends
    // throws in the service worker, and nothing reaches the page.
    expect(() => model.chunk('late')).not.toThrow();
    model.resolve(DONE);
    await flush();
    expect(chunks).toEqual(['first']);
    expect(workerPorts[0]!.posted).toEqual([{ type: 'chunk', text: 'first' }]);
  });

  it('turns a handler error into a RequestError with the same name and message', async () => {
    const { runtime } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);

    const stream = openExplainStream({ context: 'ctx' }, () => {}, runtime);
    await flush();
    model.reject(new TypeError('explain needs a non-empty context'));
    const error = await stream.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({
      name: 'TypeError',
      message: 'explain needs a non-empty context',
    });
  });

  it('closes the port once the result arrives', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    const model = controllableExplain();
    listenForExplainPorts(runtime, model.explain);

    const stream = openExplainStream({ context: 'ctx' }, () => {}, runtime);
    await flush();
    model.resolve(DONE);
    await stream.result;
    await flush();
    expect(workerPorts[0]!.connected).toBe(false);
    // Closing after the answer does not abort anything that matters, and
    // stop() afterwards changes nothing.
    stream.stop();
    await expect(stream.result).resolves.toEqual(DONE);
  });

  it('ignores ports with another name or from another extension', async () => {
    const model = controllableExplain();
    const other = fakeRuntime();
    listenForExplainPorts(other.runtime, model.explain);
    other.runtime.connect({ name: 'something-else' }).postMessage({ type: 'start', context: 'x' });

    const stranger = fakeRuntime('another-extension');
    listenForExplainPorts(stranger.runtime, model.explain);
    stranger.runtime.connect({ name: EXPLAIN_PORT }).postMessage({ type: 'start', context: 'x' });
    await flush();
    expect(model.explain).not.toHaveBeenCalled();
  });
});

describe('serveExplainPort', () => {
  it('does not crash when posting to a port that closed without telling it', async () => {
    const port = fakePort(EXPLAIN_PORT, { id: EXTENSION_ID });
    const model = controllableExplain();
    serveExplainPort(port, model.explain);
    port.emitMessage({ type: 'start', context: 'ctx' });

    port.connected = false; // postMessage now throws, as Chrome's does
    expect(() => model.chunk('a')).not.toThrow();
    expect(model.signal().aborted).toBe(true);
    model.resolve(DONE);
    await flush();
    expect(port.posted).toEqual([]);
  });

  it('runs only the first start message and ignores anything else', () => {
    const port = fakePort(EXPLAIN_PORT, { id: EXTENSION_ID });
    const model = controllableExplain();
    serveExplainPort(port, model.explain);
    port.emitMessage('hello');
    port.emitMessage({ type: 'start', context: 'one' });
    port.emitMessage({ type: 'start', context: 'two' });
    expect(model.explain).toHaveBeenCalledOnce();
    expect(model.explain).toHaveBeenCalledWith(
      { context: 'one', fresh: false, cause: 'click' },
      expect.anything(),
    );
  });
});

describe('openExplainStream', () => {
  it('rejects with a friendly reason when the extension was reloaded', async () => {
    const runtime: PortRuntime = {
      id: EXTENSION_ID,
      onConnect: { addListener: () => {} },
      connect: () => {
        throw new Error('Extension context invalidated.');
      },
    };
    await expect(openExplainStream({ context: 'ctx' }, () => {}, runtime).result).rejects.toThrow(
      'Could not reach the service worker: Extension context invalidated.',
    );
  });

  it('rejects when the service worker closes the port before answering', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    listenForExplainPorts(runtime, controllableExplain().explain);
    const chunks: string[] = [];
    const stream = openExplainStream({ context: 'ctx' }, (text) => chunks.push(text), runtime);
    await flush();
    runtime.lastError = { message: 'Receiving end does not exist.' };
    workerPorts[0]!.disconnect();
    await expect(stream.result).rejects.toThrow(
      'Could not reach the service worker: Receiving end does not exist.',
    );
  });

  it('stop() does not leave an unhandled rejection when nobody listens', async () => {
    const { runtime } = fakeRuntime();
    listenForExplainPorts(runtime, controllableExplain().explain);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      openExplainStream({ context: 'ctx' }, () => {}, runtime).stop();
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('gives a default reason when Chrome does not say why the port closed', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    listenForExplainPorts(runtime, controllableExplain().explain);
    const stream = openExplainStream({ context: 'ctx' }, () => {}, runtime);
    await flush();
    workerPorts[0]!.disconnect();
    await expect(stream.result).rejects.toThrow('closed before the answer arrived');
  });
});

describe('chat stream over a port', () => {
  const MESSAGES = [{ role: 'user' as const, content: 'How would I unit test this?' }];

  it('sends the messages, forwards chunks, then the answer', async () => {
    const { runtime } = fakeRuntime();
    const done: ChatResult = { status: 'done', answer: 'Use fake timers.', model: 'm' };
    const chat = vi.fn<StreamingChat>(async (_payload, { onChunk }) => {
      onChunk?.('Use ');
      onChunk?.('fake timers.');
      return done;
    });
    listenForChatPorts(runtime, chat);
    // The explain listener does not answer chat ports.
    const explain = controllableExplain();
    listenForExplainPorts(runtime, explain.explain);

    const chunks: string[] = [];
    const stream = openChatStream({ messages: MESSAGES }, (t) => chunks.push(t), runtime);
    await expect(stream.result).resolves.toEqual(done);
    expect(chunks).toEqual(['Use ', 'fake timers.']);
    expect(chat).toHaveBeenCalledWith({ messages: MESSAGES }, expect.anything());
    expect(explain.explain).not.toHaveBeenCalled();
  });

  it('Stop aborts the chat request in the service worker', async () => {
    const { runtime, workerPorts } = fakeRuntime();
    let signal!: AbortSignal;
    listenForChatPorts(runtime, (_payload, options) => {
      signal = options.signal!;
      return new Promise(() => {});
    });
    const stream = openChatStream({ messages: MESSAGES }, () => {}, runtime);
    await flush();
    expect(workerPorts[0]!.name).toBe(CHAT_PORT);
    stream.stop();
    await expect(stream.result).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(signal.aborted).toBe(true);
  });

  it('turns a handler that throws at once into an error', async () => {
    const { runtime } = fakeRuntime();
    listenForChatPorts(runtime, () => {
      throw new Error('chat needs a list of messages that ends with a question');
    });
    const stream = openChatStream({ messages: [] }, () => {}, runtime);
    await expect(stream.result).rejects.toThrow(/ends with a question/);
  });
});
