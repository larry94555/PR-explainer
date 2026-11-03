// Follows the Debug window setting (PR 9.3) in the content script, so the
// popup shows its Debug button (PR 9.4) only while the setting is on.
//
// The content script cannot import src/settings.ts (see src/content.ts), so
// the key is copied here; debugWindow.test.ts checks it matches.

import type { StorageChangedEvent } from '../enabledState';
import type { SyncStorageLike } from '../prefetch';

/** The chrome.storage.sync key of the Debug window setting (storageKey('debugWindow')). */
export const DEBUG_SETTING_KEY = 'settings.debugWindow';

/**
 * Reads the setting, then hears about every save, so ticking it on the
 * settings page shows the button on the next popup without reloading the PR.
 * It is off until the read answers, and a save that arrives first wins.
 */
export function trackDebugSetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
): { current(): boolean } {
  let current = false;
  let changed = false;
  events.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, DEBUG_SETTING_KEY)) return;
    changed = true;
    current = changes[DEBUG_SETTING_KEY]?.newValue === true;
  });
  storage.get([DEBUG_SETTING_KEY]).then(
    (stored) => {
      if (!changed) current = stored[DEBUG_SETTING_KEY] === true;
    },
    () => undefined,
  );
  return { current: () => current };
}
