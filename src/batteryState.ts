// Background work on battery (PR 11.3). Explain on hover, Explain ahead and
// the background queue keep the CPU busy, which drains a laptop battery and
// turns the fan on. With the setting on Pause (the default), they send
// nothing new while the laptop runs on battery, and a running request is let
// finish. Clicks and chat questions are never paused.
//
// The content script reads the charging state with navigator.getBattery(),
// which the service worker cannot use, and tells the service worker when it
// changes (src/backgroundPause.ts), so its queue and the toolbar icon follow.
// A browser that does not report a battery (a desktop, or one without the
// API) is never paused.
//
// The setting is saved with the others in chrome.storage.sync, which the
// content script reads directly because it cannot import src/settings.ts
// (see src/content.ts). batteryState.test.ts checks the key and the choices
// match.

import type { StorageChangedEvent } from './enabledState';
import type { SyncStorageLike } from './prefetch';
import { trackSyncValue } from './syncFlag';

/** The chrome.storage.sync key of the setting (storageKey('backgroundOnBattery')). */
export const BATTERY_SETTING_KEY = 'settings.backgroundOnBattery';

/** The setting's choices, as in src/settings.ts. */
export type BatteryMode = 'pause' | 'keep';

/** The setting as stored: `keep`, or `pause` (the default) for anything else. */
export function batteryModeOf(stored: unknown): BatteryMode {
  return stored === 'keep' ? 'keep' : 'pause';
}

/** Follows the setting (src/syncFlag.ts). Pause until it is read. */
export function trackBatterySetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
  onChange?: (mode: BatteryMode) => void,
): { current(): BatteryMode } {
  return trackSyncValue(BATTERY_SETTING_KEY, storage, events, batteryModeOf, onChange);
}

/** The part of the Battery Status API's BatteryManager this code reads. */
export interface BatteryManagerLike {
  /** True while plugged in (charging, or full and on mains power). */
  readonly charging: boolean;
  addEventListener(type: 'chargingchange', listener: () => void): void;
}

/** A navigator that may have getBattery (Chrome on a laptop does). */
export interface BatteryNavigatorLike {
  getBattery?(): Promise<BatteryManagerLike>;
}

/**
 * Follows whether the laptop runs on battery. False until the browser
 * answers, and always false when it reports no battery or the read fails.
 * `onChange` hears each change, including the first answer when it is true.
 */
export function trackBattery(
  nav: BatteryNavigatorLike,
  onChange?: (onBattery: boolean) => void,
): { onBattery(): boolean } {
  let onBattery = false;
  const set = (value: boolean) => {
    if (value === onBattery) return;
    onBattery = value;
    onChange?.(value);
  };
  if (typeof nav.getBattery === 'function') {
    nav.getBattery().then(
      (battery) => {
        set(!battery.charging);
        battery.addEventListener('chargingchange', () => set(!battery.charging));
      },
      () => {
        // No battery reported: nothing is paused.
      },
    );
  }
  return { onBattery: () => onBattery };
}

/**
 * Whether background work is paused: on battery with the setting on Pause.
 * `onChange` hears each change, from the battery or the setting.
 */
export function trackBackgroundPause(deps: {
  nav: BatteryNavigatorLike;
  storage: SyncStorageLike;
  events: StorageChangedEvent;
  onChange?(paused: boolean): void;
}): { paused(): boolean } {
  let last = false;
  const paused = () => battery.onBattery() && setting.current() === 'pause';
  const check = () => {
    const now = paused();
    if (now === last) return;
    last = now;
    deps.onChange?.(now);
  };
  const setting = trackBatterySetting(deps.storage, deps.events, check);
  const battery = trackBattery(deps.nav, check);
  return { paused };
}
