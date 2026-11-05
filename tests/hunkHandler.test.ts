import { createExplainCache, type SessionStorageLike } from '../src/explain/explainCache';
import { createExplainHandler, type ExplainDeps } from '../src/explain/explainHandler';
import {
  createHunkExplainHandler,
  linePayload,
  toHunkPayload,
  type HunkPayload,
} from '../src/explain/hunkHandler';
import { HUNK_SYSTEM_PROMPT, hunkAnswerTokens } from '../src/explain/hunkPrompt';
import type { ChatMessage, ChatOptions, ChatStreamEnd, LlmClient } from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:1.5b' };
const PR = 'o/r#7';

function memory(): SessionStorageLike {
  const items: Record<string, unknown> = {};
  return {
    get: async (keys) =>
      Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, items[k]])),
    set: async (values) => void Object.assign(items, values),
    remove: async (keys) => keys.forEach((k) => delete items[k]),
  };
}

const context = (n: number, code: string) =>
  [
    'File: src/a.ts (TypeScript)',
    `Clicked line: added, line ${n} of the new file`,
    code,
    '',
    'Surrounding diff (the clicked line starts with >):',
    '@@ -1,2 +1,4 @@',
    ` const a = 1;`,
    `>${code}`,
  ].join('\n');

const LINES = [
  { label: 'src/a.ts:added:2', line: 2, code: '+const b = 2;' },
  { label: 'src/a.ts:added:3', line: 3, code: '+const c = 3;' },
  { label: 'src/a.ts:added:4', line: 4, code: '+const d = 4;' },
].map((l) => ({ ...l, context: context(l.line, l.code) }));

const HUNK: HunkPayload = {
  text: [
    'File: src/a.ts (TypeScript)',
    '@@ -1,2 +1,4 @@',
    ' const a = 1;',
    ...LINES.map((l) => l.code),
  ].join('\n'),
  lines: LINES,
};

const part = (n: number) =>
  `### [${n}]\nWhat it does: Line ${n}.\nWhy it's needed: Why ${n}.\nConcerns: None found.\n`;

function setup(reply: string, { doneReason = 'stop', settings = SETTINGS } = {}) {
  const chatStream = vi.fn(async function* (): AsyncGenerator<string, ChatStreamEnd, undefined> {
    yield reply;
    return { model: settings.model, doneReason, timings: { answerTokens: 50 } };
  });
  const client = {
    loadedContextTokens: vi.fn(async () => undefined),
    chatStream,
  } as unknown as LlmClient;
  const deps: ExplainDeps = {
    getSettings: async () => settings,
    createClient: () => client,
    platform: 'windows',
    cache: createExplainCache(memory()),
  };
  return {
    chatStream,
    deps,
    explainHunk: createHunkExplainHandler(deps),
    explain: createExplainHandler(deps),
  };
}

const ask = (hunk: HunkPayload = HUNK) => ({
  context: hunk.text,
  pr: PR,
  cause: 'ahead' as const,
  hunk,
});

describe('explaining a whole hunk in one request', () => {
  it('asks once and saves each line under the key a click on it looks up', async () => {
    const env = setup([part(1), part(2), part(3)].join('\n'));
    const result = await env.explainHunk(ask());
    expect(result).toMatchObject({
      status: 'hunk',
      model: SETTINGS.model,
      lines: LINES.map((l) => ({ label: l.label, status: 'done' })),
    });
    expect(env.chatStream).toHaveBeenCalledTimes(1);
    const [messages, options] = env.chatStream.mock.calls[0] as unknown as [
      ChatMessage[],
      ChatOptions,
    ];
    expect(messages[0]!.content).toBe(HUNK_SYSTEM_PROMPT);
    expect(messages[1]!.content).toContain('[3] line 4: +const d = 4;');
    expect(options.maxResponseTokens).toBe(hunkAnswerTokens(3, SETTINGS.maxResponseTokens));
    // A click on each line is answered from the cache, without the model.
    for (const [i, line] of LINES.entries()) {
      const click = await env.explain({ context: line.context, pr: PR });
      expect(click).toMatchObject({
        status: 'done',
        // Background work wrote it, so the popup says "Prefetched" (PR 10.7).
        cached: expect.objectContaining({ prefetched: true, kind: 'hunk' }),
        explanation: { what: `Line ${i + 1}.`, why: `Why ${i + 1}.` },
      });
    }
    expect(env.chatStream).toHaveBeenCalledTimes(1);
  });

  it('reports the lines its answer left out as missing, and saves the rest', async () => {
    const env = setup([part(1), part(3)].join('\n'));
    const result = await env.explainHunk(ask());
    expect(result.status === 'hunk' && result.lines.map((l) => l.status)).toEqual([
      'done',
      'missing',
      'done',
    ]);
    const second = await env.explain({ context: LINES[1]!.context, pr: PR });
    expect(second.status === 'done' && second.cached).toBeUndefined();
  });

  it('keeps a line missing when its save fails, so it goes back to the queue (review on #64)', async () => {
    const env = setup([part(1), part(2), part(3)].join('\n'));
    const cache = env.deps.cache!;
    let saves = 0;
    const failing = {
      ...cache,
      set: vi.fn((...args: Parameters<typeof cache.set>) =>
        ++saves === 2
          ? Promise.reject(new Error('QUOTA_BYTES quota exceeded'))
          : cache.set(...args),
      ),
    };
    const result = await createHunkExplainHandler({ ...env.deps, cache: failing })(ask());
    expect(result.status === 'hunk' && result.lines.map((l) => l.status)).toEqual([
      'done',
      'missing',
      'done',
    ]);
  });

  it('leaves the lines already cached out of the request', async () => {
    const env = setup(part(1) + part(2));
    // A click on the first line fills its key, through the same cache.
    const clickEnv = setup('## What it does\nA.');
    await createExplainHandler({ ...clickEnv.deps, cache: env.deps.cache })({
      context: LINES[0]!.context,
      pr: PR,
    });
    const result = await env.explainHunk(ask());
    expect(result.status === 'hunk' && result.lines.map((l) => l.status)).toEqual([
      'cached',
      'done',
      'done',
    ]);
    const content = (env.chatStream.mock.calls[0] as unknown as [ChatMessage[]])[0][1]!.content;
    expect(content).toContain('[1] line 3: +const c = 3;');
    expect(content).not.toContain('line 2: +const b = 2;');
    // All cached: no request at all.
    const again = await env.explainHunk(ask());
    expect(again.status === 'hunk' && again.lines.every((l) => l.status === 'cached')).toBe(true);
    expect(env.chatStream).toHaveBeenCalledTimes(1);
  });

  it('drops the part the answer was cut off in', async () => {
    const env = setup(part(1) + part(2) + '### [3]\nWhat it does: Li', { doneReason: 'length' });
    const result = await env.explainHunk(ask());
    expect(result.status === 'hunk' && result.lines.map((l) => l.status)).toEqual([
      'done',
      'done',
      'missing',
    ]);
  });

  it('sends nothing when the hunk does not fit the context window, so each line goes alone', async () => {
    const env = setup('', {
      settings: { ...SETTINGS, contextTokens: 512, maxResponseTokens: 120 },
    });
    const result = await env.explainHunk(ask());
    expect(env.chatStream).not.toHaveBeenCalled();
    expect(result.status === 'hunk' && result.lines.every((l) => l.status === 'missing')).toBe(
      true,
    );
  });

  it('fails, so the queue tries again, when the model fails or there is nothing to save under', async () => {
    const env = setup('');
    env.chatStream.mockImplementation(async function* () {
      yield* [];
      throw new TypeError('Failed to fetch');
    });
    expect(await env.explainHunk(ask())).toMatchObject({
      status: 'failed',
      message: expect.any(String),
    });
    expect(await env.explainHunk({ ...ask(), pr: undefined })).toMatchObject({ status: 'failed' });
    expect(await createHunkExplainHandler({ ...env.deps, cache: undefined })(ask())).toMatchObject({
      status: 'failed',
    });
  });

  it('accepts only a well-formed hunk', async () => {
    expect(toHunkPayload(HUNK)).toEqual(HUNK);
    expect(toHunkPayload({ text: 'x', lines: [] })).toBeUndefined();
    expect(toHunkPayload({ text: 'x', lines: Array(16).fill(LINES[0]) })).toBeUndefined();
    expect(toHunkPayload({ text: 'x', lines: [{ ...LINES[0], line: 0 }] })).toBeUndefined();
    expect(toHunkPayload({ text: 'x', lines: [{ ...LINES[0], context: 3 }] })).toBeUndefined();
    expect(toHunkPayload(null)).toBeUndefined();
    await expect(setup('').explainHunk({ context: 'x', pr: PR })).rejects.toThrow();
  });

  it('builds the single-line request a missing line goes back as', () => {
    expect(
      linePayload(
        {
          ...ask(),
          prInfo: { title: 'T', description: '' },
          debugId: 'g',
          job: { label: 'h', order: 4 },
        },
        LINES[1]!,
      ),
    ).toEqual({
      context: LINES[1]!.context,
      pr: PR,
      prInfo: { title: 'T', description: '' },
      cause: 'ahead',
      debugId: 'g',
      job: { label: 'src/a.ts:added:3', order: 4 },
    });
  });
});
