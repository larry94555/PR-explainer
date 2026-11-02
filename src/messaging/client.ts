// Content script side: send a typed request to the service worker and wait
// for its answer, or stream an explanation over a port.

import type { ExplainPayload, ExplainResult } from '../explain/explainHandler';
import type {
  ExplainPortMessage,
  ExplainPortName,
  ExplainPortRequest,
  ExtensionRuntime,
  PayloadOf,
  PortLike,
  PortRuntime,
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

// Must match EXPLAIN_PORT in streamPort.ts; the type makes TypeScript check it.
const EXPLAIN_PORT: ExplainPortName = 'pr-explainer:explain';

export interface ExplainStream {
  /**
   * The final result. Rejects with a RequestError when the service worker
   * cannot be reached or closes the port early, and with an "AbortError"
   * RequestError after stop().
   */
  result: Promise<ExplainResult>;
  /** Disconnects the port, which aborts the request in the service worker. */
  stop(): void;
}

function isPortMessage(value: unknown): value is ExplainPortMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/**
 * Asks the service worker to explain `payload.context` over a port (from the
 * cache when it has the answer, unless `payload.fresh`), calling `onChunk`
 * with each piece of the reply as it arrives. No chunk arrives after the
 * result settles or after stop().
 */
export function openExplainStream(
  payload: ExplainPayload,
  onChunk: (text: string) => void,
  runtime: PortRuntime = chrome.runtime,
): ExplainStream {
  let resolveResult!: (result: ExplainResult) => void;
  let rejectResult!: (error: RequestError) => void;
  const result = new Promise<ExplainResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let port: PortLike | undefined;
  let settled = false;
  const finish = (settle: () => void) => {
    if (settled) return;
    settled = true;
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
    settle();
  };
  const unreachable = (detail: string) =>
    finish(() => rejectResult(new RequestError(`Could not reach the service worker: ${detail}`)));

  try {
    // connect() throws "Extension context invalidated" after the extension
    // is reloaded.
    port = runtime.connect({ name: EXPLAIN_PORT });
    port.onMessage.addListener((message) => {
      if (settled || !isPortMessage(message)) return;
      if (message.type === 'chunk') onChunk(message.text);
      else if (message.type === 'result') finish(() => resolveResult(message.result));
      else if (message.type === 'error') {
        finish(() => rejectResult(new RequestError(message.error.message, message.error.name)));
      }
    });
    port.onDisconnect.addListener(() =>
      unreachable(runtime.lastError?.message ?? 'the connection closed before the answer arrived.'),
    );
    const request: ExplainPortRequest = { type: 'start', ...payload };
    port.postMessage(request);
  } catch (error) {
    unreachable(error instanceof Error ? error.message : String(error));
  }

  return {
    result,
    stop: () =>
      finish(() => {
        // Callers that stop usually no longer care about the result, so the
        // rejection is marked as handled. Callers that do listen still get it.
        result.catch(() => {});
        rejectResult(new RequestError('Stopped by the user', 'AbortError'));
      }),
  };
}
