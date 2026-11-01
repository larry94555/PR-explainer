import { OllamaClient, type FetchLike } from '../src/llm/ollamaClient';
import { LlmError, type ChatMessage, type LlmErrorKind } from '../src/llm/types';

const BASE = 'http://localhost:11434';
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Explain this' }];
const MODEL = 'qwen2.5-coder:7b';

const encoder = new TextEncoder();

// One line of Ollama's stream, as it sends it (with the trailing newline).
function line(content: string): string {
  return (
    JSON.stringify({ model: MODEL, message: { role: 'assistant', content }, done: false }) + '\n'
  );
}
const DONE =
  JSON.stringify({
    model: MODEL,
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
  }) + '\n';

// A response whose body sends each string as its own network chunk.
function streamResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

// A response whose body is fed by the test, to control timing and failures.
function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel,
  });
  return {
    response: new Response(body),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    fail: (error: unknown) => controller.error(error),
    cancel,
  };
}

function client(response: Response | (() => Promise<Response>)) {
  const fetch = vi.fn<FetchLike>(async () =>
    typeof response === 'function' ? response() : response,
  );
  return { client: new OllamaClient({ baseUrl: BASE, fetch }), fetch };
}

// Runs the whole stream and returns the pieces and the return value.
async function collect(stream: AsyncGenerator<string, unknown>) {
  const pieces: string[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { pieces, end: next.value };
    pieces.push(next.value);
  }
}

async function expectLlmError(promise: Promise<unknown>, kind: LlmErrorKind) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmError);
  expect((error as LlmError).kind).toBe(kind);
  return error as LlmError;
}

describe('OllamaClient.chatStream', () => {
  it('POSTs /api/chat with stream: true and the model options', async () => {
    const { client: c, fetch } = client(streamResponse([line('Hi'), DONE]));
    await collect(
      c.chatStream(MESSAGES, { model: ` ${MODEL} `, temperature: 0.2, maxResponseTokens: 50 }),
    );

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/chat`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      model: MODEL,
      messages: MESSAGES,
      stream: true,
      options: { temperature: 0.2, num_predict: 50 },
    });
  });

  it('yields each piece of text and returns the model and done reason', async () => {
    const { client: c } = client(
      streamResponse([line('The '), line('function '), line('adds.'), DONE]),
    );
    const { pieces, end } = await collect(c.chatStream(MESSAGES, { model: MODEL }));

    expect(pieces).toEqual(['The ', 'function ', 'adds.']);
    expect(end).toEqual({ model: MODEL, doneReason: 'stop' });
  });

  it('joins JSON lines that are split across network chunks', async () => {
    const all = line('Hello') + line(', world') + DONE;
    // Cut in the middle of a line, in the middle of the next one, and so on.
    const chunks = [all.slice(0, 7), all.slice(7, 40), all.slice(40, 41), all.slice(41)];
    const { client: c } = client(streamResponse(chunks));

    const { pieces } = await collect(c.chatStream(MESSAGES, { model: MODEL }));
    expect(pieces).toEqual(['Hello', ', world']);
  });

  it('handles several lines in one chunk and a multi-byte character split between chunks', async () => {
    const bytes = encoder.encode(line('a') + line('é ✓') + DONE);
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "é"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const { client: c } = client(new Response(body));

    const { pieces } = await collect(c.chatStream(MESSAGES, { model: MODEL }));
    expect(pieces).toEqual(['a', 'é ✓']);
  });

  it('accepts a final done line without a trailing newline, and skips blank lines', async () => {
    const { client: c } = client(streamResponse([line('x'), '\n\n', DONE.trimEnd()]));
    const { pieces, end } = await collect(c.chatStream(MESSAGES, { model: MODEL }));
    expect(pieces).toEqual(['x']);
    expect(end).toEqual({ model: MODEL, doneReason: 'stop' });
  });

  it('yields text sent on the done line and reports a reply cut off by the length limit', async () => {
    const last = JSON.stringify({
      model: MODEL,
      message: { content: 'end' },
      done: true,
      done_reason: 'length',
    });
    const { client: c } = client(streamResponse([line('the '), last]));
    const { pieces, end } = await collect(c.chatStream(MESSAGES, { model: MODEL }));
    expect(pieces).toEqual(['the ', 'end']);
    expect(end).toEqual({ model: MODEL, doneReason: 'length' });
  });

  it('stops reading at the done line', async () => {
    const { client: c } = client(streamResponse([line('a'), DONE, line('ignored')]));
    const { pieces } = await collect(c.chatStream(MESSAGES, { model: MODEL }));
    expect(pieces).toEqual(['a']);
  });

  it('stops and raises aborted when the signal fires mid-stream, and cancels the body', async () => {
    const body = controlledResponse();
    const { client: c } = client(body.response);
    const controller = new AbortController();
    const stream = c.chatStream(MESSAGES, { model: MODEL, signal: controller.signal });

    body.send(line('first '));
    expect(await stream.next()).toEqual({ done: false, value: 'first ' });

    // The next read is waiting for more data when the signal fires.
    const pending = stream.next();
    controller.abort();
    await expectLlmError(pending, 'aborted');
    expect(body.cancel).toHaveBeenCalled();
  });

  it('raises aborted without calling the server when the signal already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return streamResponse([DONE]);
    });
    const c = new OllamaClient({ baseUrl: BASE, fetch });
    await expectLlmError(
      collect(c.chatStream(MESSAGES, { model: MODEL, signal: controller.signal })),
      'aborted',
    );
  });

  it('cancels the request when the caller leaves the loop early', async () => {
    const body = controlledResponse();
    const { client: c } = client(body.response);
    body.send(line('one ') + line('two '));

    const pieces: string[] = [];
    for await (const piece of c.chatStream(MESSAGES, { model: MODEL })) {
      pieces.push(piece);
      break;
    }
    expect(pieces).toEqual(['one ']);
    expect(body.cancel).toHaveBeenCalled();
  });

  it('raises connection when the stream errors halfway, after yielding what arrived', async () => {
    const body = controlledResponse();
    const { client: c } = client(body.response);
    const stream = c.chatStream(MESSAGES, { model: MODEL });

    body.send(line('partial'));
    expect(await stream.next()).toEqual({ done: false, value: 'partial' });
    body.fail(new TypeError('network error'));
    const error = await expectLlmError(stream.next(), 'connection');
    expect(error.message).toContain('was lost');
  });

  it('raises connection when the stream ends before the done line', async () => {
    const { client: c } = client(streamResponse([line('half')]));
    const error = await expectLlmError(
      collect(c.chatStream(MESSAGES, { model: MODEL })),
      'connection',
    );
    expect(error.message).toContain('closed mid-reply');
  });

  it("raises http with Ollama's message when it sends an error line mid-stream", async () => {
    const { client: c } = client(
      streamResponse([line('a'), JSON.stringify({ error: 'model runner has crashed' }) + '\n']),
    );
    const error = await expectLlmError(collect(c.chatStream(MESSAGES, { model: MODEL })), 'http');
    expect(error.message).toContain('model runner has crashed');
  });

  it.each([
    ['a line that is not JSON', 'not json\n'],
    ['a line that is not an object', '42\n'],
    ['a line without message.content', JSON.stringify({ done: false }) + '\n'],
    ['content that is not text', JSON.stringify({ message: { content: 5 }, done: false }) + '\n'],
  ])('raises bad-response for %s', async (_label, bad) => {
    const { client: c } = client(streamResponse([bad]));
    await expectLlmError(collect(c.chatStream(MESSAGES, { model: MODEL })), 'bad-response');
  });

  it('raises the same errors as chat() before the stream starts', async () => {
    const missing = client(
      new Response(JSON.stringify({ error: `model "${MODEL}" not found` }), { status: 404 }),
    );
    await expectLlmError(
      collect(missing.client.chatStream(MESSAGES, { model: MODEL })),
      'model-not-found',
    );

    const blocked = client(new Response('', { status: 403 }));
    await expectLlmError(
      collect(blocked.client.chatStream(MESSAGES, { model: MODEL })),
      'origin-blocked',
    );

    const down = client(() => Promise.reject(new TypeError('Failed to fetch')));
    await expectLlmError(collect(down.client.chatStream(MESSAGES, { model: MODEL })), 'connection');
  });

  it('raises no-model without calling the server when no model is chosen', async () => {
    const { client: c, fetch } = client(streamResponse([DONE]));
    await expectLlmError(collect(c.chatStream(MESSAGES, { model: '  ' })), 'no-model');
    expect(fetch).not.toHaveBeenCalled();
  });
});
