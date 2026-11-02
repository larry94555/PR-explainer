import { describe, expect, it } from 'vitest';
import { buildExplainPrompt } from '../src/explain/explainPrompt';
import {
  buildFittedExplainPrompt,
  CLICKED_MARK,
  estimateMessages,
  NOTES,
  parseContext,
  renderContext,
  SURROUNDING_HEADING,
} from '../src/explain/fitPrompt';
import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';
import { PromptTooLargeError } from '../src/explain/tokenBudget';
import type { DiffLine } from '../src/diffDom';
import * as lineContext from '../src/lineContext';

const line = (n: number, side: DiffLine['side'] = 'context'): DiffLine => ({
  filePath: 'src/big.ts',
  lineNumber: n,
  side,
  text: `const value${n} = compute(${n}); // line ${n}`,
});

// A clicked line with `before` and `after` lines around it.
function clicked(before: number, after: number): string {
  const lines = Array.from({ length: before + after + 1 }, (_, i) =>
    line(i + 1, i === before ? 'added' : 'context'),
  );
  return lineContext.formatContext(
    lineContext.contextFromHunk(
      { header: '@@ -1,40 +1,41 @@', lines, index: before },
      { before, after },
    ),
  );
}

function selected(before: number, count: number, after: number): string {
  const all = Array.from({ length: before + count + after }, (_, i) => line(i + 1));
  const block = all.slice(before, before + count);
  return lineContext.formatSelection({
    filePath: 'src/big.ts',
    language: 'TypeScript',
    lines: block,
    block: block.map(lineContext.withMarker),
    hunkHeader: '@@ -1,40 +1,40 @@',
    before: all.slice(0, before).map(lineContext.withMarker),
    after: all.slice(before + count).map(lineContext.withMarker),
  });
}

const user = (messages: { content: string }[]) => messages[1]!.content;

describe('context layout', () => {
  it('uses the same heading and mark as formatContext in the content script', () => {
    expect(SURROUNDING_HEADING).toBe(lineContext.SURROUNDING_HEADING);
    expect(CLICKED_MARK).toBe(lineContext.CLICKED_MARK);
  });

  it('splits a clicked line into the lines before, the line, and the lines after', () => {
    const layout = parseContext(clicked(2, 3))!;
    expect(layout.lead.at(-2)).toBe(SURROUNDING_HEADING);
    expect(layout.lead.at(-1)).toBe('@@ -1,40 +1,41 @@');
    expect(layout.before).toEqual([
      ' const value1 = compute(1); // line 1',
      ' const value2 = compute(2); // line 2',
    ]);
    expect(layout.middle).toEqual(['>+const value3 = compute(3); // line 3']);
    expect(layout.after).toHaveLength(3);
    expect(renderContext(layout, 2, 3)).toBe(clicked(2, 3));
  });

  it('finds the clicked line by its mark when the same text is also nearby', () => {
    const text = [
      'File: a.ts (TypeScript)',
      'Clicked line: added, line 3 of the new file',
      '+}',
      '',
      SURROUNDING_HEADING,
      ' }',
      ' }',
      '>+}',
      ' }',
    ].join('\n');
    const layout = parseContext(text)!;
    expect(layout.before).toEqual([' }', ' }']);
    expect(layout.after).toEqual([' }']);
  });

  it('splits a selection the same way', () => {
    const layout = parseContext(selected(3, 2, 4))!;
    expect(layout.before).toHaveLength(3);
    expect(layout.middle[1]).toBe('Selected lines:');
    expect(layout.middle.at(-1)).toBe('Lines after the selection:');
    expect(layout.after).toHaveLength(4);
    expect(renderContext(layout, 3, 4)).toBe(selected(3, 2, 4));
  });

  it('says how many lines were left out on each side', () => {
    const text = renderContext(parseContext(clicked(3, 3))!, 1, 0);
    expect(text).toContain(NOTES.before(2));
    expect(text).toContain(NOTES.after(3));
    expect(text).not.toContain('line 1\n');
    expect(text).toContain('// line 3\n>+const value4');
  });

  it('returns null for a context in neither shape', () => {
    expect(parseContext('just some code')).toBeNull();
    expect(parseContext(`File: a.ts\n${SURROUNDING_HEADING}\n line with no mark`)).toBeNull();
  });
});

describe('buildFittedExplainPrompt', () => {
  const pr = { title: 'Speed up compute', description: words(200) };

  it('sends exactly the uncut prompt when it fits', () => {
    const fitted = buildFittedExplainPrompt(SAMPLE_CONTEXT, pr, 100_000);
    expect(fitted.messages).toEqual(buildExplainPrompt(SAMPLE_CONTEXT, pr));
    expect(fitted.trimmed).toEqual([]);
    expect(fitted.tokens).toBe(estimateMessages(fitted.messages));
  });

  it('cuts the PR description first, at a word break', () => {
    const full = estimateMessages(buildExplainPrompt(clicked(10, 10), pr));
    const fitted = buildFittedExplainPrompt(clicked(10, 10), pr, full - 100);
    expect(fitted.trimmed).toEqual(['PR description']);
    expect(user(fitted.messages)).toContain(`${NOTES.descriptionCut}\n</description>`);
    expect(user(fitted.messages)).toMatch(/word\d+ … \(description trimmed\)/);
    expect(user(fitted.messages)).toContain(clicked(10, 10));
    expect(fitted.tokens).toBeLessThanOrEqual(full - 100);
  });

  it('then cuts the lines around the code, farthest first, keeping the clicked line', () => {
    const noDescription = estimateMessages(
      buildExplainPrompt(clicked(10, 10), { ...pr, description: '' }),
    );
    const fitted = buildFittedExplainPrompt(clicked(10, 10), pr, noDescription - 60);
    expect(fitted.trimmed).toEqual(['lines around the code', 'PR description']);
    const content = user(fitted.messages);
    expect(content).toContain(`Pull request description:\n${NOTES.description}`);
    expect(content).toContain('>+const value11 = compute(11);');
    // The nearest lines stay and the farthest go, on both sides.
    expect(content).toContain('// line 10\n>+');
    expect(content).toContain('// line 11\n const value12');
    expect(content).not.toContain('// line 1\n');
    expect(content).not.toContain('// line 21');
    expect(content).toMatch(/\(\d+ earlier lines left out\)/);
    expect(content).toMatch(/\(\d+ later lines left out\)/);
    expect(fitted.tokens).toBeLessThanOrEqual(noDescription - 60);
  });

  it('keeps the whole selected block and cuts the lines around it', () => {
    const text = selected(10, 5, 10);
    const full = estimateMessages(buildExplainPrompt(text));
    const fitted = buildFittedExplainPrompt(text, undefined, full - 80);
    const content = user(fitted.messages);
    for (let n = 11; n <= 15; n++) expect(content).toContain(`// line ${n}\n`);
    expect(content).not.toContain('// line 1\n');
    expect(fitted.trimmed).toEqual(['lines around the code']);
  });

  it('throws PromptTooLargeError when the instructions and the code alone do not fit', () => {
    expect(() => buildFittedExplainPrompt(clicked(10, 10), pr, 200)).toThrow(PromptTooLargeError);
  });

  it('sends an unrecognized context whole, and fails rather than cut it', () => {
    const odd = words(400);
    expect(buildFittedExplainPrompt(odd, undefined, 100_000).trimmed).toEqual([]);
    expect(() => buildFittedExplainPrompt(odd, undefined, 400)).toThrow(PromptTooLargeError);
  });
});

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}
