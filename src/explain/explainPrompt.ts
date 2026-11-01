// The prompt that asks the model to explain one diff line. The content script
// sends the plain-text context block (formatContext in src/lineContext.ts) and
// this file wraps it in a system prompt and a user message.
//
// The service worker builds the prompt from text, not from a LineContext,
// because lineContext.ts is part of the content script and the content script
// must not share runtime imports with other entries (see src/content.ts).

import type { ChatMessage } from '../llm/types';

// The three headings the model is asked for. parseExplanation looks for the
// same names.
export const SECTION_HEADINGS = {
  what: 'What it does',
  why: "Why it's needed",
  concerns: 'Concerns',
} as const;

export const EXPLAIN_SYSTEM_PROMPT = [
  'You are a senior software engineer helping a colleague review a GitHub pull request.',
  'You are given one line from the diff, the lines around it, and the file it is in.',
  'Explain the clicked line in the context of the change.',
  '',
  'Answer in Markdown with exactly these three level-2 headings, in this order:',
  `## ${SECTION_HEADINGS.what}`,
  'One to three sentences on what the line does.',
  `## ${SECTION_HEADINGS.why}`,
  'One to three sentences on why the change needs it.',
  `## ${SECTION_HEADINGS.concerns}`,
  'A short bulleted list of real problems: bugs, edge cases, security, or performance.',
  'If there are none, write "None found."',
  '',
  'Be concise and specific. Do not repeat the code back. Do not add other headings.',
].join('\n');

// The messages for one explain request. `contextText` is formatContext output.
export function buildExplainPrompt(contextText: string): ChatMessage[] {
  return [
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'Explain the clicked line in this pull request diff.',
        '',
        '```',
        contextText.trimEnd(),
        '```',
      ].join('\n'),
    },
  ];
}
