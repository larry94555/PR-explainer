// The latency goal (Milestone 9): an explanation in under 2 seconds, from the
// click to the whole answer. One constant, so the Speed test on the settings
// page (PR 8.6) and the reports from `npm run bench` and `npm run bench:history`
// (PRs 8.2 and 8.8) always aim at the same number (PR 9.9).
//
// No imports: scripts/latencyReport.ts loads this file straight into Node.

/** The goal: an explanation in under this many milliseconds. */
export const LATENCY_GOAL_MS = 2000;

/** The goal in seconds, for wording such as "under 2 seconds". */
export const LATENCY_GOAL_SECONDS = LATENCY_GOAL_MS / 1000;

/** A small, fast coding model to suggest when nothing installed meets the goal. */
export const SMALL_CODING_MODEL = 'qwen2.5-coder:1.5b';

/** An even smaller one, for a slow CPU. */
export const TINY_CODING_MODEL = 'qwen2.5-coder:0.5b';
