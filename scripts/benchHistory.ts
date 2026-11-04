// `npm run bench:history` (PR 8.8): the latency report for Milestone 8.
//
//   npm run bench:history -- [model ...] [--runs N] [--url URL]
//
// Runs `npm run bench` with the code as it was after each PR that changed
// the explain request (HISTORY_STEPS), each in a temporary git worktree that
// shares this checkout's node_modules, and unloads the models before each
// step so every step starts the same way. Then it measures the floor with
// the current code: the shortest sample, answers of at most 150 tokens, the
// model already loaded. It adds one section to docs/latency.md: a row per
// step, the conclusion (goal met, or the floor and what limits it), and each
// step's full tables.
//
// Since PR 9.11 it also times fresh answers with the current code and the
// model warm (every sample, no cache), and runs the ahead mode of
// `npm run bench -- --ahead`, so the conclusion can say whether 2 seconds is
// met for fresh answers, only for clicks after Explain ahead, or for neither.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { runnerImport } from 'vite';
import type * as BenchExplain from './benchExplain.ts';
import { appendReport, formatDate, formatMs, parseBenchArgs, parseSample } from './benchStats.ts';
import {
  FLOOR_ANSWER_TOKENS,
  formatHistoryReport,
  HISTORY_STEPS,
  lastSection,
  type FloorResult,
  type FreshResult,
  type HistoryReport,
} from './latencyReport.ts';

const root = resolve(import.meta.dirname, '..');
const LATENCY_DOC = join(root, 'docs', 'latency.md');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Runs `npm run bench` at `ref` in a temporary worktree and returns the section it wrote. */
function benchAt(ref: string, benchArgs: string[]): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'pr-explainer-bench-'));
  rmSync(dir, { recursive: true, force: true });
  git('worktree', 'add', '--detach', dir, ref);
  try {
    // A junction needs no admin rights on Windows; the type is ignored elsewhere.
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
    const doc = join(dir, 'docs', 'latency.md');
    const before = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
    const run = spawnSync(process.execPath, ['scripts/bench.ts', ...benchArgs], {
      cwd: dir,
      stdio: 'inherit',
    });
    const after = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
    if (run.status !== 0 || after === before) throw new Error('npm run bench failed at this step');
    const section = lastSection(after);
    if (!section) throw new Error('npm run bench wrote no section');
    return section;
  } finally {
    rmSync(join(dir, 'node_modules'), { force: true });
    git('worktree', 'remove', '--force', dir);
  }
}

async function main(): Promise<number> {
  const args = parseBenchArgs(process.argv.slice(2));
  const { module: bench } = await runnerImport<typeof BenchExplain>(
    join(root, 'scripts', 'benchExplain.ts'),
    { configFile: false, root, logLevel: 'error' },
  );
  const llmUrl = (args.llmUrl ?? bench.DEFAULT_SETTINGS.llmUrl).replace(/\/+$/, '');
  const platform =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'other';
  const now = bench.createBench(llmUrl, platform);

  let installed: string[];
  try {
    installed = (await now.listModels()).map((m) => m.name);
  } catch (error) {
    throw new Error(`Could not reach Ollama at ${llmUrl}. Is it running?`, { cause: error });
  }
  if (!installed.length) throw new Error('Ollama has no models. Run "ollama pull <model>" first.');
  const missing = args.models.filter((m) => !installed.includes(m));
  if (missing.length) {
    throw new Error(`Not installed: ${missing.join(', ')}. Installed: ${installed.join(', ')}.`);
  }
  const models = args.models.length ? args.models : [installed[0]!];
  const benchArgs = [...models, '--runs', String(args.runs), '--url', llmUrl];
  const report: HistoryReport = {
    startedAt: formatDate(new Date()),
    runsPerSample: args.runs,
    steps: [],
    floors: [],
    fresh: [],
    ahead: [],
  };

  for (const step of HISTORY_STEPS) {
    console.log(`\n=== ${step.label} (${step.ref}) ===`);
    for (const model of models) await now.unload(model).catch(() => undefined);
    try {
      report.steps.push({ step, section: benchAt(step.ref, benchArgs) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${step.label}: ${message}`);
      report.steps.push({ step, error: message });
    }
  }

  // The floor: the sample with the least to read, a short answer, the model warm.
  const dir = join(root, 'bench');
  const samples = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => parseSample(JSON.parse(readFileSync(join(dir, n), 'utf8')), `bench/${n}`));
  const shortest = samples.reduce((a, b) =>
    JSON.stringify(b).length < JSON.stringify(a).length ? b : a,
  );
  const floorBench = bench.createBench(llmUrl, platform, {
    maxResponseTokens: FLOOR_ANSWER_TOKENS,
  });
  console.log(`\n=== Floor (${shortest.name}, up to ${FLOOR_ANSWER_TOKENS} answer tokens) ===`);
  for (const model of models) {
    await floorBench.explain(shortest, model); // loads the model; not counted
    const floor: FloorResult = { model, sample: shortest.name, runs: [] };
    for (let i = 1; i <= args.runs; i++) {
      const run = await floorBench.explain(shortest, model);
      floor.runs.push(run);
      console.log(
        `  ${model} · run ${i}/${args.runs} … ${run.ok ? formatMs(run.totalMs) : run.error}`,
      );
    }
    const ranOn = await floorBench.ranOn(model);
    if (ranOn) floor.ranOn = ranOn;
    report.floors.push(floor);
  }

  // Fresh answers: every sample with the current code, the model loaded first.
  const samplesInOrder = [...samples].sort((a, b) => a.name.localeCompare(b.name));
  console.log('\n=== Fresh answers, model warm (HEAD) ===');
  for (const model of models) {
    await now.explain(shortest, model); // loads the model; not counted
    const fresh: FreshResult = { model, runs: [] };
    for (const sample of samplesInOrder) {
      for (let i = 1; i <= args.runs; i++) {
        const run = await now.explain(sample, model);
        fresh.runs.push(run);
        console.log(
          `  ${model} · ${sample.name} · run ${i}/${args.runs} … ${run.ok ? formatMs(run.totalMs) : run.error}`,
        );
      }
    }
    const ranOn = await now.ranOn(model);
    if (ranOn) fresh.ranOn = ranOn;
    report.fresh!.push(fresh);
  }

  // Clicks after Explain ahead, as `npm run bench -- --ahead` measures them.
  console.log(`\n=== Clicks after Explain ahead (${bench.AHEAD_PAGE}) ===`);
  report.ahead = await bench.runAhead(now, models, shortest);

  const section = formatHistoryReport(report);
  console.log(`\n${section}`);
  if (report.steps.every((s) => s.error)) {
    console.error('Every step failed, so docs/latency.md was not changed.');
    return 1;
  }
  if (args.save) {
    const existing = existsSync(LATENCY_DOC) ? readFileSync(LATENCY_DOC, 'utf8') : null;
    writeFileSync(LATENCY_DOC, appendReport(existing, section));
    console.log('Added to docs/latency.md');
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
