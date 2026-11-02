import { openAfter, RequestError, type PortStream } from '../src/messaging/client';

/** A stream whose result the test settles by hand. */
function fakeStream() {
  let resolve!: (value: string) => void;
  const result = new Promise<string>((r) => (resolve = r));
  const stream: PortStream<string> = { result, stop: vi.fn() };
  return { stream, resolve };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('openAfter', () => {
  it('opens the stream with the value once it is ready and passes its result on', async () => {
    const ready = deferred<string>();
    const { stream, resolve } = fakeStream();
    const open = vi.fn(() => stream);
    const wrapped = openAfter(ready.promise, open);
    expect(open).not.toHaveBeenCalled();
    ready.resolve('PR info');
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('PR info');
    resolve('answer');
    await expect(wrapped.result).resolves.toBe('answer');
  });

  it('stops the opened stream', async () => {
    const { stream } = fakeStream();
    const wrapped = openAfter(Promise.resolve(1), () => stream);
    await Promise.resolve();
    await Promise.resolve();
    wrapped.stop();
    wrapped.stop();
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it('never opens a stream stopped while waiting, and rejects at once with AbortError', async () => {
    const ready = deferred<number>();
    const open = vi.fn(() => fakeStream().stream);
    const wrapped = openAfter(ready.promise, open);
    wrapped.stop();
    const error = await wrapped.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).name).toBe('AbortError');
    ready.resolve(1);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects when waiting fails', async () => {
    const wrapped = openAfter(Promise.reject(new Error('no')), () => fakeStream().stream);
    await expect(wrapped.result).rejects.toThrow('no');
  });
});
