// @vitest-environment node
// PR 9.2: every request to the local LLM is recorded as a round trip, and the
// privacy rules from PR 7.4 still hold.
import { LlmError } from '../src/llm/types';
import { createLlmFetch, type FetchLike } from '../src/net/llmFetch';
import { createRoundTripLog } from '../src/net/roundTrips';

const LLM = 'http://localhost:11434';

describe('LLM round trips (PR 9.2)', () => {
  it('records every request it sends', async () => {
    const log = createRoundTripLog('click');
    const base = vi.fn<FetchLike>(async () => new Response('{"models":[]}'));
    const fetch = createLlmFetch(LLM, base, log);
    await (await fetch(`${LLM}/api/ps`)).text();
    await (await fetch(`${LLM}/api/chat`, { method: 'POST', body: '{"messages":[]}' })).text();
    expect(base).toHaveBeenCalledTimes(2);
    // Redirects are still refused (PR 7.4).
    expect(base.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
    expect(log.list().map((t) => [t.method, t.endpoint, t.status])).toEqual([
      ['GET', 'localhost:11434/api/ps', 'done'],
      ['POST', 'localhost:11434/api/chat', 'done'],
    ]);
  });

  it.each([
    ['another host', 'https://example.com/api/chat'],
    ['the right host with a user name', 'http://user@localhost:11434/api/chat'],
  ])('still refuses %s, and records the refused request without sending it', async (_, url) => {
    const log = createRoundTripLog('click');
    const base = vi.fn<FetchLike>(async () => new Response('{}'));
    const fetch = createLlmFetch(LLM, base, log);
    const error = await fetch(url, { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('blocked');
    expect(base).not.toHaveBeenCalled();
    expect(log.list()).toEqual([
      expect.objectContaining({ status: 'refused', bytesSent: 2, error: expect.any(String) }),
    ]);
  });

  it('records a refused request when the LLM URL itself is not on this computer', async () => {
    const log = createRoundTripLog('click');
    const fetch = createLlmFetch('https://llm.example.com', vi.fn(), log);
    await expect(fetch('https://llm.example.com/api/chat')).rejects.toThrow(/this computer/);
    expect(log.list()[0]).toMatchObject({ status: 'refused' });
  });

  it('works without a log, as before', async () => {
    const fetch = createLlmFetch(LLM, async () => new Response('ok'));
    expect(await (await fetch(`${LLM}/api/tags`)).text()).toBe('ok');
  });
});
