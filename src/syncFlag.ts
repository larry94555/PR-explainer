// Follows an on/off setting from chrome.storage.sync in the content script,
// which cannot import src/settings.ts (see src/content.ts). Used for the Debug
// window setting (src/debug/debugSetting.ts) and Show answers as they are
// written (src/streamSetting.ts).

import type { StorageChangedEvent } from './enabledState';
import type { SyncStorageLike } from './prefetch';

/**
 * Reads the flag stored under `key`, then hears about every save, so ticking
 * it on the settings page takes effect on the next popup without reloading
 * the PR. It is off until the read answers, stays off if the read fails, and
 * a save that arrives first wins. Anything but `true` means off.
 */
export function trackSyncFlag(
  key: string,
  storage: SyncStorageLike,
  events: StorageChangedEvent,
): { current(): boolean } {
  let current = false;
  let changed = false;
  events.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    changed = true;
    current = changes[key]?.newValue === true;
  });
  storage.get([key]).then(
    (stored) => {
      if (!changed) current = stored[key] === true;
    },
    () => undefined,
  );
  return { current: () => current };
}
