// `npm run package` (PR 7.4): after `npm run build`, checks the built
// extension in dist/ and zips it, with PRIVACY.md, into
// release/pr-explainer-<version>.zip, ready to share and to load with
// "Load unpacked" once unzipped.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { createZip, type ZipEntry } from './zip.ts';

const root = resolve(import.meta.dirname, '..');

/** The zip's file name for a version, such as "pr-explainer-0.1.0.zip". */
export function releaseName(version: string): string {
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`Bad version "${version}"`);
  return `pr-explainer-${version}.zip`;
}

/**
 * Throws unless `code` runs as a classic script. Chrome loads content scripts
 * that way, so an `import` (Vite moving shared code into a chunk) would stop
 * the extension on every page. The code is only compiled, not run.
 */
export function assertClassicScript(code: string, file: string): void {
  try {
    new Script(code, { filename: file });
  } catch (error) {
    throw new Error(
      `${file} is not a classic script (${(error as Error).message}). ` +
        'Has the content script started sharing a module with the service worker?',
      { cause: error },
    );
  }
}

/** Every file under `dir`, as paths relative to it with "/", leaving out source maps. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .filter((path) => !path.endsWith('.map'))
    .sort();
}

/** Checks the build in `distDir` and returns what goes in the zip. */
export function packageEntries(distDir: string, privacyFile: string, version: string): ZipEntry[] {
  const manifestPath = join(distDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`No build in ${distDir}. Run npm run build.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string;
    content_scripts: { js: string[] }[];
  };
  if (manifest.version !== version) {
    throw new Error(`manifest.json is version ${manifest.version} but package.json is ${version}.`);
  }
  for (const file of manifest.content_scripts.flatMap((cs) => cs.js)) {
    assertClassicScript(readFileSync(join(distDir, file), 'utf8'), file);
  }
  return [
    ...listFiles(distDir).map((name) => ({ name, data: readFileSync(join(distDir, name)) })),
    { name: 'PRIVACY.md', data: readFileSync(privacyFile) },
  ];
}

function main(): void {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const entries = packageEntries(join(root, 'dist'), join(root, 'PRIVACY.md'), version);
  const outDir = join(root, 'release');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, releaseName(version));
  const zip = createZip(entries);
  writeFileSync(out, zip);
  console.log(
    `Packaged ${entries.length} files into ${relative(root, out)} (${(zip.length / 1024).toFixed(1)} kB).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`npm run package failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
