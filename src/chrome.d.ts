// The small part of the Chrome extension API this code uses so far. Modules
// that use it take it as a parameter, so tests pass a fake instead.
declare const chrome: {
  runtime: import('./messaging/protocol').ExtensionRuntime &
    import('./messaging/protocol').PortRuntime & {
      onStartup: { addListener(listener: () => void): void };
    };
  action: import('./toolbarToggle').ActionLike;
  storage: {
    sync: import('./settings').StorageAreaLike;
    local: import('./enabledState').LocalStorageLike;
    session: import('./explain/explainCache').SessionStorageLike;
    onChanged: import('./enabledState').StorageChangedEvent;
  };
};
