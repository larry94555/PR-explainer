// `npm run bench` (PR 8.2): times explanations on the local Ollama, so each
// latency change in Milestone 8 has a repeatable before and after.
//
//   npm run bench -- [model ...] [--runs N] [--url URL] [--no-save] [--ahead]
//
// Sends the real explain prompt for each sample in bench/ to each model named
// (or the first installed model when none is), N times each (3 by default),
// prints progress and a table, and adds the table, with this computer's
// details, to the end of docs/latency.md. Node cannot read the extension's
// settings, so the model comes from the command line and every other setting
// is the extension's default.
//
// With --ahead (PR 9.11) it runs the ahead mode instead: each added line of a
// saved GitHub diff page is explained ahead, as Explain ahead does, and then a
// click on each line is timed, to show how many clicks are answered within
// 2 seconds once Explain ahead has run.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runnerImport } from 'vite';
import type * as BenchExplain from './benchExplain.ts';
import {
  appendReport,
  formatAheadReport,
  formatMs,
  formatReport,
  parseBenchArgs,
  parseSample,
  type BenchReport,
  type BenchSample,
  type MachineInfo,
  type ModelResult,
} from './benchStats.ts';

const root = resolve(import.meta.dirname, '..');
const LATENCY_DOC = join(root, 'docs', 'latency.md');

function loadSamples(): BenchSample[] {
  const dir = join(root, 'bench');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseSample(JSON.parse(readFileSync(join(dir, name), 'utf8')), `bench/${name}`));
}

const run = promisify(execFile);

// Asks the system for graphics card names. Ollama's API does not name the
// GPU, so this is best effort: an empty list when the system cannot say.
async function gpuNames(): Promise<string[]> {
  const ask = async (file: string, args: string[]) =>
    (await run(file, args, { timeout: 10_000, windowsHide: true })).stdout;
  try {
    if (process.platform === 'win32') {
      const out = await ask('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_VideoController).Name',
      ]);
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (process.platform === 'darwin') {
      const out = await ask('system_profiler', ['SPDisplaysDataType']);
      return [...out.matchAll(/Chipset Model:\s*(.+)/g)].map((m) => m[1]!.trim());
    }
    const out = await ask('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

async function machineInfo(llmUrl: string): Promise<MachineInfo> {
  const cpus = os.cpus();
  const version = (await getJson(`${llmUrl}/api/version`)) as { version?: unknown } | undefined;
  return {
    // os.version() names the edition on Windows ("Windows 11 Pro"); elsewhere it is a kernel build.
    os:
      process.platform === 'win32'
        ? `${os.version()} (${os.release()})`
        : `${os.type()} ${os.release()}`,
    cpu: `${cpus[0]?.model.trim() ?? 'unknown CPU'} (${cpus.length} threads)`,
    ramBytes: os.totalmem(),
    gpus: await gpuNames(),
    ...(typeof version?.version === 'string' && { ollamaVersion: version.version }),
  };
}

// How much of `model` sits in GPU memory, from /api/ps (what `ollama ps`
// shows as "100% GPU"). Undefined when Ollama does not say.
async function gpuShare(llmUrl: string, model: string): Promise<number | undefined> {
  const body = (await getJson(`${llmUrl}/api/ps`)) as { models?: unknown } | undefined;
  if (!Array.isArray(body?.models)) return undefined;
  const loaded = body.models.find(
    (m: { name?: unknown; model?: unknown }) => m?.name === model || m?.model === model,
  ) as { size?: unknown; size_vram?: unknown } | undefined;
  const { size, size_vram } = loaded ?? {};
  return typeof size === 'number' && size > 0 && typeof size_vram === 'number'
    ? size_vram / size
    : undefined;
}

async function main(): Promise<number> {
  const args = parseBenchArgs(process.argv.slice(2));
  const { module: bench } = await runnerImport<typeof BenchExplain>(
    join(root, 'scripts', 'benchExplain.ts'),
    { configFile: false, root, logLevel: 'error' },
  );
  const settings = bench.DEFAULT_SETTINGS;
  const llmUrl = (args.llmUrl ?? settings.llmUrl).replace(/\/+$/, '');
  const platform =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'other';
  const explainer = bench.createBench(llmUrl, platform);

  // Asked first, so a server that is not running or a misspelled model stops
  // the run at once instead of failing every request.
  let installed: string[];
  try {
    installed = (await explainer.listModels()).map((m) => m.name);
  } catch (error) {
    throw new Error(`Could not reach Ollama at ${llmUrl}. Is it running?`, { cause: error });
  }
  if (!installed.length) throw new Error('Ollama has no models. Run "ollama pull <model>" first.');
  const missing = args.models.filter((m) => !installed.includes(m));
  if (missing.length) {
    throw new Error(`Not installed: ${missing.join(', ')}. Installed: ${installed.join(', ')}.`);
  }
  let models = args.models;
  if (!models.length) {
    models = [installed[0]!];
    console.log(`No model named, so using the first installed one: ${models[0]}`);
  }
  const samples = loadSamples();
  const startedAt = new Date();
  const machine = await machineInfo(llmUrl);

  if (args.ahead) {
    console.log(`Explain ahead with ${models.join(', ')} at ${llmUrl}, on ${bench.AHEAD_PAGE}`);
    const aheadResults = await bench.runAhead(explainer, models, samples[0]!);
    const section = formatAheadReport({
      startedAt,
      machine,
      llmUrl,
      temperature: settings.temperature,
      maxResponseTokens: settings.maxResponseTokens,
      results: aheadResults,
    });
    console.log(`\n${section}`);
    if (!aheadResults.some((r) => r.lines.some((l) => l.click.ok))) {
      console.error('Every click failed, so docs/latency.md was not changed.');
      return 1;
    }
    if (args.save) {
      const existing = existsSync(LATENCY_DOC) ? readFileSync(LATENCY_DOC, 'utf8') : null;
      writeFileSync(LATENCY_DOC, appendReport(existing, section));
      console.log('Added to docs/latency.md');
    }
    return 0;
  }
  console.log(
    `Benchmarking ${models.join(', ')} at ${llmUrl}: ${samples.length} samples × ${args.runs} runs`,
  );

  const results: ModelResult[] = [];
  for (const model of models) {
    const contextTokens = await explainer.contextTokens(model);
    const result: ModelResult = { model, rows: [], contextTokens };
    for (const sample of samples) {
      const row = { sample: sample.name, runs: [] as ModelResult['rows'][number]['runs'] };
      for (let i = 1; i <= args.runs; i++) {
        process.stdout.write(`  ${model} · ${sample.name} · run ${i}/${args.runs} … `);
        const outcome = await explainer.explain(sample, model);
        row.runs.push(outcome);
        console.log(
          outcome.ok
            ? `${formatMs(outcome.totalMs)} (first token ${formatMs(outcome.firstTokenMs)}, ` +
                `load ${formatMs(outcome.timings?.loadMs)}, ` +
                `${outcome.timings?.answerTokens ?? '?'} answer tokens)`
            : `failed: ${outcome.error}`,
        );
      }
      result.rows.push(row);
    }
    const share = await gpuShare(llmUrl, model);
    if (share !== undefined) result.gpuShare = share;
    results.push(result);
  }

  const report: BenchReport = {
    startedAt,
    machine,
    llmUrl,
    runsPerSample: args.runs,
    temperature: settings.temperature,
    maxResponseTokens: settings.maxResponseTokens,
    models: results,
  };
  const section = formatReport(report);
  console.log(`\n${section}`);

  const anyFinished = results.some((m) => m.rows.some((r) => r.runs.some((x) => x.ok)));
  if (!anyFinished) {
    console.error('Every run failed, so docs/latency.md was not changed.');
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
