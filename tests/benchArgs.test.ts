// PR 10.1: reading --parallel for `npm run bench`. The other options are
// checked in benchStats.test.ts.
import { MAX_AT_ONCE, parseBenchArgs, parseLevels } from '../scripts/benchStats.ts';

describe('--parallel', () => {
  it('is left out unless asked for', () => {
    expect(parseBenchArgs(['m'])).not.toHaveProperty('parallel');
  });

  it('reads a list of levels in either form, with models and other options', () => {
    expect(parseBenchArgs(['--parallel', '1,2,4', 'qwen2.5-coder:1.5b', '--runs', '1'])).toEqual({
      models: ['qwen2.5-coder:1.5b'],
      runs: 1,
      save: true,
      ahead: false,
      byHunk: false,
      parallel: [1, 2, 4],
    });
    expect(parseBenchArgs(['--parallel=2']).parallel).toEqual([2]);
  });

  it('sorts the levels and drops repeats', () => {
    expect(parseLevels('4, 1,2,1')).toEqual([1, 2, 4]);
  });

  it(`accepts whole numbers from 1 to ${MAX_AT_ONCE} only`, () => {
    expect(MAX_AT_ONCE).toBe(8);
    expect(parseLevels('1,8')).toEqual([1, 8]);
    for (const bad of ['0', '9', '1,9', '2.5', '-1', 'two', '1,,2', '1;2', ' ']) {
      expect(() => parseLevels(bad), bad).toThrow(
        '--parallel must be a list of whole numbers from 1 to 8, such as 1,2,4',
      );
    }
  });

  it('needs a value', () => {
    expect(() => parseBenchArgs(['--parallel'])).toThrow('--parallel needs a value');
    expect(() => parseBenchArgs(['--parallel='])).toThrow('--parallel needs a value');
  });

  it('cannot be used with --ahead', () => {
    expect(() => parseBenchArgs(['--ahead', '--parallel', '1,2'])).toThrow(
      'Use only one of --ahead, --parallel and --by-hunk',
    );
  });
});

describe('--by-hunk (PR 10.5)', () => {
  it('is off unless asked for, and reads with models', () => {
    expect(parseBenchArgs(['m']).byHunk).toBe(false);
    expect(parseBenchArgs(['--by-hunk', 'qwen2.5-coder:1.5b'])).toMatchObject({
      models: ['qwen2.5-coder:1.5b'],
      byHunk: true,
    });
  });

  it('cannot be used with --ahead or --parallel', () => {
    for (const other of [['--ahead'], ['--parallel', '1,2']]) {
      expect(() => parseBenchArgs(['--by-hunk', ...other])).toThrow(
        'Use only one of --ahead, --parallel and --by-hunk',
      );
    }
  });
});
