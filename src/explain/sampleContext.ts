// A context block in the shape formatContext (src/lineContext.ts) produces,
// used by the dev hook debugLlm.explainSample() and by the tests.
export const SAMPLE_CONTEXT = [
  'File: src/settings.ts (TypeScript)',
  'Clicked line: added, line 42 of the new file',
  "+const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);",
  '',
  'Surrounding diff (the clicked line starts with >):',
  '@@ -38,6 +38,9 @@ export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;',
  ' export const MAX_RESPONSE_TOKENS_RANGE = { min: 1, max: 32768 } as const;',
  ' ',
  '+// Code never leaves the laptop, so only loopback addresses are accepted.',
  ">+const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);",
  '+',
  ' export interface SettingsIssue {',
  '   field: SettingsField;',
].join('\n');
