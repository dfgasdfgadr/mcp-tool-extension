(function () {
  function init() {
    setupExtensionToggleListeners();
    setupMenuCommands();
    storageHydrateThen(function () {
      state.extensionEnabled = isCurrentSiteExtensionEnabled();
      state.lastAppliedEnabled = state.extensionEnabled;
      if (!state.extensionEnabled) return;
      loadConfig();
      loadMockRules();
      loadMcpTools();
      loadFlows();
      loadFieldSources();
      loadEnvReplayConfig();
      loadEnvReplaySelections();
      state.configLoadedForEnable = true;
      restoreRecordingSessionIfNeeded(function () {
        setupRequestInterception();
      });
    });
  }

  function onDOMContentLoaded() {
    if (!state.extensionEnabled) return;
    if (state.uiBootstrapped) {
      showExtensionUi();
      return;
    }
    bootstrapExtensionUi();
  }

  init();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDOMContentLoaded);
  } else {
    onDOMContentLoaded();
  }
  window.addEventListener('load', onDOMContentLoaded);
  setTimeout(onDOMContentLoaded, 1500);
})();
