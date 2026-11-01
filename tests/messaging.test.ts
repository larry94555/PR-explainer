import { RequestError, sendRequest } from '../src/messaging/client';
import type {
  ExtensionRuntime,
  MessageListener,
  MessageSenderLike,
} from '../src/messaging/protocol';
import { MessageRouter } from '../src/messaging/router';

const EXTENSION_ID = 'our-extension-id';

// A fake chrome.runtime that behaves like Chrome's: sendMessage calls every
// listener, and resolves with the first sendResponse value if a listener
// returned true, or with undefined if no listener did.
function fakeRuntime(sender: MessageSenderLike = { id: EXTENSION_ID }): ExtensionRuntime {
  const listeners: MessageListener[] = [];
  return {
    id: EXTENSION_ID,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage(message) {
      return new Promise((resolve) => {
        const wantsAsync = listeners.map((l) => l(message, sender, resolve)).some(Boolean);
        if (!wantsAsync) resolve(undefined);
      });
    },
  };
}

function connectedRuntime(router: MessageRouter): ExtensionRuntime {
  const runtime = fakeRuntime();
  router.listen(runtime);
  return runtime;
}

describe('messaging', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a request to the matching handler and resolves with its result', async () => {
    const ping = vi.fn(() => ({ receivedAt: 123 }));
    const runtime = connectedRuntime(new MessageRouter().on('ping', ping));

    await expect(sendRequest('ping', undefined, { runtime })).resolves.toEqual({ receivedAt: 123 });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('waits for async handlers', async () => {
    const runtime = connectedRuntime(
      new MessageRouter().on('ping', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { receivedAt: 7 };
      }),
    );
    await expect(sendRequest('ping', undefined, { runtime })).resolves.toEqual({ receivedAt: 7 });
  });

  it('rejects with the handler error, keeping its name and message', async () => {
    class ModelMissingError extends Error {
      name = 'ModelMissingError';
    }
    const runtime = connectedRuntime(
      new MessageRouter().on('ping', () => {
        throw new ModelMissingError('model not pulled');
      }),
    );

    const error = await sendRequest('ping', undefined, { runtime }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ name: 'ModelMissingError', message: 'model not pulled' });
  });

  it('rejects unknown request types', async () => {
    const runtime = connectedRuntime(new MessageRouter());
    await expect(sendRequest('ping', undefined, { runtime })).rejects.toMatchObject({
      name: 'UnknownRequestError',
      message: 'Unknown request type "ping"',
    });
  });

  it('rejects when nothing answers', async () => {
    const runtime = fakeRuntime(); // no router listening
    await expect(sendRequest('ping', undefined, { runtime })).rejects.toThrow(
      '"ping" got no answer from the service worker',
    );
  });

  it('rejects when sendMessage fails, for example after the extension is reloaded', async () => {
    const runtime: ExtensionRuntime = {
      ...fakeRuntime(),
      sendMessage: () => {
        throw new Error('Extension context invalidated.');
      },
    };
    await expect(sendRequest('ping', undefined, { runtime })).rejects.toThrow(
      'Could not reach the service worker: Extension context invalidated.',
    );
  });

  it('times out if the handler never answers', async () => {
    vi.useFakeTimers();
    const runtime = connectedRuntime(new MessageRouter().on('ping', () => new Promise(() => {})));

    const result = sendRequest('ping', undefined, { runtime, timeoutMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
      message: '"ping" timed out after 1000 ms',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('ignores messages that are not ours or come from another extension', () => {
    const ping = vi.fn(() => ({ receivedAt: 1 }));
    const listener = new MessageRouter().on('ping', ping).listener(EXTENSION_ID);
    const sendResponse = vi.fn();
    const request = { source: 'pr-explainer', type: 'ping', payload: undefined };

    expect(listener({ type: 'ping' }, { id: EXTENSION_ID }, sendResponse)).toBe(false);
    expect(listener('ping', { id: EXTENSION_ID }, sendResponse)).toBe(false);
    expect(listener(request, { id: 'another-extension' }, sendResponse)).toBe(false);
    expect(listener(request, {}, sendResponse)).toBe(false);
    expect(ping).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('refuses to register two handlers for the same type', () => {
    const router = new MessageRouter().on('ping', () => ({ receivedAt: 1 }));
    expect(() => router.on('ping', () => ({ receivedAt: 2 }))).toThrow(
      'A handler for "ping" is already registered',
    );
  });
});
