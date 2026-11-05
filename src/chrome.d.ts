// The small part of the Chrome extension API this code uses so far. Modules
// that use it take it as a parameter, so tests pass a fake instead.
declare const chrome: {
  runtime: import('./messaging/protocol').ExtensionRuntime &
    import('./messaging/protocol').PortRuntime & {
      onStartup: { addListener(listener: () => void): void };
      getURL(path: string): string;
      // Whether the offscreen document is open (PR 11.13).
      getContexts: import('./llm/offscreenAi').ContextsRuntime['getContexts'];
    };
  // Runs Chrome's built-in model for the service worker (PR 11.13).
  offscreen: import('./llm/offscreenAi').OffscreenLike;
  windows: import('./debug/debugWindowOpener').WindowsLike;
  contextMenus: import('./debug/debugWindowOpener').ContextMenusLike;
  action: import('./toolbarToggle').ActionLike;
  // Chrome 116 and later (PR 11.8); missing on older versions.
  sidePanel: import('./sidePanelOpener').SidePanelLike | undefined;
  // Keyboard shortcuts (PR 11.9). getAll is read by the settings page.
  commands: import('./commands').CommandsLike & {
    getAll(): Promise<import('./options/shortcuts').CommandInfo[]>;
  };
  tabs: {
    // Every tab, or (PR 11.6) those whose URL matches a pattern of the extension's sites.
    query(info: {
      url?: string;
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<{ id?: number; url?: string; windowId?: number }[]>;
    // A shortcut or the right-click menu tells the page what to do (PR 11.9).
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    // The settings page opens chrome://extensions/shortcuts (PR 11.9).
    create(properties: { url: string }): Promise<unknown>;
    // The side panel talks to the active tab's page (PR 11.8).
    connect(tabId: number, info: { name: string }): import('./messaging/protocol').PortLike;
    onActivated: {
      addListener(listener: (info: { tabId: number; windowId: number }) => void): void;
    };
    onRemoved: { addListener(listener: (tabId: number) => void): void };
    onUpdated: {
      addListener(
        listener: (
          tabId: number,
          changeInfo: { status?: string; url?: string },
          tab?: { url?: string; windowId?: number },
        ) => void,
      ): void;
    };
  };
  storage: {
    sync: import('./settings').StorageAreaLike;
    local: import('./enabledState').LocalStorageLike;
    session: import('./explain/explainCache').SessionStorageLike;
    onChanged: import('./enabledState').StorageChangedEvent;
  };
};
