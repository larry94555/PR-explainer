// Follows the Show answers as they are written setting (PR 9.6) in the
// content script. Off (the default), the popup and the chat wait for the
// whole answer and show it at once; on, they show it word by word as the
// model writes it, as before PR 9.6.
//
// The content script cannot import src/settings.ts (see src/content.ts), so
// the key is copied here; settings.test.ts checks it matches.

import type { StorageChangedEvent } from './enabledState';
import type { SyncStorageLike } from './prefetch';
import { trackSyncFlag } from './syncFlag';

/** The chrome.storage.sync key of the setting (storageKey('streamAnswers')). */
export const STREAM_SETTING_KEY = 'settings.streamAnswers';

/** Whether answers are shown as they are written. Read again for each popup and question. */
export function trackStreamSetting(
  storage: SyncStorageLike,
  events: StorageChangedEvent,
): { current(): boolean } {
  return trackSyncFlag(STREAM_SETTING_KEY, storage, events);
}
