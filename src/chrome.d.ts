// The small part of the Chrome extension API this code uses so far. Modules
// that use it take it as a parameter, so tests pass a fake instead.
declare const chrome: {
  runtime: import('./messaging/protocol').ExtensionRuntime;
  storage: { sync: import('./settings').StorageAreaLike };
};
