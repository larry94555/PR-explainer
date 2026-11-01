// The small part of the Chrome extension API this code uses so far. The
// messaging layer receives it as a parameter, so tests pass a fake instead.
declare const chrome: {
  runtime: import('./messaging/protocol').ExtensionRuntime;
};
