import { PROMPT_MARGIN_TOKENS } from '../src/llm/contextSize';
import {
  chooseNumCtx,
  MIN_NUM_CTX,
  neededTokens,
  roundUpWindow,
  startingNumCtx,
} from '../src/llm/numCtx';

describe('num_ctx for an explanation (PR 8.5)', () => {
  it('counts the prompt, the answer, and the margin the prompt budget leaves', () => {
    expect(neededTokens(1000, 300)).toBe(1300 + PROMPT_MARGIN_TOKENS);
  });

  it('rounds up to a power of two, never below the smallest window', () => {
    expect(roundUpWindow(1)).toBe(MIN_NUM_CTX);
    expect(roundUpWindow(2048)).toBe(2048);
    expect(roundUpWindow(2049)).toBe(4096);
    expect(roundUpWindow(5000)).toBe(8192);
  });

  it('is just what the prompt and answer need, rounded up', () => {
    expect(chooseNumCtx({ promptTokens: 900, answerTokens: 300, limit: 8192 })).toBe(2048);
    expect(chooseNumCtx({ promptTokens: 1800, answerTokens: 300, limit: 8192 })).toBe(4096);
  });

  it("stays within the limit, which is the model's own size at most", () => {
    expect(chooseNumCtx({ promptTokens: 3500, answerTokens: 300, limit: 4096 })).toBe(4096);
    expect(chooseNumCtx({ promptTokens: 2900, answerTokens: 300, limit: 3500 })).toBe(3500);
    // A model with a small window gets that window.
    expect(chooseNumCtx({ promptTokens: 100, answerTokens: 300, limit: 1024 })).toBe(1024);
  });

  it('keeps the window the model is loaded with when the request fits, so it is not reloaded', () => {
    expect(chooseNumCtx({ promptTokens: 900, answerTokens: 300, limit: 8192, loaded: 4096 })).toBe(
      4096,
    );
    // Not when it is too small for this prompt...
    expect(chooseNumCtx({ promptTokens: 3000, answerTokens: 300, limit: 8192, loaded: 2048 })).toBe(
      4096,
    );
    // ...or bigger than allowed (say Context size was lowered since it loaded).
    expect(chooseNumCtx({ promptTokens: 900, answerTokens: 300, limit: 4096, loaded: 8192 })).toBe(
      2048,
    );
  });

  it('warms up with the smallest window, or the limit when that is smaller', () => {
    expect(startingNumCtx(4096)).toBe(MIN_NUM_CTX);
    expect(startingNumCtx(1024)).toBe(1024);
  });
});
