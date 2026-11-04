// The part of jsdom the ahead mode of `npm run bench` uses (PR 9.11). jsdom
// is already here for the tests, which do not need its types.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
