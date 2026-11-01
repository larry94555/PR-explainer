describe('sanity', () => {
  it('runs Vitest in jsdom', () => {
    expect(typeof document.createElement).toBe('function');
  });
});
