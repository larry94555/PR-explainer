import { gpuStatus } from '../src/llm/gpuStatus';

const GB = 1_000_000_000;

describe('gpuStatus (PR 8.6)', () => {
  it('says a model fully in video memory runs on the GPU, with nothing to fix', () => {
    expect(gpuStatus({ name: 'qwen2.5-coder:3b', sizeBytes: 3 * GB, vramBytes: 3 * GB })).toEqual({
      kind: 'gpu',
      processor: '100% GPU',
      message: 'qwen2.5-coder:3b runs fully on the GPU.',
      fix: '',
    });
  });

  it('gives the CPU and GPU split like ollama ps, and suggests a fix', () => {
    const status = gpuStatus({ name: 'qwen2.5-coder:7b', sizeBytes: 6 * GB, vramBytes: 2.88 * GB });
    expect(status.kind).toBe('partial');
    expect(status.processor).toBe('52%/48% CPU/GPU');
    expect(status.message).toContain('52% is on the CPU');
    expect(status.fix).toContain('`q4_K_M`');
    expect(status.fix).toContain('Close apps that use video memory');
  });

  it('rounds a model that is almost all on the GPU without claiming 100% GPU', () => {
    const status = gpuStatus({ name: 'm', sizeBytes: 1000, vramBytes: 999 });
    expect(status.kind).toBe('partial');
    expect(status.processor).toBe('0%/100% CPU/GPU');
  });

  it('says a model with nothing in video memory runs on the CPU only', () => {
    const status = gpuStatus({ name: 'qwen2.5-coder:7b', sizeBytes: 6 * GB, vramBytes: 0 });
    expect(status.kind).toBe('cpu');
    expect(status.processor).toBe('100% CPU');
    expect(status.message).toBe(
      'qwen2.5-coder:7b runs on the CPU only, which is much slower than a GPU.',
    );
    expect(status.fix).toContain('`qwen2.5-coder:1.5b`');
  });

  it.each([
    ['no sizes at all', {}],
    ['no video memory figure', { sizeBytes: 5 }],
    ['no size', { vramBytes: 5 }],
    ['a size of zero', { sizeBytes: 0, vramBytes: 0 }],
    ['more video memory than size', { sizeBytes: 5, vramBytes: 6 }],
  ])('is unknown with %s', (_label, sizes) => {
    const status = gpuStatus({ name: 'm', ...sizes });
    expect(status.kind).toBe('unknown');
    expect(status.processor).toBe('Unknown');
    expect(status.fix).toContain('`ollama ps`');
  });
});
