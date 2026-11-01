import { EXTENSION_NAME } from '../src/index';

describe('sanity', () => {
  it('runs Vitest in jsdom and resolves TypeScript imports from src/', () => {
    expect(EXTENSION_NAME).toBe('PR Explainer');
    expect(typeof document.createElement).toBe('function');
  });
});
