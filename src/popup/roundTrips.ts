// The words for a click's round trips in the popup's Details (PR 9.2): the
// count line ("4 round trips: GitHub 1, Ollama 3") and the line for each one.
// Only the click's own round trips count; ones made when the page opened,
// by Explain on hover, or by the warm-up are listed with their cause.

import { formatMs } from '../trace/clickTrace';
import type { RoundTrip, RoundTripCause } from '../trace/types';

const TARGET: Record<RoundTrip['target'], string> = { github: 'GitHub', ollama: 'Ollama' };

const CAUSE: Record<Exclude<RoundTripCause, 'click'>, string> = {
  page: 'when the page opened',
  hover: 'by Explain on hover',
  warmup: 'by the warm-up',
  chat: 'by the chat',
};

/** "512 B", then "1.2 kB" and "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** "4 round trips: GitHub 1, Ollama 3 · 2 more by the warm-up, not counted". */
export function roundTripSummary(trips: readonly RoundTrip[]): string {
  const own = trips.filter((t) => t.cause === 'click');
  const counts = (['github', 'ollama'] as const)
    .map((target) => [target, own.filter((t) => t.target === target).length] as const)
    .filter(([, n]) => n > 0)
    .map(([target, n]) => `${TARGET[target]} ${n}`);
  const parts = [
    own.length === 0
      ? 'No round trips for this click'
      : `${own.length} round trip${own.length === 1 ? '' : 's'}: ${counts.join(', ')}`,
  ];
  for (const cause of ['page', 'hover', 'warmup'] as const) {
    const n = trips.filter((t) => t.cause === cause).length;
    if (n > 0) parts.push(`${n} more ${CAUSE[cause]}, not counted`);
  }
  return parts.join(' · ');
}

/** "Ollama /api/chat · explanation · 12.3 s", with its status when not done. */
export function roundTripLine(trip: RoundTrip): string {
  const path = trip.target === 'ollama' ? trip.endpoint.replace(/^[^/]*/, '') : trip.endpoint;
  const status = trip.status === 'done' ? '' : ` · ${trip.status}`;
  const cause = trip.cause === 'click' ? '' : ` · ${CAUSE[trip.cause]}`;
  return `${TARGET[trip.target]} ${path} · ${trip.purpose} · ${formatMs(trip.durationMs)}${status}${cause}`;
}

/** "POST localhost:11434/api/chat · started at 0.3 s · sent 3.2 kB · received 8.1 kB · HTTP 200". */
export function roundTripFacts(trip: RoundTrip): string {
  const start =
    trip.startMs < 0
      ? `started ${formatMs(-trip.startMs)} before the click`
      : `started at ${formatMs(trip.startMs)}`;
  return [
    `${trip.method} ${trip.endpoint}`,
    start,
    `sent ${formatBytes(trip.bytesSent)}`,
    `received ${formatBytes(trip.bytesReceived)}`,
    ...(trip.httpStatus !== undefined ? [`HTTP ${trip.httpStatus}`] : []),
    ...(trip.error ? [`error: ${trip.error}`] : []),
  ].join(' · ');
}
