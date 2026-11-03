// @vitest-environment node
// PR 9.2: the service worker records each round trip to Ollama.
import { OllamaClient } from '../src/llm/ollamaClient';
import { chatReplyOf, createRoundTripLog, purposeOf } from '../src/net/roundTrips';

const URL_CHAT = 'http://localhost:11434/api/chat';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** A response whose body arrives in `pieces`, each `stepMs` apart on `time`. */
function streamed(pieces: string[], time: ReturnType<typeof clock>, stepMs = 100): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        time.advance(stepMs);
        if (i < pieces.length) controller.enqueue(encoder.encode(pieces[i++]!));
        else controller.close();
      },
    }),
  );
}

describe('round trip log (PR 9.2)', () => {
  it('records a request with its endpoint, purpose, times, status and sizes', async () => {
    const time = clock();
    const log = createRoundTripLog('click', time.now);
    time.advance(5);
    const response = await log.record(
      'http://localhost:11434/api/show',
      { method: 'POST', body: '{"model":"m"}' },
      async () => {
        time.advance(20);
        return new Response('{"model_info":{}}');
      },
    );
    expect(log.list()[0]).toMatchObject({ status: 'running' });
    expect(await response.text()).toBe('{"model_info":{}}');
    expect(log.list()).toEqual([
      {
        id: `${log.group}:1`,
        target: 'ollama',
        method: 'POST',
        endpoint: 'localhost:11434/api/show',
        purpose: 'model details',
        cause: 'click',
        startMs: 5,
        durationMs: 20,
        status: 'done',
        httpStatus: 200,
        bytesSent: 13,
        bytesReceived: 17,
      },
    ]);
  });

  it('times the round trip until the whole reply was read', async () => {
    const time = clock();
    const log = createRoundTripLog('click', time.now);
    const response = await log.record(URL_CHAT, { method: 'POST' }, async () =>
      streamed(['{"message":{"content":"a"}}\n', '{"done":true}\n'], time),
    );
    await response.text();
    // Two pieces and the end of the stream, 100 ms apart.
    expect(log.list()[0]!.durationMs).toBe(300);
  });

  it("keeps a chat request's messages, and puts the streamed reply together from its pieces", async () => {
    const time = clock();
    const log = createRoundTripLog('click', time.now);
    const body = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Explain x++' },
      ],
    });
    const response = await log.record(URL_CHAT, { method: 'POST', body }, async () =>
      // A line split across two pieces, and thinking in its own field.
      streamed(
        [
          '{"message":{"thinking":"Hmm."}}\n{"message":{"con',
          'tent":"<think>t</think>Adds"}}\n',
          '{"message":{"content":" one."}}\n{"done":true}\n',
        ],
        time,
      ),
    );
    await response.text();
    expect(log.list()[0]).toMatchObject({
      purpose: 'explanation',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Explain x++' },
      ],
      reply: '<think>t</think>Adds one.',
      thinking: 'Hmm.',
      status: 'done',
    });
  });

  it('keeps the think sent with a chat request (PR 9.5)', async () => {
    const log = createRoundTripLog('click');
    for (const think of [false, true, undefined]) {
      const body = JSON.stringify({
        model: 'm',
        messages: [],
        ...(think !== undefined && { think }),
      });
      const response = await log.record(
        URL_CHAT,
        { method: 'POST', body },
        async () => new Response('{"done":true}\n'),
      );
      await response.text();
    }
    expect(log.list().map((t) => t.think)).toEqual([false, true, undefined]);
  });

  it('keeps no messages or reply for other endpoints', async () => {
    const log = createRoundTripLog('click');
    const response = await log.record(
      'http://localhost:11434/api/ps',
      {},
      async () => new Response('{"models":[]}'),
    );
    await response.text();
    const [trip] = log.list();
    expect(trip).not.toHaveProperty('messages');
    expect(trip).not.toHaveProperty('reply');
    expect(trip).toMatchObject({ method: 'GET', purpose: 'loaded window' });
  });

  it('records a request that could not connect as failed, with its error', async () => {
    const log = createRoundTripLog('click');
    await expect(
      log.record(URL_CHAT, {}, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toThrow('Failed to fetch');
    expect(log.list()[0]).toMatchObject({ status: 'failed', error: 'Failed to fetch' });
    expect(log.list()[0]).not.toHaveProperty('httpStatus');
  });

  it('records an HTTP error as failed, with its status', async () => {
    const log = createRoundTripLog('click');
    const response = await log.record(
      URL_CHAT,
      {},
      async () => new Response('{"error":"model not found"}', { status: 404 }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"model not found"}');
    expect(log.list()[0]).toMatchObject({ status: 'failed', httpStatus: 404, error: 'HTTP 404' });
  });

  it('records a cancelled request, before the answer and midway through the reply', async () => {
    const log = createRoundTripLog('click');
    const before = new AbortController();
    before.abort();
    await expect(
      log.record(URL_CHAT, { signal: before.signal }, async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    ).rejects.toThrow();
    const time = clock();
    const response = await log.record(URL_CHAT, {}, async () =>
      streamed(['{"message":{"content":"a"}}\n', 'never read'], time),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(log.list().map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
    // What arrived before Stop is kept.
    expect(log.list()[1]!.reply).toBe('a');
  });

  it('records a refused request', () => {
    const log = createRoundTripLog('click');
    log.refuse('https://example.com/api/chat', { method: 'POST' }, new Error('Refused'));
    expect(log.list()[0]).toMatchObject({
      endpoint: 'example.com/api/chat',
      status: 'refused',
      error: 'Refused',
    });
  });

  it('ties each round trip to its cause, and times it from another log when asked', async () => {
    const time = clock();
    const warmup = createRoundTripLog('warmup', time.now);
    await (await warmup.record(URL_CHAT, {}, async () => new Response('{}'))).text();
    time.advance(400);
    const click = createRoundTripLog('hover', time.now);
    await (await click.record(URL_CHAT, {}, async () => new Response('{}'))).text();
    expect(warmup.list(click.origin)[0]).toMatchObject({
      cause: 'warmup',
      purpose: 'load the model',
      startMs: -400,
    });
    expect(click.list()[0]).toMatchObject({ cause: 'hover', purpose: 'explanation', startMs: 0 });
  });

  it('names why each endpoint is asked', () => {
    expect(purposeOf('/api/show', 'click')).toBe('model details');
    expect(purposeOf('/api/ps', 'click')).toBe('loaded window');
    expect(purposeOf('/api/ps', 'warmup')).toBe('is the model loaded');
    expect(purposeOf('/api/chat', 'click')).toBe('explanation');
    expect(purposeOf('/api/chat', 'warmup')).toBe('load the model');
    expect(purposeOf('/api/tags', 'click')).toBe('list models');
    expect(purposeOf('/api/other', 'click')).toBe('/api/other');
  });

  it('reads a reply that is one JSON object, as well as a stream', () => {
    expect(chatReplyOf('{"message":{"content":"All at once."},"done":true}')).toEqual({
      reply: 'All at once.',
      thinking: '',
    });
  });

  it('records every request an OllamaClient makes, and the client still works', async () => {
    const log = createRoundTripLog('click');
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/api/ps')
        ? new Response(JSON.stringify({ models: [{ name: 'm:latest', context_length: 2048 }] }))
        : new Response(
            '{"message":{"content":"Hi"}}\n{"done":true,"done_reason":"stop","eval_count":1}\n',
          ),
    );
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch, roundTrips: log });
    expect(await client.loadedContextTokens('m')).toBe(2048);
    const stream = client.chatStream([{ role: 'user', content: 'Hello' }], { model: 'm' });
    const pieces: string[] = [];
    for await (const piece of stream) pieces.push(piece);
    expect(pieces).toEqual(['Hi']);
    expect(log.list().map((t) => [t.endpoint, t.purpose, t.status, t.reply])).toEqual([
      ['localhost:11434/api/ps', 'loaded window', 'done', undefined],
      ['localhost:11434/api/chat', 'explanation', 'done', 'Hi'],
    ]);
    expect(log.list()[1]!.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });
});

describe('round trip log: a stream that stays open (PR 9.2)', () => {
  it("ends the round trip at the stream's last line, as the client stops reading there", async () => {
    const time = clock();
    const log = createRoundTripLog('click', time.now);
    const encoder = new TextEncoder();
    const response = await log.record(
      URL_CHAT,
      {},
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"message":{"content":"a"}}\n{"done":true}\n'));
              // Never closed.
            },
          }),
        ),
    );
    const reader = response.body!.getReader();
    await reader.read();
    expect(log.list()[0]).toMatchObject({ status: 'done', reply: 'a' });
  });
});

describe('round trips as they run, for the debug window (PR 9.4)', () => {
  it('tells onUpdate when a round trip starts, as its reply grows, and when it ends', async () => {
    const time = clock();
    const updates: { id?: string; status: string; reply?: string; durationMs: number }[] = [];
    const log = createRoundTripLog('click', time.now, {
      group: 'click-1',
      onUpdate: ({ id, status, reply, durationMs }) =>
        updates.push({ id, status, reply, durationMs }),
    });
    const pieces = [
      '{"message":{"content":"One"}}\n',
      '{"message":{"content":" two"}}\n',
      '{"message":{"content":" three"}}\n',
      '{"done":true,"total_duration":900000000,"load_duration":5000000,"prompt_eval_count":40,' +
        '"prompt_eval_duration":100000000,"eval_count":3,"eval_duration":700000000}\n',
    ];
    // 150 ms apart, so not every piece is passed on.
    const response = await log.record(
      URL_CHAT,
      { method: 'POST', body: '{"messages":[{"role":"user","content":"hi"}]}' },
      async () => streamed(pieces, time, 150),
    );
    await response.text();
    expect(updates.every((u) => u.id === 'click-1:1')).toBe(true);
    expect(updates[0]).toMatchObject({ status: 'running', reply: undefined, durationMs: 0 });
    expect(updates.at(-1)).toMatchObject({ status: 'done', reply: 'One two three' });
    // In between: the reply so far, growing, at most every PROGRESS_MS.
    const between = updates.slice(1, -1);
    expect(between.length).toBeGreaterThan(0);
    expect(between.length).toBeLessThan(pieces.length);
    for (const [k, u] of between.entries()) {
      expect(u.status).toBe('running');
      expect('One two three'.startsWith(u.reply!)).toBe(true);
      if (k > 0) expect(u.durationMs - between[k - 1]!.durationMs).toBeGreaterThanOrEqual(250);
    }
    expect(log.list()[0]!.timings).toEqual({
      totalMs: 900,
      loadMs: 5,
      promptTokens: 40,
      promptMs: 100,
      answerTokens: 3,
      answerMs: 700,
    });
  });

  it('gives each round trip of a log its own id', async () => {
    const ids: string[] = [];
    const log = createRoundTripLog('warmup', Date.now, {
      group: 'w',
      onUpdate: (trip) => ids.push(trip.id!),
    });
    await (
      await log.record('http://localhost:11434/api/ps', {}, async () => new Response('{}'))
    ).text();
    log.refuse('http://example.com/', {}, new Error('blocked'));
    expect(ids).toEqual(['w:1', 'w:1', 'w:2', 'w:2']);
  });

  it('keeps a request going when onUpdate throws', async () => {
    const log = createRoundTripLog('click', Date.now, {
      onUpdate: () => {
        throw new Error('debug log broke');
      },
    });
    const response = await log.record(URL_CHAT, {}, async () => new Response('{"done":true}\n'));
    expect(await response.text()).toBe('{"done":true}\n');
  });
});
