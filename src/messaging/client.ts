// Content script side: send a typed request to the service worker and wait
// for its answer.

import type {
  ExtensionRuntime,
  PayloadOf,
  RequestEnvelope,
  RequestType,
  ResponseEnvelope,
  ResultOf,
} from './protocol';

export const DEFAULT_TIMEOUT_MS = 10_000;

// Thrown for every failed request. `name` is the original error's name when
// the error came from a service worker handler.
export class RequestError extends Error {
  constructor(message: string, name = 'RequestError') {
    super(message);
    this.name = name;
  }
}

export interface SendOptions {
  timeoutMs?: number;
  runtime?: ExtensionRuntime;
}

function isResponse(value: unknown): value is ResponseEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

// Sends `type` with `payload` and resolves with the handler's result. Rejects
// with a RequestError if the handler throws, the type is unknown, the service
// worker cannot be reached, or no answer arrives within `timeoutMs`.
export async function sendRequest<T extends RequestType>(
  type: T,
  payload: PayloadOf<T>,
  { timeoutMs = DEFAULT_TIMEOUT_MS, runtime = chrome.runtime }: SendOptions = {},
): Promise<ResultOf<T>> {
  const request: RequestEnvelope<T> = { source: 'pr-explainer', type, payload };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RequestError(`"${type}" timed out after ${timeoutMs} ms`, 'TimeoutError')),
      timeoutMs,
    );
  });

  try {
    // sendMessage can also throw synchronously, for example with "Extension
    // context invalidated" after the extension is reloaded.
    const sent = Promise.resolve().then(() => runtime.sendMessage(request));
    const response = await Promise.race([sent, timeout]);
    if (!isResponse(response)) {
      throw new RequestError(`"${type}" got no answer from the service worker`);
    }
    if (!response.ok) throw new RequestError(response.error.message, response.error.name);
    return response.result as ResultOf<T>;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestError(`Could not reach the service worker: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
