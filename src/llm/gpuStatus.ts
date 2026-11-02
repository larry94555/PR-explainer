// Whether a loaded model runs on the GPU (PR 8.6), from what /api/ps says
// about it: its size in memory and how much of that is in video memory. The
// same model can be 5 to 10 times slower on the CPU, and a model only partly
// in video memory runs at close to CPU speed, so the settings page shows this
// next to the model and suggests a fix.
//
// The wording of `processor` matches the PROCESSOR column of `ollama ps`, so
// the user can compare the two.

import type { RunningModel } from './types';

export type GpuKind = 'gpu' | 'partial' | 'cpu' | 'unknown';

export interface GpuStatus {
  kind: GpuKind;
  /** As `ollama ps` writes it: "100% GPU", "100% CPU", "48%/52% CPU/GPU", or "Unknown". */
  processor: string;
  /** One sentence for the user. */
  message: string;
  /** What to do about it, with commands in backticks. Empty when nothing is needed. */
  fix: string;
}

/** How `model` (one entry from runningModels) is split between CPU and GPU. */
export function gpuStatus(model: RunningModel): GpuStatus {
  const { name, sizeBytes: size, vramBytes: vram } = model;
  if (size === undefined || vram === undefined || size <= 0 || vram > size) {
    return {
      kind: 'unknown',
      processor: 'Unknown',
      message: `Ollama did not say whether ${name} is on the GPU.`,
      fix: 'Run `ollama ps` and look at the PROCESSOR column.',
    };
  }
  if (vram === size) {
    return {
      kind: 'gpu',
      processor: '100% GPU',
      message: `${name} runs fully on the GPU.`,
      fix: '',
    };
  }
  if (vram === 0) {
    return {
      kind: 'cpu',
      processor: '100% CPU',
      message: `${name} runs on the CPU only, which is much slower than a GPU.`,
      fix:
        'If this computer has a GPU, update its driver and Ollama, then restart Ollama. ' +
        'Otherwise pick a smaller model, such as `qwen2.5-coder:1.5b` or `qwen2.5-coder:3b`.',
    };
  }
  const cpuPercent = Math.round(((size - vram) / size) * 100);
  return {
    kind: 'partial',
    processor: `${cpuPercent}%/${100 - cpuPercent}% CPU/GPU`,
    message:
      `Only part of ${name} fits in video memory (${cpuPercent}% is on the CPU), ` +
      'so it runs at close to CPU speed.',
    fix:
      'Close apps that use video memory (games, video editors, other models), lower ' +
      'Context size, or pull a smaller quantization (a tag ending in `q4_K_M`) or a ' +
      'smaller model, such as `qwen2.5-coder:3b`.',
  };
}
