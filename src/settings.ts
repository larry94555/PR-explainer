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

import { CHROME_BUILT_IN_MODEL } from './llm/chromeAiClient';
import { isSameModel } from './llm/types';

export interface Settings {
  /**
   * Model server (PR 11.13): `ollama` (the default) or `chrome`, Chrome's
   * built-in model (src/llm/chromeAiClient.ts). With `chrome`, the service
   * worker reads the settings through serverSettings, so Model, Chat model
   * and Context size, which are Ollama's, do not apply.
   */
  modelServer: ModelServer;
  /** Base URL of the LLM server, for example the Ollama default. */
  llmUrl: string;
  /** Model name as the server lists it. Empty until the user picks one. */
  model: string;
  /**
   * The model chat questions use (PR 9.14). Empty means "Same as
   * explanations": chat uses `model`. Explanations, Explain on hover and
   * Explain ahead always use `model`. Read it through chatModelOf.
   */
  chatModel: string;
  /**
   * Chat opens in (PR 11.8): `page` (the default from PR 11.14) is the panel
   * that floats over the bottom right of the page (PR 5.2); `sidepanel` shows
   * the chat in Chrome's side panel, next to the page, where it covers no code
   * and stays open while GitHub moves between the PR's tabs. The content script
   * reads it straight from storage (src/chat/sidePanelChat.ts).
   */
  chatOpensIn: ChatPlace;
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
   * click often shows the answer at once. On by default since PR 11.2: it
   * sends one request at a time, never on battery (PR 11.3), during the
   * warm-up or in a hidden tab. A saved off is kept. The content script
   * reads it straight from storage (src/prefetch.ts).
   */
  explainOnHover: boolean;
  /**
   * Hover wait (PR 11.2): how long the pointer rests on a line, in
   * milliseconds, before Explain on hover starts. 300 by default: most people
   * rest on a line for less than a second before clicking it. The content
   * script reads it straight from storage (src/prefetch.ts).
   */
  hoverWaitMs: number;
  /**
   * Explain changed lines before they are clicked, once the Files changed tab
   * has been idle for a moment, so most clicks are answered from the cache:
   * `screen` explains the lines on screen (PR 9.10), `pr` works through the
   * whole PR, starting with the code on screen (PR 10.6). Off by default,
   * because it keeps the model busy and uses battery. A saved on or off from
   * before PR 10.6 reads as `screen` or `off`. The content script reads it
   * straight from storage (src/explainAhead.ts).
   */
  explainAhead: AheadMode;
  /**
   * How many explanations the service worker's queue runs at once (PR 10.6,
   * src/explain/prefetchQueue.ts), and how many Explain ahead sends at once.
   * 1 by default: on a CPU, Ollama's requests share the same cores, so more
   * only helps when Ollama is set to run several and usually on a GPU.
   */
  requestsAtOnce: number;
  /**
   * Background work on battery (PR 11.3): `pause` (the default) stops
   * Explain on hover, Explain ahead and the service worker's background
   * queue from sending anything new while the laptop runs on battery, and
   * lets a running request finish; `keep` never pauses. Clicks and chat
   * questions are never paused. The content script reads it straight from
   * storage (src/batteryState.ts).
   */
  backgroundOnBattery: BatteryMode;
  /**
   * Skip in background (PR 11.4): the files Explain ahead leaves alone, one
   * pattern per line, written as in .gitignore (`*.min.js`, `dist/`, `!keep.js`
   * to keep one). Files the repository's .gitattributes marks
   * linguist-generated or linguist-vendored are skipped too. Hover and clicks
   * still explain them. The content script reads it straight from storage
   * (src/skipFiles.ts, which keeps its own copy of the defaults).
   */
  skipInBackground: string;
  /**
   * Keep answers for, in days (PR 10.9): how long explanations are kept on
   * this computer after Chrome closes, in IndexedDB
   * (src/explain/persistentCache.ts). An answer not used for this long is
   * removed. 0 keeps them only until Chrome closes, as before.
   */
  keepAnswersDays: number;
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

/** The choices of Explain ahead (PR 10.6). */
export const AHEAD_MODES = ['off', 'screen', 'pr'] as const;
export type AheadMode = (typeof AHEAD_MODES)[number];

/** The choices of Background work on battery (PR 11.3). */
export const BATTERY_MODES = ['pause', 'keep'] as const;
export type BatteryMode = (typeof BATTERY_MODES)[number];

/** The choices of Model server (PR 11.13). */
export const MODEL_SERVERS = ['ollama', 'chrome'] as const;
export type ModelServer = (typeof MODEL_SERVERS)[number];

/** The choices of Chat opens in (PR 11.8). */
export const CHAT_PLACES = ['sidepanel', 'page'] as const;
export type ChatPlace = (typeof CHAT_PLACES)[number];

/** Skip in background's patterns until changed (PR 11.4), as in src/skipFiles.ts. */
export const DEFAULT_SKIP_PATTERNS: readonly string[] = Object.freeze([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  '*.pb.go',
  '*_pb2.py',
  'dist/',
  'vendor/',
  'node_modules/',
]);

/** The most text Skip in background may hold, well within chrome.storage.sync's 8 KB per item. */
export const SKIP_IN_BACKGROUND_MAX_LENGTH = 4000;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  modelServer: 'ollama',
  llmUrl: 'http://localhost:11434',
  model: '',
  chatModel: '',
  chatOpensIn: 'page',
  temperature: 0.2,
  maxResponseTokens: 120,
  contextTokens: 0,
  keepAliveMinutes: 30,
  explainOnHover: true,
  hoverWaitMs: 300,
  explainAhead: 'off',
  requestsAtOnce: 1,
  backgroundOnBattery: 'pause',
  skipInBackground: DEFAULT_SKIP_PATTERNS.join('\n'),
  keepAnswersDays: 7,
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

/** The model chat questions go to (PR 9.14): Chat model, or Model when it is "Same as explanations". */
export function chatModelOf(settings: Pick<Settings, 'model' | 'chatModel'>): string {
  return settings.chatModel || settings.model;
}

/**
 * `settings` with `model` set to the chat model (PR 9.14), so everything a
 * chat question does (the context size and thinking lookups, the loaded
 * window, error messages and the request itself) is about the model it is
 * sent to.
 */
export function chatSettings(settings: Settings): Settings {
  return { ...settings, model: chatModelOf(settings) };
}

/**
 * The settings as the service worker uses them (PR 11.13): with Model server
 * on Chrome built-in, explanations and chat both go to Chrome's built-in
 * model, and the context window is the built-in model's own (Context size
 * on automatic reads it from the model), so the prompt budget (PR 6.2) fits
 * it. Anything else is unchanged, so the cache key, ratings and the popup
 * name the built-in model.
 */
export function serverSettings(settings: Settings): Settings {
  if (settings.modelServer !== 'chrome') return settings;
  return { ...settings, model: CHROME_BUILT_IN_MODEL, chatModel: '', contextTokens: 0 };
}

/**
 * Whether chat uses a model of its own (PR 9.14): Chat model is set and names
 * another model than Model.
 */
export function hasOwnChatModel(settings: Pick<Settings, 'model' | 'chatModel'>): boolean {
  const { model, chatModel } = settings;
  return chatModel !== '' && !isSameModel(chatModel, model) && !isSameModel(model, chatModel);
}

export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
export const MAX_RESPONSE_TOKENS_RANGE = { min: 1, max: 32768 } as const;
/** Up to a day; 0 unloads the model after each answer. */
export const KEEP_ALIVE_MINUTES_RANGE = { min: 0, max: 1440 } as const;
/** A set context size must be in this range; 0 means automatic. */
export const CONTEXT_TOKENS_RANGE = { min: 512, max: 131072 } as const;
/** Hover wait (PR 11.2), in milliseconds. */
export const HOVER_WAIT_MS_RANGE = { min: 150, max: 2000 } as const;
/** Requests at once (PR 10.6). */
export const REQUESTS_AT_ONCE_RANGE = { min: 1, max: 4 } as const;
/** Keep answers for (PR 10.9): up to a year; 0 keeps them only until Chrome closes. */
export const KEEP_ANSWERS_DAYS_RANGE = { min: 0, max: 365 } as const;

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
    case 'modelServer':
      return (MODEL_SERVERS as readonly unknown[]).includes(value)
        ? null
        : 'Model server must be Ollama or Chrome built-in.';
    case 'llmUrl':
      return checkLlmUrl(value);
    case 'model':
      return typeof value === 'string' ? null : 'Model must be text.';
    case 'chatModel':
      return typeof value === 'string' ? null : 'Chat model must be text.';
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
    case 'chatOpensIn':
      return (CHAT_PLACES as readonly unknown[]).includes(value)
        ? null
        : 'Chat opens in must be Side panel or On the page.';
    case 'explainOnHover':
      return typeof value === 'boolean' ? null : 'Explain on hover must be on or off.';
    case 'hoverWaitMs':
      return checkNumber(value, HOVER_WAIT_MS_RANGE, true, 'Hover wait');
    case 'explainAhead':
      return (AHEAD_MODES as readonly unknown[]).includes(value)
        ? null
        : 'Explain ahead must be Off, Lines on screen or Whole PR.';
    case 'requestsAtOnce':
      return checkNumber(value, REQUESTS_AT_ONCE_RANGE, true, 'Requests at once');
    case 'backgroundOnBattery':
      return (BATTERY_MODES as readonly unknown[]).includes(value)
        ? null
        : 'Background work on battery must be Pause or Keep going.';
    case 'skipInBackground':
      if (typeof value !== 'string') return 'Skip in background must be text.';
      return value.length > SKIP_IN_BACKGROUND_MAX_LENGTH
        ? `Skip in background must be at most ${SKIP_IN_BACKGROUND_MAX_LENGTH} characters.`
        : null;
    case 'keepAnswersDays':
      return checkNumber(value, KEEP_ANSWERS_DAYS_RANGE, true, 'Keep answers for');
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
  if (typeof result.chatModel === 'string') result.chatModel = result.chatModel.trim();
  if (typeof result.skipInBackground === 'string') {
    // One pattern per line, without the spaces around it or blank lines.
    result.skipInBackground = result.skipInBackground
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n');
  }
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
    // Explain ahead was on or off before PR 10.6.
    if (field === 'explainAhead' && typeof raw[key] === 'boolean') {
      stored.explainAhead = raw[key] ? 'screen' : 'off';
      continue;
    }
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

/** Requests at once as stored, or the default when it is not a valid value. */
export function requestsAtOnceOf(stored: unknown): number {
  return checkField('requestsAtOnce', stored) === null
    ? (stored as number)
    : DEFAULT_SETTINGS.requestsAtOnce;
}

/** The part of chrome.storage.onChanged followRequestsAtOnce uses. */
export interface SettingsChangedLike {
  addListener(
    listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
  ): void;
}

/**
 * Follows one setting in the service worker without reading storage each
 * time it is needed: `parse(undefined)` until the read answers, then the
 * stored value and each save, parsed. A save that arrives first wins. (The
 * content script has its own, trackSyncValue in src/syncFlag.ts: the two
 * cannot share code, see src/content.ts.)
 */
export function followSetting<K extends SettingsField, T>(
  field: K,
  storage: StorageAreaLike,
  onChanged: SettingsChangedLike,
  parse: (stored: unknown) => T,
): { current(): T } {
  const key = storageKey(field);
  let current = parse(undefined);
  let changed = false;
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !Object.hasOwn(changes, key)) return;
    changed = true;
    current = parse(changes[key]?.newValue);
  });
  storage.get([key]).then(
    (stored) => {
      if (!changed) current = parse(stored[key]);
    },
    () => undefined,
  );
  return { current: () => current };
}

/**
 * Follows Requests at once in the service worker (PR 10.6), so the queue's
 * limit changes as soon as the setting is saved. The default until it is read.
 */
export function followRequestsAtOnce(
  storage: StorageAreaLike,
  onChanged: SettingsChangedLike,
): { current(): number } {
  return followSetting('requestsAtOnce', storage, onChanged, requestsAtOnceOf);
}

/** Chat opens in as stored: `sidepanel`, or `page` (the default, PR 11.14) for anything else. */
export function chatPlaceOf(stored: unknown): ChatPlace {
  return stored === 'sidepanel' ? 'sidepanel' : 'page';
}

/**
 * Follows Chat opens in in the service worker (PR 11.9), so a shortcut can
 * open the side panel before anything is awaited. On the page until it is read.
 */
export function followChatPlace(
  storage: StorageAreaLike,
  onChanged: SettingsChangedLike,
): { current(): ChatPlace } {
  return followSetting('chatOpensIn', storage, onChanged, chatPlaceOf);
}
