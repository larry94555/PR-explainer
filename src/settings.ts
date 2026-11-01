// User settings: where the local LLM runs, which model to use, and how it
// should answer. Stored in chrome.storage.sync under one key. Only values the
// user has saved are stored; defaults live here in code, so changing a default
// in a later version reaches users who never touched that setting.
//
// The service worker and (from PR 2.3) the options page read settings through
// this module. The content script never imports it.

export interface Settings {
  /** Base URL of the LLM server, for example the Ollama default. */
  llmUrl: string;
  /** Model name as the server lists it. Empty until the user picks one. */
  model: string;
  /** Sampling temperature, 0 to 2. Low values give steadier explanations. */
  temperature: number;
  /** Upper limit on the length of a reply, in tokens. */
  maxResponseTokens: number;
}

export type SettingsField = keyof Settings;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  llmUrl: 'http://localhost:11434',
  model: '',
  temperature: 0.2,
  maxResponseTokens: 1024,
});

export const SETTINGS_KEY = 'settings';

export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
export const MAX_RESPONSE_TOKENS_RANGE = { min: 1, max: 32768 } as const;

// Code never leaves the laptop, so only loopback addresses are accepted.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface SettingsIssue {
  field: SettingsField;
  message: string;
}

export class SettingsValidationError extends Error {
  override name = 'SettingsValidationError';
  constructor(readonly issues: SettingsIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
  }
}

// The part of chrome.storage.StorageArea this module uses. Passing it in lets
// the tests use an in-memory fake.
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function defaultStorage(): StorageAreaLike {
  return chrome.storage.sync;
}

// Returns an error message for one field, or null if the value is valid.
function checkField(field: SettingsField, value: unknown): string | null {
  switch (field) {
    case 'llmUrl':
      return checkLlmUrl(value);
    case 'model':
      return typeof value === 'string' ? null : 'Model must be text.';
    case 'temperature':
      return checkNumber(value, TEMPERATURE_RANGE, false, 'Temperature');
    case 'maxResponseTokens':
      return checkNumber(value, MAX_RESPONSE_TOKENS_RANGE, true, 'Max response length');
  }
}

function checkLlmUrl(value: unknown): string | null {
  if (typeof value !== 'string') return 'URL must be text.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a valid URL.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'URL must start with http:// or https://.';
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    return 'URL must point to this computer (localhost or 127.0.0.1).';
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return 'URL must be just the server address, for example http://localhost:11434.';
  }
  return null;
}

function checkNumber(
  value: unknown,
  range: { min: number; max: number },
  integer: boolean,
  label: string,
): string | null {
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    value >= range.min &&
    value <= range.max;
  if (ok) return null;
  const kind = integer ? 'a whole number' : 'a number';
  return `${label} must be ${kind} from ${range.min} to ${range.max}.`;
}

const FIELDS = Object.keys(DEFAULT_SETTINGS) as SettingsField[];

/** Lists every problem with `settings`. An empty list means it is valid. */
export function validateSettings(settings: Settings): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  for (const field of FIELDS) {
    const message = checkField(field, settings[field]);
    if (message) issues.push({ field, message });
  }
  return issues;
}

// Small clean-ups applied before validating a save.
function normalize(settings: Settings): Settings {
  const result = { ...settings };
  if (typeof result.model === 'string') result.model = result.model.trim();
  if (typeof result.llmUrl === 'string') {
    // Accept "http://localhost:11434/" and store it without the slash.
    result.llmUrl = result.llmUrl.trim().replace(/\/+$/, '');
  }
  return result;
}

// Reads what is stored, keeping only known fields with valid values.
async function readStored(storage: StorageAreaLike): Promise<Partial<Settings>> {
  const raw = (await storage.get(SETTINGS_KEY))[SETTINGS_KEY];
  const stored: Partial<Settings> = {};
  if (typeof raw !== 'object' || raw === null) return stored;
  for (const field of FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = (raw as Record<string, unknown>)[field];
    // A bad stored value (hand-edited, or from an older version) falls back to
    // the default instead of breaking the extension.
    if (checkField(field, value) === null) Object.assign(stored, { [field]: value });
  }
  return stored;
}

/** Returns the current settings: saved values over the defaults. */
export async function getSettings(storage: StorageAreaLike = defaultStorage()): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await readStored(storage)) };
}

/**
 * Merges `update` into the saved settings, validates the result, and stores
 * it. Fields left out (or set to undefined) keep their current value. Throws
 * SettingsValidationError, and stores nothing, if any value is invalid.
 * Returns the full settings after the save.
 */
export async function saveSettings(
  update: Partial<Settings>,
  storage: StorageAreaLike = defaultStorage(),
): Promise<Settings> {
  const stored = await readStored(storage);
  const changes: Partial<Settings> = {};
  for (const field of FIELDS) {
    if (Object.hasOwn(update, field) && update[field] !== undefined) {
      Object.assign(changes, { [field]: update[field] });
    }
  }
  const merged = normalize({ ...DEFAULT_SETTINGS, ...stored, ...changes } as Settings);
  const issues = validateSettings(merged);
  if (issues.length > 0) throw new SettingsValidationError(issues);

  const toStore: Partial<Settings> = {};
  for (const field of FIELDS) {
    if (Object.hasOwn(stored, field) || Object.hasOwn(changes, field)) {
      Object.assign(toStore, { [field]: merged[field] });
    }
  }
  await storage.set({ [SETTINGS_KEY]: toStore });
  return merged;
}
