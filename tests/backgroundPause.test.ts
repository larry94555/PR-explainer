import { createBackgroundPause, PAUSED_TABS_KEY } from '../src/backgroundPause';

function fakeSession(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
  };
}

describe('background work paused, in the service worker (PR 11.3)', () => {
  it('is paused while any tab says so, and resumes when none does', async () => {
    const storage = fakeSession();
    const onChange = vi.fn();
    const pause = createBackgroundPause({ storage, onChange });
    await pause.ready;
    pause.report(1, true);
    pause.report(2, true);
    expect(pause.paused()).toBe(true);
    pause.report(1, false);
    expect(pause.paused()).toBe(true);
    pause.report(2, false);
    expect(pause.paused()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('forgets a closed tab', async () => {
    const storage = fakeSession();
    const onChange = vi.fn();
    const pause = createBackgroundPause({ storage, onChange });
    pause.report(1, true);
    pause.forgetTab(1);
    expect(pause.paused()).toBe(false);
    expect(storage.data[PAUSED_TABS_KEY]).toEqual([]);
  });

  it('keeps the pause when Chrome restarts the worker', async () => {
    const storage = fakeSession();
    const first = createBackgroundPause({ storage, onChange: () => {} });
    first.report(4, true);
    expect(storage.data[PAUSED_TABS_KEY]).toEqual([4]);

    const onChange = vi.fn();
    const restarted = createBackgroundPause({ storage, onChange });
    await restarted.ready;
    expect(restarted.paused()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('lets a tab that spoke since the restart win over what was kept', async () => {
    const storage = fakeSession({ [PAUSED_TABS_KEY]: [4] });
    const onChange = vi.fn();
    const pause = createBackgroundPause({ storage, onChange });
    pause.report(4, false);
    await pause.ready;
    expect(pause.paused()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
