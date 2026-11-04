import { createBackgroundPause, PAUSED_TABS_KEY } from '../src/backgroundPause';
import { createPauseReporter, holdsPause, type PauseInputs } from '../src/batteryState';
import { createPrefetchQueue } from '../src/explain/prefetchQueue';

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

describe('tabs letting go of the pause (review on #71)', () => {
  /**
   * Two PR tabs on battery, each with a reporter sending to one service
   * worker pause that pauses one queue, as in src/content.ts and
   * src/background.ts.
   */
  function twoTabs() {
    const runs: string[] = [];
    const queue = createPrefetchQueue<string, string>({
      run: (payload) => {
        runs.push(payload);
        return new Promise(() => {});
      },
    });
    const pause = createBackgroundPause({
      storage: fakeSession(),
      onChange: (paused) => queue.setPaused(paused),
    });
    const tab = (id: number) => {
      const state: PauseInputs = { paused: true, onDiffs: true, enabled: true, backgroundOn: true };
      const reporter = createPauseReporter({
        wanted: () => holdsPause(state),
        send: async (paused) => pause.report(id, paused),
      });
      reporter.update();
      return { state, update: () => reporter.update() };
    };
    return { queue, pause, runs, tab };
  }

  it('resumes the queue when a paused tab moves from a PR to an issue in the same tab', () => {
    const env = twoTabs();
    const moving = env.tab(1);
    // Tab 2 holds nothing (say, its setting read Keep going).
    const other = env.tab(2);
    other.state.paused = false;
    other.update();
    void env.queue
      .add({ id: 'a', label: 'a', priority: 'on-screen', payload: 'a' })
      .catch(() => {});
    expect(env.runs).toEqual([]);

    // GitHub moves tab 1 to an issue without a reload.
    moving.state.onDiffs = false;
    moving.update();
    expect(env.pause.paused()).toBe(false);
    expect(env.runs).toEqual(['a']);

    // Back on the PR's diffs, still on battery: it holds the pause again.
    moving.state.onDiffs = true;
    moving.update();
    expect(env.pause.paused()).toBe(true);
  });

  it('lets go when click-to-explain is turned off, and holds it again when turned on', () => {
    const env = twoTabs();
    const tab = env.tab(1);
    expect(env.pause.paused()).toBe(true);
    tab.state.enabled = false;
    tab.update();
    expect(env.pause.paused()).toBe(false);
    void env.queue
      .add({ id: 'a', label: 'a', priority: 'on-screen', payload: 'a' })
      .catch(() => {});
    expect(env.runs).toEqual(['a']);
    tab.state.enabled = true;
    tab.update();
    expect(env.pause.paused()).toBe(true);
  });

  it('keeps the pause while another tab still holds it', () => {
    const env = twoTabs();
    const off = env.tab(1);
    env.tab(2);
    off.state.enabled = false;
    off.update();
    expect(env.pause.paused()).toBe(true);
  });
});
