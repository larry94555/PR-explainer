import { describe, expect, it, vi } from 'vitest';
import { AVAILABILITY_TTL_MS, createBuiltInOffer } from '../src/llm/builtInOffer';
import type { BuiltInAvailability } from '../src/llm/chromeAiClient';
import type { ModelServer } from '../src/settings';

const DOWN = {
  status: 'failed',
  message: 'Ollama is not running.',
  fix: 'Start it.',
  kind: 'connection',
} as const;

function offer(state: BuiltInAvailability, server: ModelServer = 'ollama', now = () => 0) {
  const availability = vi.fn(async () => state);
  return {
    withOffer: createBuiltInOffer({ modelServer: async () => server, availability, now }),
    availability,
  };
}

describe("offering Chrome's built-in model when Ollama is down (PR 11.13)", () => {
  it('offers it when Ollama is not running and the built-in model is ready', async () => {
    const { withOffer } = offer('available');
    await expect(withOffer(DOWN)).resolves.toEqual({ ...DOWN, offer: 'chrome-built-in' });
  });

  it.each(['downloadable', 'downloading', 'unavailable', 'unsupported'] as const)(
    'does not offer it when it is %s',
    async (state) => {
      const { withOffer } = offer(state);
      await expect(withOffer(DOWN)).resolves.toEqual(DOWN);
    },
  );

  it('offers it only for Ollama not running, not other failures or answers', async () => {
    const { withOffer, availability } = offer('available');
    const missing = { ...DOWN, kind: 'model-not-found' as const };
    await expect(withOffer(missing)).resolves.toEqual(missing);
    const done = { status: 'done', kind: undefined };
    await expect(withOffer(done)).resolves.toEqual(done);
    expect(availability).not.toHaveBeenCalled();
  });

  it('does not offer it when the built-in model is already in use', async () => {
    const { withOffer, availability } = offer('available', 'chrome');
    await expect(withOffer(DOWN)).resolves.toEqual(DOWN);
    expect(availability).not.toHaveBeenCalled();
  });

  it('asks whether it is ready at most once every 30 seconds', async () => {
    let at = 0;
    const { withOffer, availability } = offer('available', 'ollama', () => at);
    await withOffer(DOWN);
    at = AVAILABILITY_TTL_MS - 1;
    await withOffer(DOWN);
    expect(availability).toHaveBeenCalledTimes(1);
    at = AVAILABILITY_TTL_MS;
    await withOffer(DOWN);
    expect(availability).toHaveBeenCalledTimes(2);
  });

  it('offers nothing when asking fails', async () => {
    const withOffer = createBuiltInOffer({
      modelServer: async () => 'ollama',
      availability: () => Promise.reject(new Error('no offscreen')),
    });
    await expect(withOffer(DOWN)).resolves.toEqual(DOWN);
  });
});
