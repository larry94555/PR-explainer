import { describeLlmError, detectPlatform } from '../src/llm/describeLlmError';
import { LlmError, type LlmErrorKind } from '../src/llm/types';

const URL = 'http://localhost:11434';
const err = (kind: LlmErrorKind, message = 'raw message') => new LlmError(kind, message);

describe('describeLlmError', () => {
  it('tells the user to start Ollama when nothing answers', () => {
    expect(describeLlmError(err('connection'), { url: URL })).toEqual({
      message: 'Ollama is not running at http://localhost:11434.',
      fix:
        'Start Ollama (open the Ollama app, or run `ollama serve`), then try again. ' +
        'If Ollama uses another port, fix the URL.',
    });
  });

  it("says what to do when Chrome's built-in model cannot answer (PR 11.13)", () => {
    const unavailable = describeLlmError(err('unavailable', 'It is not downloaded yet.'));
    expect(unavailable.message).toBe('It is not downloaded yet.');
    expect(unavailable.fix).toContain('**Download**');
    expect(unavailable.fix).toContain('**Ollama**');
    expect(describeLlmError(err('built-in-error', 'It crashed.'))).toEqual({
      message: "Chrome's built-in model failed: It crashed.",
      fix: 'Try again, or set **Model server** back to **Ollama** in the settings.',
    });
  });

  it('leaves the URL out when it is not known', () => {
    expect(describeLlmError(err('connection')).message).toBe('Ollama is not running.');
  });

  it('names the model to pull when it is missing', () => {
    expect(describeLlmError(err('model-not-found'), { model: ' llama3.2:3b ' })).toEqual({
      message: 'The model "llama3.2:3b" is not installed.',
      fix: 'Run `ollama pull llama3.2:3b`, then click Refresh.',
    });
  });

  it('uses a placeholder when the missing model is not known', () => {
    expect(describeLlmError(err('model-not-found')).fix).toBe(
      'Run `ollama pull <model>`, then click Refresh.',
    );
  });

  it.each([
    ['windows', 'setx OLLAMA_ORIGINS "chrome-extension://*"', 'system tray'],
    ['mac', 'launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"', 'menu bar'],
    ['other', 'OLLAMA_ORIGINS=chrome-extension://*', 'restart'],
  ] as const)('gives the %s command for a blocked origin', (platform, command, restart) => {
    const { message, fix } = describeLlmError(err('origin-blocked'), { platform });
    expect(message).toBe('Ollama blocked the request from this extension.');
    expect(fix).toContain(`\`${command}\``);
    expect(fix).toContain(restart);
  });

  it('defaults to the generic OLLAMA_ORIGINS hint', () => {
    expect(describeLlmError(err('origin-blocked')).fix).toContain(
      '`OLLAMA_ORIGINS=chrome-extension://*`',
    );
  });

  it('asks for a model when none is selected', () => {
    expect(describeLlmError(err('no-model'))).toEqual({
      message: 'No model is selected.',
      fix: 'Choose a model in the list. If the list is empty, click Refresh.',
    });
  });

  it('suggests checking the URL for a reply that is not from Ollama', () => {
    const { message, fix } = describeLlmError(err('bad-response'), { url: URL });
    expect(message).toBe('The server at http://localhost:11434 did not reply the way Ollama does.');
    expect(fix).toContain('`http://localhost:11434`');
  });

  it('keeps the server detail for other HTTP errors', () => {
    const error = err('http', '/api/chat failed with HTTP 500 (out of memory).');
    expect(describeLlmError(error)).toEqual({
      message: 'Ollama returned an error: /api/chat failed with HTTP 500 (out of memory).',
      fix: 'Check the Ollama logs for details, then try again.',
    });
  });

  it('says a cancelled request was cancelled', () => {
    expect(describeLlmError(err('aborted'))).toEqual({
      message: 'The request was cancelled.',
      fix: 'Try again.',
    });
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(describeLlmError(new Error('boom'))).toEqual({
      message: 'Something went wrong: boom',
      fix: 'Try again. If it keeps happening, check that Ollama is running.',
    });
    expect(describeLlmError('just a string').message).toBe('Something went wrong: just a string');
  });
});

describe('detectPlatform', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0', 'windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0', 'mac'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0', 'other'],
  ] as const)('reads %s as %s', (userAgent, platform) => {
    expect(detectPlatform(userAgent)).toBe(platform);
  });
});
