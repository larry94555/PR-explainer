// Follows an on/off setting from chrome.storage.sync in the content script,
// which cannot import src/settings.ts (see src/content.ts). Used for the Debug
// window setting (src/debug/debugSetting.ts), Show answers as they are
// written (src/streamSetting.ts), and as values, Explain ahead and Requests at
// once (src/explainAhead.ts).

import type { StorageChangedEvent } from './enabledState';
import type { SyncStorageLike } from './prefetch';

/**
 * Reads the setting stored under `key`, then hears about every save, so
 * changing it on the settings page takes effect without reloading the PR.
 * `parse` turns what is stored (undefined when nothing is, or the read
 * fails) into the value. It is `parse(undefined)` until the read answers,
 * and a save that arrives first wins. `onChange` hears the value once read,
 * and after each save.
 */
export function trackSyncValue<T>(
  key: string,
  storage: SyncStorageLike,
  events: StorageChangedEvent,
  parse: (stored: unknown) => T,
  onChange?: (value: T) => void,
): { current(): T } {
  let current = parse(undefined);
  let changed = false;
  events.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    changed = true;
    current = parse(changes[key]?.newValue);
    onChange?.(current);
  });
  storage.get([key]).then(
    (stored) => {
      if (changed) return;
      current = parse(stored[key]);
      onChange?.(current);
    },
    () => undefined,
  );
  return { current: () => current };
}

/**
 * Reads the flag stored under `key`, then hears about every save, so ticking
 * it on the settings page takes effect on the next popup without reloading
 * the PR. It is off until the read answers, stays off if the read fails, and
 * a save that arrives first wins. Anything but `true` means off. `onChange`
 * hears the value once read, and after each save.
 */
export function trackSyncFlag(
  key: string,
  storage: SyncStorageLike,
  events: StorageChangedEvent,
  onChange?: (on: boolean) => void,
): { current(): boolean } {
  return trackSyncValue(key, storage, events, (stored) => stored === true, onChange);
}
