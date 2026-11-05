// The Make Ollama faster section on the settings page (PR 11.7): Ollama
// server settings that can make reading the prompt faster on a laptop. They
// are environment variables Ollama reads when it starts, set outside the
// extension, so the page gives the command for this computer and says that
// Ollama must be started again. How much they help depends on the model and
// the hardware, so the page measures before and after instead of promising.

import type { Platform } from './describeLlmError';

export interface SpeedTip {
  /** The environment variable. */
  name: string;
  value: string;
  /** What it does, in one or two sentences. */
  what: string;
}

export const SPEED_TIPS: readonly SpeedTip[] = [
  {
    name: 'OLLAMA_FLASH_ATTENTION',
    value: '1',
    what:
      'Turns on flash attention, a faster way for the model to read the prompt that also needs ' +
      'less memory. Most recent models support it; others ignore it.',
  },
  {
    name: 'OLLAMA_KV_CACHE_TYPE',
    value: 'q8_0',
    what:
      'Keeps the context cache in 8 bits instead of 16, about half the memory, so more of the ' +
      'model can fit on the GPU. Answers barely change. Works only with OLLAMA_FLASH_ATTENTION ' +
      'set to 1.',
  },
];

/** Where the commands are typed, for the line above them. */
export function commandShell(platform: Platform): string {
  switch (platform) {
    case 'windows':
      return 'In Command Prompt, run:';
    case 'mac':
      return 'In Terminal, run:';
    default:
      return 'Run `sudo systemctl edit ollama.service` and add these lines under `[Service]`:';
  }
}

/** The line that sets `tip` for Ollama on this computer. */
export function setCommand(tip: SpeedTip, platform: Platform): string {
  switch (platform) {
    case 'windows':
      return `setx ${tip.name} ${tip.value}`;
    case 'mac':
      return `launchctl setenv ${tip.name} ${tip.value}`;
    default:
      return `Environment="${tip.name}=${tip.value}"`;
  }
}

/** How to start Ollama again so it reads the new settings, with commands in backticks. */
export function restartStep(platform: Platform): string {
  switch (platform) {
    case 'windows':
      return (
        'Then quit Ollama from its icon in the system tray and start it again. A setting made ' +
        'with setx reaches only programs started after it, so an `ollama serve` in an open ' +
        'Command Prompt needs a new window.'
      );
    case 'mac':
      return 'Then quit Ollama from the menu bar and open it again.';
    default:
      return 'Then run `sudo systemctl restart ollama`.';
  }
}
