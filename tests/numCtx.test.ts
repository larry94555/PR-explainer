import { PROMPT_MARGIN_TOKENS } from '../src/llm/contextSize';
import { createLoadedWindowMemory } from '../src/llm/loadedWindow';
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

describe('the remembered loaded window (PR 9.7)', () => {
  const AT = { llmUrl: 'http://localhost:11434', model: 'qwen2.5-coder:7b' };

  it('knows nothing until a request says which window it used', () => {
    const memory = createLoadedWindowMemory();
    expect(memory.known(AT)).toBeUndefined();
    memory.start(AT, 4096).done();
    expect(memory.known(AT)).toBe(4096);
    // The newest request wins.
    memory.start(AT, 2048).done();
    expect(memory.known(AT)).toBe(2048);
  });

  it('does not know the window for another model or server', () => {
    const memory = createLoadedWindowMemory();
    memory.start(AT, 4096).done();
    expect(memory.known({ ...AT, model: 'deepseek-r1:7b' })).toBeUndefined();
    expect(memory.known({ ...AT, llmUrl: 'http://127.0.0.1:11434' })).toBeUndefined();
    expect(memory.known({ ...AT, model: '' })).toBeUndefined();
  });

  it('forgets after a request with no window, a bad one, or forget()', () => {
    const memory = createLoadedWindowMemory();
    memory.start(AT, 4096).done();
    memory.start(AT, undefined).done();
    expect(memory.known(AT)).toBeUndefined();
    memory.start(AT, 4096).done();
    memory.start(AT, 0).done();
    expect(memory.known(AT)).toBeUndefined();
    memory.start(AT, 4096).done();
    memory.forget();
    expect(memory.known(AT)).toBeUndefined();
    // No model, nothing to remember.
    memory.start({ ...AT, model: '' }, 4096).done();
    expect(memory.known(AT)).toBeUndefined();
  });

  describe('overlapping requests: the last one sent wins', () => {
    it('ignores an older request that succeeds after a newer one', () => {
      const memory = createLoadedWindowMemory();
      const older = memory.start(AT, 2048);
      const newer = memory.start(AT, 8192);
      newer.done();
      older.done();
      expect(memory.known(AT)).toBe(8192);
    });

    it('ignores an older request that fails after a newer one succeeded', () => {
      const memory = createLoadedWindowMemory();
      const older = memory.start(AT, 2048);
      const newer = memory.start(AT, 8192);
      newer.done();
      older.failed();
      expect(memory.known(AT)).toBe(8192);
    });

    it('does not let an older success fill in after the newer request failed', () => {
      const memory = createLoadedWindowMemory();
      const older = memory.start(AT, 2048);
      const newer = memory.start(AT, 8192);
      newer.failed();
      older.done();
      expect(memory.known(AT)).toBeUndefined();
    });

    it('counts a newer request even before it ends', () => {
      const memory = createLoadedWindowMemory();
      const older = memory.start(AT, 2048);
      memory.start(AT, 8192);
      older.done();
      // Not known until the newer one says.
      expect(memory.known(AT)).toBeUndefined();
    });

    it('keeps what a request found out instead of what it sent, when it says so', () => {
      const memory = createLoadedWindowMemory();
      memory.start(AT, undefined).done(4096);
      expect(memory.known(AT)).toBe(4096);
    });

    it('ignores requests that end after forget()', () => {
      const memory = createLoadedWindowMemory();
      const running = memory.start(AT, 4096);
      memory.forget();
      running.done();
      expect(memory.known(AT)).toBeUndefined();
    });
  });
});
