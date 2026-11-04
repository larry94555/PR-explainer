import type { StorageChange } from '../src/enabledState';
import {
  BATTERY_SETTING_KEY,
  batteryModeOf,
  trackBackgroundPause,
  trackBattery,
  trackBatterySetting,
  type BatteryManagerLike,
} from '../src/batteryState';
import { BATTERY_MODES, DEFAULT_SETTINGS, storageKey } from '../src/settings';

/** A fake BatteryManager the test plugs in and unplugs. */
function fakeBattery(charging: boolean) {
  const listeners: (() => void)[] = [];
  const battery: BatteryManagerLike & { plug(on: boolean): void } = {
    charging,
    addEventListener: (_type, listener) => void listeners.push(listener),
    plug(on) {
      (battery as { charging: boolean }).charging = on;
      listeners.forEach((l) => l());
    },
  };
  return battery;
}

function fakeSync(initial: Record<string, unknown> = {}) {
  type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;
  const listeners: Listener[] = [];
  return {
    storage: { get: vi.fn(async () => ({ ...initial })) },
    events: { addListener: (listener: Listener) => void listeners.push(listener) },
    save: (value: unknown) =>
      listeners.forEach((l) => l({ [BATTERY_SETTING_KEY]: { newValue: value } }, 'sync')),
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('the battery (PR 11.3)', () => {
  it('is not on battery while charging', async () => {
    const onChange = vi.fn();
    const battery = trackBattery({ getBattery: async () => fakeBattery(true) }, onChange);
    await settle();
    expect(battery.onBattery()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is on battery when not charging, once the browser answers', async () => {
    const onChange = vi.fn();
    const battery = trackBattery({ getBattery: async () => fakeBattery(false) }, onChange);
    expect(battery.onBattery()).toBe(false);
    await settle();
    expect(battery.onBattery()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('follows the charging change events', async () => {
    const manager = fakeBattery(true);
    const onChange = vi.fn();
    const battery = trackBattery({ getBattery: async () => manager }, onChange);
    await settle();
    manager.plug(false);
    expect(battery.onBattery()).toBe(true);
    manager.plug(true);
    expect(battery.onBattery()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('is never on battery without the battery API, or when it fails', async () => {
    expect(trackBattery({}).onBattery()).toBe(false);
    const failing = trackBattery({ getBattery: () => Promise.reject(new Error('no battery')) });
    await settle();
    expect(failing.onBattery()).toBe(false);
  });
});

describe('the Background work on battery setting in the content script', () => {
  it('uses the same key, choices and default as the settings page', () => {
    expect(BATTERY_SETTING_KEY).toBe(storageKey('backgroundOnBattery'));
    expect(BATTERY_MODES).toEqual(['pause', 'keep']);
    expect(batteryModeOf(undefined)).toBe(DEFAULT_SETTINGS.backgroundOnBattery);
  });

  it('reads Keep going, and Pause for anything else', () => {
    expect(batteryModeOf('keep')).toBe('keep');
    expect(batteryModeOf('pause')).toBe('pause');
    expect(batteryModeOf(true)).toBe('pause');
  });

  it('follows what is saved', async () => {
    const sync = fakeSync({ [BATTERY_SETTING_KEY]: 'keep' });
    const setting = trackBatterySetting(sync.storage, sync.events);
    expect(setting.current()).toBe('pause');
    await settle();
    expect(setting.current()).toBe('keep');
    sync.save('pause');
    expect(setting.current()).toBe('pause');
  });
});

describe('whether background work is paused', () => {
  it('is paused on battery with Pause, and resumes when plugged in', async () => {
    const manager = fakeBattery(false);
    const sync = fakeSync();
    const onChange = vi.fn();
    const pause = trackBackgroundPause({
      nav: { getBattery: async () => manager },
      ...sync,
      onChange,
    });
    await settle();
    expect(pause.paused()).toBe(true);
    manager.plug(true);
    expect(pause.paused()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('is never paused with Keep going, and pauses when switched back to Pause', async () => {
    const sync = fakeSync({ [BATTERY_SETTING_KEY]: 'keep' });
    const onChange = vi.fn();
    const pause = trackBackgroundPause({
      nav: { getBattery: async () => fakeBattery(false) },
      ...sync,
      onChange,
    });
    await settle();
    expect(pause.paused()).toBe(false);
    sync.save('pause');
    expect(pause.paused()).toBe(true);
    sync.save('keep');
    expect(pause.paused()).toBe(false);
  });

  it('is never paused without a battery', async () => {
    const pause = trackBackgroundPause({ nav: {}, ...fakeSync() });
    await settle();
    expect(pause.paused()).toBe(false);
  });
});
