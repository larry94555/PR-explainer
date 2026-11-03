import { createLlmClient } from '../src/llm/createClient';
import { buildChatBody, OllamaClient, readTimings, type FetchLike } from '../src/llm/ollamaClient';
import { LlmError, type LlmErrorKind } from '../src/llm/types';

const BASE = 'http://localhost:11434';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A fetch that answers every call with `response` (a fresh copy each time, or
// a rejection) and records the calls.
function fakeFetch(response: () => Response | Promise<Response>) {
  return vi.fn<FetchLike>(async () => response());
}

async function expectLlmError(promise: Promise<unknown>, kind: LlmErrorKind, status?: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmError);
  expect((error as LlmError).kind).toBe(kind);
  expect((error as LlmError).details.status).toBe(status);
  return error as LlmError;
}

const TAGS = {
  models: [
    { name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', size: 4683087332, digest: 'abc' },
    { name: 'llama3.2:latest', model: 'llama3.2:latest' },
  ],
};

const CHAT_REPLY = {
  model: 'qwen2.5-coder:7b',
  created_at: '2026-11-01T00:00:00Z',
  message: { role: 'assistant', content: 'OK' },
  done: true,
  done_reason: 'stop',
};

describe('OllamaClient.listModels', () => {
  it('GETs /api/tags and returns each model name and size', async () => {
    const fetch = fakeFetch(() => jsonResponse(TAGS));
    const models = await new OllamaClient({ baseUrl: BASE, fetch }).listModels();

    expect(models).toEqual([
      { name: 'qwen2.5-coder:7b', sizeBytes: 4683087332 },
      { name: 'llama3.2:latest' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/tags`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns an empty list when no models are installed', async () => {
    const fetch = fakeFetch(() => jsonResponse({ models: [] }));
    expect(await new OllamaClient({ baseUrl: BASE, fetch }).listModels()).toEqual([]);
  });

  it('ignores a trailing slash in the base URL', async () => {
    const fetch = fakeFetch(() => jsonResponse(TAGS));
    await new OllamaClient({ baseUrl: `${BASE}/`, fetch }).listModels();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${BASE}/api/tags`);
  });

  it.each([
    ['no models list', { tags: [] }],
    ['a model without a name', { models: [{ size: 1 }] }],
    ['a null model', { models: [null] }],
  ])('raises bad-response for %s', async (_label, body) => {
    const fetch = fakeFetch(() => jsonResponse(body));
    await expectLlmError(new OllamaClient({ baseUrl: BASE, fetch }).listModels(), 'bad-response');
  });

  it('raises http, not model-not-found, for a 404 (the URL is not an Ollama server)', async () => {
    const fetch = fakeFetch(() => new Response('404 page not found', { status: 404 }));
    const error = await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).listModels(),
      'http',
      404,
    );
    expect(error.message).toContain('404 page not found');
  });
});

describe('OllamaClient.modelContext', () => {
  const SHOW = {
    parameters: 'num_ctx 8192\nstop "<|im_end|>"',
    model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 },
  };

  it('reads the trained size and the Modelfile num_ctx from /api/show', async () => {
    const fetch = fakeFetch(() => jsonResponse(SHOW));
    const client = new OllamaClient({ baseUrl: BASE, fetch });
    expect(await client.modelContext('qwen2.5-coder:7b')).toEqual({
      maxTokens: 32768,
      configuredTokens: 8192,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/show`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'qwen2.5-coder:7b' });
  });

  it('returns what it can when the server leaves things out', async () => {
    const fetch = fakeFetch(() => jsonResponse({ model_info: { 'llama.context_length': 'big' } }));
    expect(await new OllamaClient({ baseUrl: BASE, fetch }).modelContext('m')).toEqual({});
  });

  it('reports a missing model like chat does', async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: "model 'm' not found" }, 404));
    await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).modelContext('m'),
      'model-not-found',
      404,
    );
  });
});

describe('buildChatBody', () => {
  it('asks for a non-streaming reply with the model options Ollama expects', () => {
    expect(
      buildChatBody([{ role: 'user', content: 'Hi' }], {
        model: 'm',
        temperature: 0.2,
        maxResponseTokens: 512,
      }),
    ).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
      options: { temperature: 0.2, num_predict: 512 },
    });
  });

  it('leaves out options that were not given and extra message fields', () => {
    const message = { role: 'user' as const, content: 'Hi', extra: 'dropped' };
    expect(buildChatBody([message], { model: 'm' })).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
      options: {},
    });
  });

  it('sends the context size as num_ctx (PR 6.2)', () => {
    expect(buildChatBody([], { model: 'm', contextTokens: 2048 }).options).toEqual({
      num_ctx: 2048,
    });
  });

  it('sends keep_alive in minutes, and leaves it to Ollama when not given (PR 8.3)', () => {
    expect(buildChatBody([], { model: 'm', keepAliveMinutes: 30 })).toMatchObject({
      keep_alive: '30m',
    });
    expect(buildChatBody([], { model: 'm', keepAliveMinutes: 0 })).toMatchObject({
      keep_alive: '0m',
    });
    expect(buildChatBody([], { model: 'm' })).not.toHaveProperty('keep_alive');
  });

  it('keeps a temperature of 0', () => {
    expect(buildChatBody([], { model: 'm', temperature: 0 }).options).toEqual({ temperature: 0 });
  });
});

describe('OllamaClient.chat', () => {
  const messages = [
    { role: 'system' as const, content: 'Be brief.' },
    { role: 'user' as const, content: 'Reply with OK' },
  ];

  it('POSTs the chat body as JSON and returns the reply text and model', async () => {
    const fetch = fakeFetch(() => jsonResponse(CHAT_REPLY));
    const reply = await new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, {
      model: 'qwen2.5-coder:7b',
      temperature: 0.2,
    });

    expect(reply).toEqual({ content: 'OK', model: 'qwen2.5-coder:7b' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/chat`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual(
      buildChatBody(messages, { model: 'qwen2.5-coder:7b', temperature: 0.2 }),
    );
  });

  it('passes the abort signal to fetch', async () => {
    const fetch = fakeFetch(() => jsonResponse(CHAT_REPLY));
    const controller = new AbortController();
    await new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, {
      model: 'm',
      signal: controller.signal,
    });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('raises no-model without calling the server when no model is set', async () => {
    const fetch = fakeFetch(() => jsonResponse(CHAT_REPLY));
    await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: '  ' }),
      'no-model',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('raises connection when nothing is listening', async () => {
    const fetch = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'm' }),
      'connection',
    );
    expect(error.message).toContain(BASE);
    expect(error.details.cause).toBeInstanceOf(TypeError);
  });

  it('raises model-not-found for HTTP 404, with the server message', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({ error: "model 'nope' not found, try pulling it first" }, 404),
    );
    const error = await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'nope' }),
      'model-not-found',
      404,
    );
    expect(error.message).toContain('"nope"');
    expect(error.message).toContain('try pulling it first');
  });

  it('raises origin-blocked for HTTP 403 with an empty body', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 403, statusText: 'Forbidden' }));
    const error = await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'm' }),
      'origin-blocked',
      403,
    );
    expect(error.message).toContain('Forbidden');
  });

  it('raises http for other error statuses', async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: 'out of memory' }, 500));
    const error = await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'm' }),
      'http',
      500,
    );
    expect(error.message).toContain('out of memory');
  });

  it.each([
    ['text that is not JSON', () => new Response('<html>oops</html>', { status: 200 })],
    ['JSON that is not an object', () => jsonResponse('OK')],
    ['a reply without message.content', () => jsonResponse({ model: 'm', done: true })],
  ])('raises bad-response for %s', async (_label, response) => {
    const fetch = fakeFetch(response);
    await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'm' }),
      'bad-response',
    );
  });

  it('raises aborted when the request is cancelled', async () => {
    const fetch = fakeFetch(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'm' }),
      'aborted',
    );
  });

  it('uses the requested model name when the reply does not include one', async () => {
    const fetch = fakeFetch(() => jsonResponse({ message: { role: 'assistant', content: 'OK' } }));
    const reply = await new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, { model: 'm' });
    expect(reply.model).toBe('m');
  });
});

// Ollama's timing fields, in nanoseconds (PR 8.1).
const TIMINGS = {
  total_duration: 13_900_000_000,
  load_duration: 4_100_000_000,
  prompt_eval_count: 812,
  prompt_eval_duration: 1_300_000_000,
  eval_count: 240,
  eval_duration: 8_000_500_000,
};
const TIMINGS_MS = {
  totalMs: 13_900,
  loadMs: 4_100,
  promptTokens: 812,
  promptMs: 1_300,
  answerTokens: 240,
  answerMs: 8_000.5,
};

describe('readTimings', () => {
  it('converts the durations from nanoseconds to milliseconds and keeps the counts', () => {
    expect(readTimings({ ...CHAT_REPLY, ...TIMINGS })).toEqual(TIMINGS_MS);
  });

  it('leaves out fields that are missing or not usable numbers', () => {
    expect(
      readTimings({
        total_duration: 2_000_000,
        load_duration: '5',
        prompt_eval_count: -1,
        eval_count: Number.NaN,
        eval_duration: null,
      }),
    ).toEqual({ totalMs: 2 });
  });

  it('is undefined when there are no timings', () => {
    expect(readTimings(CHAT_REPLY)).toBeUndefined();
    expect(readTimings(null)).toBeUndefined();
  });
});

describe('OllamaClient timings (PR 8.1)', () => {
  const messages = [{ role: 'user' as const, content: 'Reply with OK' }];
  const options = { model: 'qwen2.5-coder:7b' };

  it('returns the timings with a chat() reply', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ...CHAT_REPLY, ...TIMINGS }));
    const reply = await new OllamaClient({ baseUrl: BASE, fetch }).chat(messages, options);
    expect(reply.timings).toEqual(TIMINGS_MS);
  });

  it("returns the done line's timings at the end of a stream", async () => {
    const lines = [
      { model: 'qwen2.5-coder:7b', message: { content: 'O' }, done: false },
      { model: 'qwen2.5-coder:7b', message: { content: 'K' }, done: false },
      {
        model: 'qwen2.5-coder:7b',
        message: { content: '' },
        done: true,
        done_reason: 'stop',
        ...TIMINGS,
      },
    ];
    const fetch = fakeFetch(
      () => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'),
    );
    const stream = new OllamaClient({ baseUrl: BASE, fetch }).chatStream(messages, options);
    const pieces: string[] = [];
    let next = await stream.next();
    while (!next.done) {
      pieces.push(next.value);
      next = await stream.next();
    }
    expect(pieces).toEqual(['O', 'K']);
    expect(next.value).toEqual({
      model: 'qwen2.5-coder:7b',
      doneReason: 'stop',
      timings: TIMINGS_MS,
    });
  });

  it('leaves timings out when the server sends none', async () => {
    const fetch = fakeFetch(
      () => new Response(JSON.stringify({ model: 'm', message: { content: 'OK' }, done: true })),
    );
    const stream = new OllamaClient({ baseUrl: BASE, fetch }).chatStream(messages, options);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(next.value).toEqual({ model: 'm' });
  });
});

describe('OllamaClient.loadedModels (PR 8.3)', () => {
  it('GETs /api/ps and returns the loaded model names', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({
        models: [
          { name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', size_vram: 5 },
          { model: 'llama3.2:latest' },
          { size: 1 },
        ],
      }),
    );
    const loaded = await new OllamaClient({ baseUrl: BASE, fetch }).loadedModels();
    expect(loaded).toEqual(['qwen2.5-coder:7b', 'llama3.2:latest']);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/ps`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('raises bad-response when the reply has no models list', async () => {
    const fetch = fakeFetch(() => jsonResponse({}));
    await expectLlmError(new OllamaClient({ baseUrl: BASE, fetch }).loadedModels(), 'bad-response');
  });
});

describe('OllamaClient.runningModels (PR 8.6)', () => {
  it('reads each loaded model with its size, video memory and window from /api/ps', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({
        models: [
          {
            name: 'qwen2.5-coder:7b',
            size: 6_000_000_000,
            size_vram: 3_000_000_000,
            context_length: 2048,
          },
          { model: 'llama3.2:latest', size: 2_000_000_000, size_vram: 0 },
          { name: 'old:1b', size: 'big', size_vram: -1 },
          { size: 1 },
        ],
      }),
    );
    const running = await new OllamaClient({ baseUrl: BASE, fetch }).runningModels();
    expect(running).toEqual([
      {
        name: 'qwen2.5-coder:7b',
        sizeBytes: 6_000_000_000,
        vramBytes: 3_000_000_000,
        contextTokens: 2048,
      },
      { name: 'llama3.2:latest', sizeBytes: 2_000_000_000, vramBytes: 0 },
      { name: 'old:1b' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/ps`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('raises bad-response when the reply has no models list', async () => {
    const fetch = fakeFetch(() => jsonResponse({ models: 'none' }));
    await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).runningModels(),
      'bad-response',
    );
  });
});

describe('OllamaClient.loadedContextTokens (PR 8.5)', () => {
  const ps = (models: unknown[]) => fakeFetch(() => jsonResponse({ models }));

  it("reads the loaded model's context_length from /api/ps", async () => {
    const fetch = ps([
      { name: 'llama3.2:3b', context_length: 8192 },
      { name: 'qwen2.5-coder:7b', context_length: 4096 },
    ]);
    const client = new OllamaClient({ baseUrl: BASE, fetch });
    await expect(client.loadedContextTokens('qwen2.5-coder:7b')).resolves.toBe(4096);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/ps`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('matches a name with no tag to its :latest', async () => {
    const fetch = ps([{ model: 'llama3.2:latest', context_length: 2048 }]);
    await expect(
      new OllamaClient({ baseUrl: BASE, fetch }).loadedContextTokens('llama3.2'),
    ).resolves.toBe(2048);
  });

  it('is undefined when the model is not loaded, or Ollama is too old to say', async () => {
    const notLoaded = ps([{ name: 'llama3.2:3b', context_length: 2048 }]);
    await expect(
      new OllamaClient({ baseUrl: BASE, fetch: notLoaded }).loadedContextTokens('qwen2.5-coder:7b'),
    ).resolves.toBeUndefined();
    const old = ps([{ name: 'qwen2.5-coder:7b' }, { name: 'x', context_length: 'big' }]);
    const client = new OllamaClient({ baseUrl: BASE, fetch: old });
    await expect(client.loadedContextTokens('qwen2.5-coder:7b')).resolves.toBeUndefined();
    await expect(client.loadedContextTokens('x')).resolves.toBeUndefined();
  });
});

describe('OllamaClient.loadModel (PR 8.3)', () => {
  it('sends the context window when given, so the first click does not reload (PR 8.5)', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ...CHAT_REPLY, done_reason: 'load' }));
    await new OllamaClient({ baseUrl: BASE, fetch }).loadModel('qwen2.5-coder:7b', {
      keepAliveMinutes: 30,
      contextTokens: 2048,
    });
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toMatchObject({
      keep_alive: '30m',
      options: { num_ctx: 2048 },
    });
  });

  it('POSTs /api/chat with no messages and the keep-alive, which only loads the model', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({
        ...CHAT_REPLY,
        message: { role: 'assistant', content: '' },
        done_reason: 'load',
      }),
    );
    await new OllamaClient({ baseUrl: BASE, fetch }).loadModel(' qwen2.5-coder:7b ', {
      keepAliveMinutes: 30,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/chat`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'qwen2.5-coder:7b',
      messages: [],
      stream: false,
      keep_alive: '30m',
    });
  });

  it('reports a missing model like chat does', async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: "model 'x' not found" }, 404));
    await expectLlmError(
      new OllamaClient({ baseUrl: BASE, fetch }).loadModel('x'),
      'model-not-found',
      404,
    );
  });

  it('raises no-model without calling the server when no model is set', async () => {
    const fetch = fakeFetch(() => jsonResponse(CHAT_REPLY));
    await expectLlmError(new OllamaClient({ baseUrl: BASE, fetch }).loadModel(' '), 'no-model');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createLlmClient', () => {
  it('builds an Ollama client for the saved URL', async () => {
    const fetch = fakeFetch(() => jsonResponse(TAGS));
    const client = createLlmClient({ llmUrl: 'http://127.0.0.1:8080' }, { fetch });
    expect(client).toBeInstanceOf(OllamaClient);
    await client.listModels();
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8080/api/tags');
  });
});
