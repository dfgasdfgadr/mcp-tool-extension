var STORAGE_CACHE = {};

function isExtensionContextValid() {
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.id === 'string' && chrome.runtime.id.length > 0);
  } catch (e) {
    return false;
  }
}

var extensionContextInvalidLogged = false;
function warnExtensionContextInvalidOnce() {
  if (extensionContextInvalidLogged) return;
  extensionContextInvalidLogged = true;
  console.warn('[AI_REQ_ANALYZER] 扩展已重载或更新，当前页面脚本已失效。请刷新本页后再使用（Extension context invalidated）。');
}

function storageGet(key, defVal) {
  if (Object.prototype.hasOwnProperty.call(STORAGE_CACHE, key)) return STORAGE_CACHE[key];
  return defVal;
}

function storageSet(key, val) {
  if (!isExtensionContextValid()) {
    warnExtensionContextInvalidOnce();
    return;
  }
  if (val === null || typeof val === 'undefined') {
    delete STORAGE_CACHE[key];
    try {
      chrome.storage.local.remove(key);
    } catch (e) {}
    return;
  }
  STORAGE_CACHE[key] = val;
  var o = {};
  o[key] = val;
  try {
    chrome.storage.local.set(o, function () {
      if (chrome.runtime.lastError) {
        console.warn('[AI_REQ_ANALYZER] storageSet error:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn('[AI_REQ_ANALYZER] storageSet exception:', e.message);
  }
}

function storageHydrateThen(cb) {
  if (!isExtensionContextValid()) {
    warnExtensionContextInvalidOnce();
    try {
      if (typeof cb === 'function') cb();
    } catch (eCb) {}
    return;
  }
  chrome.storage.local.get(null, function (items) {
    if (chrome.runtime.lastError) {
      cb();
      return;
    }
    if (items) Object.assign(STORAGE_CACHE, items);
    cb();
  });
}

var DEFAULT_CONFIG = {
  apiKey: '',
  baseURL: 'https://api.moonshot.cn/v1',
  model: 'kimi-k2.6',
  temperature: 1,
  mcpPort: 9527,
  mcpToken: '',
  mcpAutoSync: false,
  mcpToolNaming: 'full',
  mcpExportPath: '',
  enableFlowContextListTool: true,
  enableFlowContextDetailTool: true,
  enableBrainstormMcpTool: true
};

var CONFIG_KEY = 'ai_req_analyzer_config';
var MOCK_RULES_KEY_PREFIX = 'ai_req_mock_rules_';
var FLOWS_KEY_PREFIX = 'ai_req_flows_';
var EXTENSION_ENABLED_KEY_PREFIX = 'ai_req_extension_enabled_';
var PAGE_RECORD_MSG = 'AI_REQ_ANALYZER_PAGE_RECORD';
var PAGE_MOCK_RULES_MSG = 'AI_REQ_ANALYZER_MOCK_RULES';
var PAGE_RULE_CONSUMED_MSG = 'AI_REQ_ANALYZER_RULE_CONSUMED';

var MAX_RECORDS = 100;
var MAX_AI_BODY_LENGTH = 2000;

var state = {
  config: Object.assign({}, DEFAULT_CONFIG),
  requestRecords: [],
  mockRules: {},
  floatingBall: null,
  mainPanel: null,
  configPanel: null,
  jsonEditor: null,
  rewriteEditor: null,
  isPanelOpen: false,
  expandedReqId: null,
  isAnalyzing: false,
  analyzeProgress: { total: 0, done: 0 },
  selectedReqId: null,
  selectedRewriteReqId: null,
  ui: {
    activeMainTab: 'requests',
    requestKeyword: ''
  },
  uiReady: false,
  menuReady: false,
  mcpTools: {},
  flows: {},
  activeFlowId: null,
  flowRecording: false,
  activeFlowLastStepId: null,
  activeFlowLastActionAt: 0,
  flowUi: {
    selectedFlowId: null,
    selectedStepId: null,
    filterClassification: 'all'
  },
  recordingTrayVisible: false,
  recordingTrayEl: null,
  activeFlowRecordingSignatures: null,
  activeFlowStorageKey: '',
  activeFlowRecordStorageKey: '',
  activeFlowTabMeta: null,
  mcpPanelTab: 'list',
  listFilters: {
    dupOnly: false,
    mock: 'all',
    analyzed: 'all',
    methods: {},
    groupMode: 'none'
  },
  selectedReqIds: {},
  selectedMcpToolNames: {},
  mcpUseEnhancedGeneration: false,
  mcpViewDataset: null,
  mcpListUi: {
    keyword: '',
    viewMode: 'flowTree',
    groupMode: 'none',
    filterEnabled: 'all',
    riskLevels: {},
    toolbarCollapsed: false,
    siteFilter: 'all',
    selectedToolName: null,
    selectedFlowId: null,
    collapsedFlowIds: {},
    inspectorOpen: false,
    scrollToFlowId: null
  },
  fieldSources: {},
  provenanceSelectionReady: false,
  envReplayConfig: null,
  envReplaySelections: {},
  extensionEnabled: false,
  uiBootstrapped: false,
  pageHookInjected: false,
  interceptionReady: false,
  lastAppliedEnabled: null,
  domGuardStarted: false,
  extensionToggleListenersReady: false,
  configLoadedForEnable: false,
  pageContextMessageListenerReady: false
};

function loadConfig() {
  try {
    var saved = storageGet(CONFIG_KEY, null);
    if (saved) {
      state.config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(saved));
    }
  } catch (e) {}
}

function saveConfig() {
  storageSet(CONFIG_KEY, JSON.stringify(state.config));
}

function loadMockRules() {
  try {
    var key = MOCK_RULES_KEY_PREFIX + location.hostname;
    var saved = storageGet(key, null);
    if (saved) {
      state.mockRules = JSON.parse(saved);
      normalizeAllRules();
    }
  } catch (e) {}
}

function saveMockRules() {
  var key = MOCK_RULES_KEY_PREFIX + location.hostname;
  normalizeAllRules();
  storageSet(key, JSON.stringify(state.mockRules));
  syncMockRulesToPage();
}

function getFlowsKey(hostname) {
  return FLOWS_KEY_PREFIX + (hostname || location.hostname);
}

function getExtensionEnabledStorageKey(hostname) {
  return EXTENSION_ENABLED_KEY_PREFIX + (hostname || location.hostname);
}

function readExtensionEnabledForHostname(hostname) {
  var key = getExtensionEnabledStorageKey(hostname);
  var raw = storageGet(key, null);
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return false;
}

function writeExtensionEnabledForHostname(hostname, enabled) {
  storageSet(getExtensionEnabledStorageKey(hostname), !!enabled);
}

function isCurrentSiteExtensionEnabled() {
  return readExtensionEnabledForHostname(location.hostname);
}

function getActiveFlowStorageKey() {
  if (state.flowRecording && state.activeFlowStorageKey) return state.activeFlowStorageKey;
  return getFlowsKey();
}

function loadFlowsFromStorageKey(storageKey) {
  ensureFlowState();
  try {
    var saved = storageGet(storageKey, null);
    if (saved) {
      var parsed = JSON.parse(saved);
      state.flows = parsed && typeof parsed === 'object' ? parsed : {};
    } else {
      state.flows = {};
    }
  } catch (e) {
    state.flows = {};
  }
}

function saveFlowsToStorageKey(storageKey) {
  ensureFlowState();
  storageSet(storageKey, JSON.stringify(state.flows || {}));
}

function ensureFlowState() {
  if (!state.flows || typeof state.flows !== 'object') state.flows = {};
  if (!state.flowUi || typeof state.flowUi !== 'object') {
    state.flowUi = {
      selectedFlowId: null,
      selectedStepId: null,
      filterClassification: 'all'
    };
  }
  if (!state.flowUi.filterClassification) state.flowUi.filterClassification = 'all';
}

function loadFlows(storageKey) {
  ensureFlowState();
  loadFlowsFromStorageKey(storageKey || getActiveFlowStorageKey());
}

function saveFlows(storageKey) {
  ensureFlowState();
  var targetKey = storageKey || getActiveFlowStorageKey();
  if (state.flowRecording && state.activeFlowStorageKey && state.activeFlowId && !storageKey) {
    syncActiveFlowToBackground();
    return;
  }
  saveFlowsToStorageKey(targetKey);
}

function syncActiveFlowToBackground() {
  if (!state.flowRecording || !state.activeFlowStorageKey || !state.activeFlowId || !isExtensionContextValid()) return;
  var flow = state.flows && state.flows[state.activeFlowId];
  if (!flow) return;
  try {
    chrome.runtime.sendMessage({
      type: 'FLOW_RECORDING_SYNC_FLOW',
      payload: {
        flowId: state.activeFlowId,
        ownerStorageKey: state.activeFlowStorageKey,
        flow: flow
      }
    }, function (res) {
      if (chrome.runtime.lastError || !res || !res.ok) {
        console.warn('[AI_REQ_ANALYZER] 录制流程同步失败:', chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error));
      }
    });
  } catch (e) {}
}

function mergeArchivedRequestRecords(records) {
  if (!records || !records.length) return 0;
  var byId = {};
  var i;
  for (i = 0; i < state.requestRecords.length; i++) byId[state.requestRecords[i].id] = state.requestRecords[i];
  var added = 0;
  for (i = 0; i < records.length; i++) {
    var rec = records[i];
    if (!rec || !rec.id) continue;
    var existing = byId[rec.id];
    if (existing) {
      if (preferArchivedResponseBody(rec.responseBody, existing.responseBody)) {
        existing.responseBody = rec.responseBody;
        existing.responseStatus = rec.responseStatus != null ? rec.responseStatus : existing.responseStatus;
        existing.responseHeaders = rec.responseHeaders != null ? rec.responseHeaders : existing.responseHeaders;
        if (typeof invalidateProvenanceCache === 'function') invalidateProvenanceCache(existing);
        else {
          delete existing._provBodyStr;
          delete existing._provIndex;
        }
      }
      continue;
    }
    state.requestRecords.push(rec);
    byId[rec.id] = rec;
    added++;
  }
  while (state.requestRecords.length > MAX_RECORDS) state.requestRecords.shift();
  return added;
}

function isTruncatedArchiveBody(body) {
  return !!(body && typeof body === 'object' && !Array.isArray(body) && body.__archiveTruncated);
}

function responseBodySearchableScore(body) {
  if (body === null || typeof body === 'undefined') return 0;
  if (isTruncatedArchiveBody(body)) {
    return typeof body.preview === 'string' ? Math.min(body.preview.length, 1000) : 1;
  }
  if (typeof body === 'string') return body.length > 0 ? body.length : 0;
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body).length;
    } catch (e) {
      return 2;
    }
  }
  return 1;
}

function preferArchivedResponseBody(incoming, existing) {
  return responseBodySearchableScore(incoming) > responseBodySearchableScore(existing);
}

function loadArchivedFlowRecords(recordStorageKey) {
  if (!recordStorageKey) return;
  try {
    var saved = storageGet(recordStorageKey, null);
    if (!saved) return;
    var archive = typeof saved === 'string' ? JSON.parse(saved) : saved;
    if (!archive || !archive.recordsById || !Array.isArray(archive.order)) return;
    var records = [];
    for (var i = 0; i < archive.order.length; i++) {
      var rec = archive.recordsById[archive.order[i]];
      if (rec) records.push(rec);
    }
    mergeArchivedRequestRecords(records);
  } catch (e) {}
}

function loadArchivedFlowRecordsFresh(recordStorageKey, done) {
  if (!recordStorageKey || !isExtensionContextValid()) {
    if (typeof done === 'function') done(0);
    return;
  }
  try {
    chrome.storage.local.get(recordStorageKey, function (items) {
      var added = 0;
      try {
        if (!chrome.runtime.lastError && items && Object.prototype.hasOwnProperty.call(items, recordStorageKey)) {
          var saved = items[recordStorageKey];
          STORAGE_CACHE[recordStorageKey] = saved;
          var archive = typeof saved === 'string' ? JSON.parse(saved) : saved;
          if (archive && archive.recordsById && Array.isArray(archive.order)) {
            var records = [];
            for (var i = 0; i < archive.order.length; i++) {
              var rec = archive.recordsById[archive.order[i]];
              if (rec) records.push(rec);
            }
            added = mergeArchivedRequestRecords(records);
          }
        }
      } catch (eParse) {}
      if (typeof done === 'function') done(added);
    });
  } catch (e) {
    if (typeof done === 'function') done(0);
  }
}

function notifyFlowRecordingStart(flow) {
  if (!flow || !isExtensionContextValid()) return;
  try {
    chrome.runtime.sendMessage({
      type: 'FLOW_RECORDING_START',
      payload: {
        flowId: flow.id,
        flowName: flow.name || '',
        hostname: location.hostname,
        origin: location.origin,
        url: location.href,
        ownerStorageKey: getFlowsKey(location.hostname)
      }
    }, function (res) {
      if (chrome.runtime.lastError || !res || !res.ok) {
        console.warn('[AI_REQ_ANALYZER] 跨页面录制会话启动失败:', chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error));
        return;
      }
      if (res.session) {
        state.activeFlowStorageKey = res.session.ownerStorageKey || state.activeFlowStorageKey;
        state.activeFlowRecordStorageKey = res.session.recordStorageKey || state.activeFlowRecordStorageKey;
        syncActiveFlowToBackground();
      }
    });
  } catch (e) {}
}

function notifyFlowRecordingStop(flowId, flow) {
  if (!flowId || !isExtensionContextValid()) return;
  try {
    chrome.runtime.sendMessage({
      type: 'FLOW_RECORDING_STOP',
      payload: {
        flowId: flowId,
        ownerStorageKey: state.activeFlowStorageKey || getFlowsKey(location.hostname),
        flow: flow || null
      }
    }, function () {});
  } catch (e) {}
}

function clearLocalFlowRecordingState() {
  state.flowRecording = false;
  state.activeFlowId = null;
  state.activeFlowLastStepId = null;
  state.activeFlowLastActionAt = 0;
  state.activeFlowRecordingSignatures = null;
  state.activeFlowStorageKey = '';
  state.activeFlowRecordStorageKey = '';
  state.activeFlowTabMeta = null;
}

function createFlow(name) {
  ensureFlowState();
  var id = 'flow_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  var flow = {
    id: id,
    kind: 'recorded',
    name: name || '未命名流程',
    hostname: location.hostname,
    startedAt: Date.now(),
    endedAt: null,
    steps: [],
    verifiedRequestIds: [],
    classifications: {},
    requestMeta: {},
    manualVerificationOverrides: {},
    notes: '',
    mcpToolNames: []
  };
  state.flows[id] = flow;
  state.activeFlowId = id;
  state.flowRecording = true;
  state.activeFlowLastStepId = null;
  state.activeFlowLastActionAt = 0;
  state.activeFlowRecordingSignatures = {};
  state.flowUi.selectedFlowId = id;
  state.flowUi.selectedStepId = null;
  saveFlows();
  notifyFlowRecordingStart(flow);
  return flow;
}

function getActiveFlow() {
  ensureFlowState();
  if (!state.activeFlowId) return null;
  return state.flows[state.activeFlowId] || null;
}

function finishFlow(flowId) {
  ensureFlowState();
  var id = flowId || state.activeFlowId;
  if (!id || !state.flows[id]) return null;
  var finishedFlowId = id;
  var finishedFlow = state.flows[id];
  finishedFlow.endedAt = Date.now();
  saveFlows();
  notifyFlowRecordingStop(finishedFlowId, finishedFlow);
  if (state.activeFlowId === id) clearLocalFlowRecordingState();
  return finishedFlow;
}
