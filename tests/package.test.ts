// PR 7.4: `npm run package` zips the built extension. These tests read the
// zip back with Node's own inflate, so they do not need a zip tool.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { assertClassicScript, listFiles, packageEntries, releaseName } from '../scripts/package.ts';
import { createZip } from '../scripts/zip.ts';

// Reads every file from a zip through its central directory, checking each
// local header and CRC on the way.
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    at += 46 + nameLength;
  }
  return files;
}

describe('createZip', () => {
  it('writes files that read back unchanged, compressed or stored', () => {
    const text = Buffer.from('console.log("hi");\n'.repeat(200));
    const tiny = Buffer.from('x');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const zip = createZip([
      { name: 'content.js', data: text },
      { name: 'a.txt', data: tiny },
      { name: 'icons/icon16.png', data: binary },
      { name: 'ünïcode.txt', data: tiny },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['content.js', 'a.txt', 'icons/icon16.png', 'ünïcode.txt']);
    expect(files.get('content.js')).toEqual(text);
    expect(files.get('a.txt')).toEqual(tiny);
    expect(files.get('icons/icon16.png')).toEqual(binary);
    expect(zip.length).toBeLessThan(text.length); // the repeated text was deflated
  });

  it('gives the same bytes for the same files', () => {
    const entries = [{ name: 'a.js', data: Buffer.from('let a = 1;') }];
    expect(createZip(entries).equals(createZip(entries))).toBe(true);
  });

  it('writes an empty zip', () => {
    expect(readZip(createZip([])).size).toBe(0);
  });

  it.each(['', '/abs.js', 'dir\\file.js'])('refuses the path "%s"', (name) => {
    expect(() => createZip([{ name, data: Buffer.from('') }])).toThrow(/Bad path/);
  });

  it('refuses the same path twice', () => {
    const entry = { name: 'a.js', data: Buffer.from('') };
    expect(() => createZip([entry, entry])).toThrow(/Duplicate/);
  });
});

describe('releaseName', () => {
  it('names the zip after the version', () => {
    expect(releaseName('0.1.0')).toBe('pr-explainer-0.1.0.zip');
  });

  it.each(['', '1.0-beta', '../x', '1.2.3.4.5'])('refuses the version "%s"', (version) => {
    expect(() => releaseName(version)).toThrow(/Bad version/);
  });
});

describe('assertClassicScript', () => {
  it('accepts a bundled classic script', () => {
    expect(() =>
      assertClassicScript('(function(){var a=1;console.log(a)})();', 'content.js'),
    ).not.toThrow();
  });

  it.each(['import{a as e}from"./chunks/shared-abc.js";e();', 'export const a = 1;'])(
    'refuses a module: %s',
    (code) => {
      expect(() => assertClassicScript(code, 'content.js')).toThrow(/content\.js is not a classic/);
    },
  );
});

describe('packageEntries', () => {
  let dir: string;
  const manifest = (version: string) =>
    JSON.stringify({ version, content_scripts: [{ js: ['content.js'] }] });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-explainer-package-'));
    mkdirSync(join(dir, 'dist', 'icons'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'manifest.json'), manifest('0.1.0'));
    writeFileSync(join(dir, 'dist', 'content.js'), 'console.log(1);');
    writeFileSync(join(dir, 'dist', 'content.js.map'), '{}');
    writeFileSync(join(dir, 'dist', 'icons', 'icon16.png'), 'png');
    writeFileSync(join(dir, 'PRIVACY.md'), '# Privacy');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists the build without source maps, and adds PRIVACY.md', () => {
    expect(listFiles(join(dir, 'dist'))).toEqual([
      'content.js',
      'icons/icon16.png',
      'manifest.json',
    ]);
    const entries = packageEntries(join(dir, 'dist'), join(dir, 'PRIVACY.md'), '0.1.0');
    expect(entries.map((e) => e.name)).toEqual([
      'content.js',
      'icons/icon16.png',
      'manifest.json',
      'PRIVACY.md',
    ]);
  });

  it('refuses a build whose manifest has another version', () => {
    expect(() => packageEntries(join(dir, 'dist'), join(dir, 'PRIVACY.md'), '0.2.0')).toThrow(
      /version 0\.1\.0 but package\.json is 0\.2\.0/,
    );
  });

  it('refuses a content script that imports a chunk', () => {
    writeFileSync(join(dir, 'dist', 'content.js'), 'import{a}from"./chunks/x.js";a();');
    expect(() => packageEntries(join(dir, 'dist'), join(dir, 'PRIVACY.md'), '0.1.0')).toThrow(
      /not a classic script/,
    );
  });

  it('refuses when there is no build', () => {
    expect(() => packageEntries(join(dir, 'nothing'), join(dir, 'PRIVACY.md'), '0.1.0')).toThrow(
      /Run npm run build/,
    );
  });
});
