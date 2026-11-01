// Whether click-to-explain is on. The toolbar button (src/toolbarToggle.ts,
// in the service worker) turns it on and off for every tab; this module is
// the content script's side: it reads the saved state and hears about
// changes.
//
// The state lives in chrome.storage.local, not .sync, so turning it off on
// one laptop does not turn it off on another.
//
// The content script cannot share code with the service worker (see
// src/content.ts), so toolbarToggle.ts keeps its own copy of the key and the
// default. toggle.test.ts checks that the two copies match.

/** The chrome.storage.local key that holds the on/off state. */
export const ENABLED_KEY = 'clickToExplain.enabled';

/** Click-to-explain is on until the user turns it off. */
export const DEFAULT_ENABLED = true;

// The parts of chrome.storage this code uses, so tests can pass fakes.
export interface LocalStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface StorageChangedEvent {
  addListener(listener: (changes: Record<string, StorageChange>, areaName: string) => void): void;
}

/** Turns a stored value into on/off. Anything but a boolean means the default. */
export function toEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_ENABLED;
}

/** Reads the saved state. */
export async function readEnabled(storage: LocalStorageLike): Promise<boolean> {
  const stored = await storage.get([ENABLED_KEY]);
  return toEnabled(stored[ENABLED_KEY]);
}

/**
 * Follows the on/off state for the content script: reads the saved state and
 * then reports every change. `current()` is null until the first answer
 * arrives, so a caller can ignore clicks until it knows the state (a saved
 * OFF must not let a popup through while the read is pending).
 *
 * The listener is added before the read starts, so no change is missed. A
 * change that arrives while the read is pending is newer than whatever the
 * read returns, so the read's answer is then ignored. If the read fails, the
 * state falls back to the default unless a change has already arrived.
 */
export function trackEnabled(
  storage: LocalStorageLike,
  events: StorageChangedEvent,
  onChange: (enabled: boolean, cause: 'read' | 'change') => void,
): { current(): boolean | null } {
  let current: boolean | null = null;
  let changed = false;
  watchEnabled(events, (enabled) => {
    changed = true;
    current = enabled;
    onChange(enabled, 'change');
  });
  const settle = (enabled: boolean) => {
    if (changed) return;
    current = enabled;
    onChange(enabled, 'read');
  };
  readEnabled(storage).then(settle, (error: unknown) => {
    console.warn('[PR Explainer] could not read the on/off state', error);
    settle(DEFAULT_ENABLED);
  });
  return { current: () => current };
}

/** Calls `onChange` with the new state each time it changes in chrome.storage.local. */
export function watchEnabled(
  events: StorageChangedEvent,
  onChange: (enabled: boolean) => void,
): void {
  events.addListener((changes, areaName) => {
    if (areaName !== 'local' || !Object.hasOwn(changes, ENABLED_KEY)) return;
    onChange(toEnabled(changes[ENABLED_KEY]?.newValue));
  });
}
