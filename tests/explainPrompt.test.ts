import { buildExplainPrompt, SECTION_HEADINGS } from '../src/explain/explainPrompt';
import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';

describe('buildExplainPrompt', () => {
  it('builds a system prompt and a user message for a sample context', () => {
    expect(buildExplainPrompt(SAMPLE_CONTEXT)).toMatchSnapshot();
  });

  it('asks for the three headings the parser looks for', () => {
    const [system] = buildExplainPrompt(SAMPLE_CONTEXT);
    expect(system!.role).toBe('system');
    for (const heading of Object.values(SECTION_HEADINGS)) {
      expect(system!.content).toContain(`## ${heading}`);
    }
  });

  it('puts the whole context in a code block in the user message', () => {
    const [, user] = buildExplainPrompt(`${SAMPLE_CONTEXT}\n\n`);
    expect(user!.role).toBe('user');
    expect(user!.content).toContain(`\`\`\`\n${SAMPLE_CONTEXT}\n\`\`\``);
  });
});
