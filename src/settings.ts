// User settings: where the local LLM runs, which model to use, and how it
// should answer. Stored in chrome.storage.sync with one key per field (see
// storageKey). Only values the user has saved are stored; defaults live here
// in code, so changing a default in a later version reaches users who never
// touched that setting.
//
// One key per field is what makes concurrent saves safe: a save writes only
// the keys it changes, and chrome.storage applies each set atomically, so two
// contexts (say the options page and the service worker) saving different
// fields at the same time cannot overwrite each other. Validation is per
// field, so a save never needs to rewrite fields it did not change.
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
  /**
   * Upper limit on the length of an explanation, in tokens. Kept low (PR 8.4,
   * and 120 from PR 9.8, for one-sentence answers) because writing the answer
   * is usually the slowest part. Chat answers may
   * use up to CHAT_MIN_RESPONSE_TOKENS even when this is lower.
   */
  maxResponseTokens: number;
  /**
   * The model's context window, in tokens: prompt and reply together (PR 6.2).
   * 0 means automatic: the model's own size from the server, up to
   * AUTO_CONTEXT_TOKENS (see src/llm/contextSize.ts).
   */
  contextTokens: number;
  /**
   * How long Ollama keeps the model in memory after each request, in minutes
   * (PR 8.3), so clicks while reviewing do not wait for it to load again.
   * 0 unloads it as soon as each answer is done, and turns off warm-up.
   */
  keepAliveMinutes: number;
  /**
   * Start explaining a diff line once the pointer rests on it (PR 8.7), so a
   * click often shows the answer at once. Off by default, because it uses the
   * model for lines the user may never click. The content script reads it
   * straight from storage (src/prefetch.ts).
   */
  explainOnHover: boolean;
  /**
   * Explain the added and changed lines on screen once the Files changed tab
   * has been idle for a moment (PR 9.10), one at a time, so most clicks are
   * answered from the cache. Off by default, because it keeps the model busy
   * and uses battery. The content script reads it straight from storage
   * (src/explainAhead.ts).
   */
  explainAhead: boolean;
  /**
   * Let a reasoning model, such as deepseek-r1, think before it answers
   * (PR 9.5). Off by default: explaining a few lines does not need it, and
   * thinking was most of the wait. Other models are not affected.
   */
  letModelThink: boolean;
  /**
   * Show explanations and chat answers word by word as the model writes them
   * (PR 9.6). Off by default: the popup and chat wait for the whole answer
   * and show it at once, which reads better than sections that jump around as
   * they fill in. The content script reads it straight from storage
   * (src/streamSetting.ts).
   */
  streamAnswers: boolean;
  /** Debug option: show the prompt sent to the model under each explanation. */
  showPrompt: boolean;
  /**
   * Debug option (PR 9.3): keep every round trip to GitHub and the LLM, with
   * its prompt, reply and time, in a log the debug window reads
   * (src/debug/debugLog.ts). Off by default; turning it off clears the log.
   */
  debugWindow: boolean;
}

export type SettingsField = keyof Settings;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  llmUrl: 'http://localhost:11434',
  model: '',
  temperature: 0.2,
  maxResponseTokens: 120,
  contextTokens: 0,
  keepAliveMinutes: 30,
  explainOnHover: false,
  explainAhead: false,
  letModelThink: false,
  streamAnswers: false,
  showPrompt: false,
  debugWindow: false,
});

/** The chrome.storage key that holds one field, for example "settings.model". */
export function storageKey(field: SettingsField): string {
  return `settings.${field}`;
}

/**
 * Chat answers may be this long even when maxResponseTokens is lower (PR 8.4):
 * a question can need a longer answer than an explanation, and the user is
 * already reading while it streams.
 */
export const CHAT_MIN_RESPONSE_TOKENS = 1024;

/** The answer limit for a chat question: the setting, but at least CHAT_MIN_RESPONSE_TOKENS. */
export function chatResponseTokens(settings: Pick<Settings, 'maxResponseTokens'>): number {
  return Math.max(settings.maxResponseTokens, CHAT_MIN_RESPONSE_TOKENS);
}

export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
export const MAX_RESPONSE_TOKENS_RANGE = { min: 1, max: 32768 } as const;
/** Up to a day; 0 unloads the model after each answer. */
export const KEEP_ALIVE_MINUTES_RANGE = { min: 0, max: 1440 } as const;
/** A set context size must be in this range; 0 means automatic. */
export const CONTEXT_TOKENS_RANGE = { min: 512, max: 131072 } as const;

// Code never leaves the laptop, so only loopback addresses are accepted.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL's hostname (as `new URL(...).hostname` gives it) is this computer. */
export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname);
}

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
  get(keys: string[]): Promise<Record<string, unknown>>;
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
    case 'contextTokens':
      if (value === 0) return null;
      return (
        checkNumber(value, CONTEXT_TOKENS_RANGE, true, 'Context size')?.replace(
          /\.$/,
          ', or 0 for automatic.',
        ) ?? null
      );
    case 'keepAliveMinutes':
      return checkNumber(value, KEEP_ALIVE_MINUTES_RANGE, true, 'Keep model loaded');
    case 'explainOnHover':
      return typeof value === 'boolean' ? null : 'Explain on hover must be on or off.';
    case 'explainAhead':
      return typeof value === 'boolean' ? null : 'Explain ahead must be on or off.';
    case 'letModelThink':
      return typeof value === 'boolean' ? null : 'Let the model think must be on or off.';
    case 'streamAnswers':
      return typeof value === 'boolean'
        ? null
        : 'Show answers as they are written must be on or off.';
    case 'showPrompt':
      return typeof value === 'boolean' ? null : 'Show prompt must be on or off.';
    case 'debugWindow':
      return typeof value === 'boolean' ? null : 'Debug window must be on or off.';
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
  if (!isLocalHostname(url.hostname)) {
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

// Reads what is stored, keeping only fields with valid values.
async function readStored(storage: StorageAreaLike): Promise<Partial<Settings>> {
  const raw = await storage.get(FIELDS.map(storageKey));
  const stored: Partial<Settings> = {};
  for (const field of FIELDS) {
    const key = storageKey(field);
    if (!Object.hasOwn(raw, key)) continue;
    // A bad stored value (hand-edited, or from an older version) falls back to
    // the default instead of breaking the extension.
    if (checkField(field, raw[key]) === null) Object.assign(stored, { [field]: raw[key] });
  }
  return stored;
}

/** Returns the current settings: saved values over the defaults. */
export async function getSettings(storage: StorageAreaLike = defaultStorage()): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await readStored(storage)) };
}

/**
 * Validates the fields in `update` and stores them, leaving every other field
 * as it is. Fields left out (or set to undefined) keep their current value.
 * Throws SettingsValidationError, and stores nothing, if any value is invalid.
 * Returns the full settings after the save.
 */
export async function saveSettings(
  update: Partial<Settings>,
  storage: StorageAreaLike = defaultStorage(),
): Promise<Settings> {
  const changes: Partial<Settings> = {};
  for (const field of FIELDS) {
    if (Object.hasOwn(update, field) && update[field] !== undefined) {
      Object.assign(changes, { [field]: update[field] });
    }
  }
  // Fill the rest with defaults only so validateSettings sees a full object;
  // those fields are not checked against storage and are not written.
  const normalized = normalize({ ...DEFAULT_SETTINGS, ...changes } as Settings);
  const issues = validateSettings(normalized).filter((i) => Object.hasOwn(changes, i.field));
  if (issues.length > 0) throw new SettingsValidationError(issues);

  const items: Record<string, unknown> = {};
  for (const field of Object.keys(changes) as SettingsField[]) {
    items[storageKey(field)] = normalized[field];
  }
  if (Object.keys(items).length > 0) await storage.set(items);
  return getSettings(storage);
}
