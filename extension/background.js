'use strict';

importScripts('shared/runtime-auth.js');
importScripts('shared/site-affinity.js');
importScripts('background-runtime-auth.js');
importScripts('background-flow-context.js');
importScripts('background-env-replay.js');

var MENU_IDS = {
  OPEN_PANEL: 'ai_req_analyzer_open_panel',
  OPEN_CONFIG: 'ai_req_analyzer_open_config',
  RESET_POS: 'ai_req_analyzer_reset_positions',
  DIAG: 'ai_req_analyzer_diagnostics'
};

var FLOW_RECORDING_SESSION_KEY = 'ai_req_active_recording_session';
var FLOW_RECORDING_SCHEMA_VERSION = 1;
var FLOW_RECORDS_KEY_PREFIX = 'ai_req_flow_records_';
var FLOW_RECORD_ARCHIVE_MAX_CHARS = 4 * 1024 * 1024;
var FLOW_RECORD_BODY_FIELD_MAX_CHARS = 512 * 1024;
var FLOW_RECORD_COMPACT_BODY_MAX_CHARS = 64 * 1024;
var FLOW_RECORD_HEADER_VALUE_MAX_CHARS = 4096;
var FLOW_RECORD_COMPACT_HEADER_VALUE_MAX_CHARS = 1024;
var recordingSessionCache = null;
var recordingSessionHydrated = false;
var recordingSessionHydratePromise = null;
var recordingSessionUpdateQueue = Promise.resolve();
var flowRecordArchiveWriteQueues = {};
var flowRecordingFlowWriteQueues = {};
var EXTENSION_ENABLED_KEY_PREFIX = 'ai_req_extension_enabled_';
var disableRequestTimeouts = {};

function hostnameFromTabUrl(url) {
  try {
    var u = new URL(url || '');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname || null;
  } catch (e) {
    return null;
  }
}

function extensionEnabledStorageKey(hostname) {
  return EXTENSION_ENABLED_KEY_PREFIX + hostname;
}

function readEnabledFromItems(items, hostname) {
  var v = items && items[extensionEnabledStorageKey(hostname)];
  return v === true || v === 'true';
}

function setActionBadgeForTab(tabId, enabled) {
  if (typeof tabId === 'undefined') return;
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: enabled ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: enabled ? '#1f6feb' : '#666666' });
    chrome.action.setTitle({
      tabId: tabId,
      title: enabled ? 'AI请求分析助手 · 本站已启用' : 'AI请求分析助手 · 本站已关闭'
    });
  } catch (e) {}
}

function refreshBadgeForTab(tab) {
  if (!tab || typeof tab.id === 'undefined') return;
  var host = hostnameFromTabUrl(tab.url);
  if (!host) {
    setActionBadgeForTab(tab.id, false);
    return;
  }
  chrome.storage.local.get(extensionEnabledStorageKey(host), function (items) {
    setActionBadgeForTab(tab.id, readEnabledFromItems(items, host));
  });
}

function broadcastEnabledToHostnameTabs(hostname, enabled) {
  chrome.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab || typeof tab.id === 'undefined') return;
      if (hostnameFromTabUrl(tab.url) !== hostname) return;
      chrome.tabs.sendMessage(tab.id, {
        type: 'EXTENSION_SET_ENABLED',
        hostname: hostname,
        enabled: !!enabled,
        toast: false
      }).catch(function () {});
      setActionBadgeForTab(tab.id, !!enabled);
    });
  });
}

function escapeRegExpMcp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyPathParamsToTemplate(pathnameTemplate, pathParamKeys, toolArguments) {
  var path = pathnameTemplate || '';
  var keys = pathParamKeys || [];
  if (!keys.length || path.indexOf('{') === -1) return path;
  var ki;
  for (ki = 0; ki < keys.length; ki++) {
    var k = keys[ki];
    var val = toolArguments[k];
    if (val === undefined || val === null) val = '';
    path = path.replace(new RegExp('\\{' + escapeRegExpMcp(k) + '\\}', 'g'), encodeURIComponent(String(val)));
  }
  return path;
}

function partitionMcpToolArguments(toolMeta, toolArguments) {
  var args = toolArguments || {};
  var pathKeys = toolMeta.pathParamKeys || [];
  var pathnameTemplate = toolMeta.pathname || '';
  var resolvedPath = pathnameTemplate;
  if (pathKeys.length && pathnameTemplate.indexOf('{') !== -1) {
    resolvedPath = applyPathParamsToTemplate(pathnameTemplate, pathKeys, args);
  }
  var rest = {};
  var ak = Object.keys(args);
  var ai;
  for (ai = 0; ai < ak.length; ai++) {
    var key = ak[ai];
    if (key.charAt(0) === '_') continue;
    if (pathKeys.indexOf(key) >= 0) continue;
    rest[key] = args[key];
  }
  return { pathname: resolvedPath, restArgs: rest };
}

function enrichBrainstormToolMeta(toolDef, toolMeta) {
  if (!toolMeta || toolMeta.source !== 'system_brainstorm') return toolMeta;
  if (toolMeta.method && toolMeta.pathname) return toolMeta;
  var name = (toolDef && toolDef.name) || '';
  var m = name.match(/^(get|post|put|patch|delete)_(.+)$/i);
  if (!m) return toolMeta;
  var enriched = Object.assign({}, toolMeta, {
    method: m[1].toUpperCase(),
    pathname: '/' + m[2].replace(/_/g, '/')
  });
  if (!enriched.origin && enriched.hostname) {
    enriched.origin = 'https://' + enriched.hostname;
  }
  return enriched;
}

function normalizeMcpRequestBody(bodyData) {
  if (bodyData == null) return bodyData;
  if (Array.isArray(bodyData)) return bodyData;
  if (typeof bodyData !== 'object') return bodyData;
  var keys = Object.keys(bodyData);
  if (keys.length === 1 && keys[0] === 'body' && Array.isArray(bodyData.body)) {
    return bodyData.body;
  }
  return bodyData;
}

function installMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_IDS.OPEN_PANEL,
      title: '打开请求分析面板',
      contexts: ['page', 'frame', 'editable', 'link', 'selection', 'audio', 'video', 'image']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.OPEN_CONFIG,
      title: '配置',
      contexts: ['page', 'frame', 'editable', 'link', 'selection', 'audio', 'video', 'image']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.RESET_POS,
      title: '重置悬浮窗位置',
      contexts: ['page', 'frame', 'editable', 'link', 'selection', 'audio', 'video', 'image']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.DIAG,
      title: '诊断运行状态',
      contexts: ['page', 'frame', 'editable', 'link', 'selection', 'audio', 'video', 'image']
    });
  });
}

function getSessionStorageArea() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

function getStorageSessionValue(key) {
  return new Promise(function (resolve) {
    var area = getSessionStorageArea();
    if (!area) {
      resolve(null);
      return;
    }
    try {
      area.get(key, function (items) {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(items ? items[key] : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setStorageSessionValue(key, value) {
  return new Promise(function (resolve) {
    var area = getSessionStorageArea();
    if (!area) {
      resolve(false);
      return;
    }
    try {
      var payload = {};
      payload[key] = value;
      area.set(payload, function () {
        resolve(!chrome.runtime.lastError);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function removeStorageSessionValue(key) {
  return new Promise(function (resolve) {
    var area = getSessionStorageArea();
    if (!area) {
      resolve(false);
      return;
    }
    try {
      area.remove(key, function () {
        resolve(!chrome.runtime.lastError);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function isValidRecordingSession(session) {
  return !!(
    session &&
    session.schemaVersion === FLOW_RECORDING_SCHEMA_VERSION &&
    session.status === 'recording' &&
    session.flowId &&
    session.rootHostname &&
    session.ownerStorageKey &&
    Array.isArray(session.tabIds)
  );
}

function cloneRecordingSession(session) {
  if (!session) return null;
  try {
    return JSON.parse(JSON.stringify(session));
  } catch (e) {
    return null;
  }
}

function getRecordingSession() {
  if (recordingSessionHydrated) {
    return Promise.resolve(cloneRecordingSession(recordingSessionCache));
  }
  if (recordingSessionHydratePromise) return recordingSessionHydratePromise;
  recordingSessionHydratePromise = getStorageSessionValue(FLOW_RECORDING_SESSION_KEY).then(function (session) {
    if (!isValidRecordingSession(session)) {
      recordingSessionCache = null;
    } else {
      recordingSessionCache = cloneRecordingSession(session);
    }
    recordingSessionHydrated = true;
    recordingSessionHydratePromise = null;
    return cloneRecordingSession(recordingSessionCache);
  });
  return recordingSessionHydratePromise;
}

function saveRecordingSession(session) {
  if (!session) return clearRecordingSession();
  var nextSession = cloneRecordingSession(Object.assign({}, session, { updatedAt: Date.now() }));
  if (!nextSession) return Promise.resolve(false);
  return setStorageSessionValue(FLOW_RECORDING_SESSION_KEY, nextSession).then(function (ok) {
    if (ok) {
      recordingSessionCache = cloneRecordingSession(nextSession);
      recordingSessionHydrated = true;
    }
    return ok;
  });
}

function clearRecordingSession() {
  return removeStorageSessionValue(FLOW_RECORDING_SESSION_KEY).then(function (ok) {
    if (ok) {
      recordingSessionCache = null;
      recordingSessionHydrated = true;
    }
    return ok;
  });
}

function updateRecordingSession(mutator) {
  var run = recordingSessionUpdateQueue.catch(function () {}).then(function () {
    return getRecordingSession().then(function (currentSession) {
      var session = cloneRecordingSession(currentSession);
      return Promise.resolve(mutator(session)).then(function (result) {
        result = result || {};
        if (result.clearSession) {
          return clearRecordingSession().then(function (ok) {
            result.saved = ok;
            return result;
          });
        }
        if (result.replaceSession) {
          return saveRecordingSession(result.replaceSession).then(function (ok) {
            result.saved = ok;
            return result;
          });
        }
        if (result.skipSave || !session) return result;
        return saveRecordingSession(session).then(function (ok) {
          result.saved = ok;
          return result;
        });
      });
    });
  });
  recordingSessionUpdateQueue = run.then(function () {}, function () {});
  return run;
}

function parseHttpUrl(url) {
  try {
    var parsed = new URL(url || '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function normalizeTabId(tabId) {
  var n = parseInt(tabId, 10);
  return Number.isFinite(n) ? n : null;
}

function sessionHasTab(session, tabId) {
  var tid = normalizeTabId(tabId);
  return !!(session && tid !== null && session.tabIds && session.tabIds.indexOf(tid) !== -1);
}

function addTabToSession(session, tabId, meta) {
  var tid = normalizeTabId(tabId);
  if (!session || tid === null) return false;
  if (!session.tabIds) session.tabIds = [];
  if (!session.tabMeta) session.tabMeta = {};
  if (session.tabIds.indexOf(tid) === -1) session.tabIds.push(tid);
  session.tabMeta[String(tid)] = Object.assign({ joinedAt: Date.now(), tabId: tid }, meta || {}, { tabId: tid });
  return true;
}

function removeTabFromSession(session, tabId) {
  var tid = normalizeTabId(tabId);
  if (!session || tid === null) return false;
  session.tabIds = (session.tabIds || []).filter(function (id) { return id !== tid; });
  if (session.tabMeta) delete session.tabMeta[String(tid)];
  if (session.pendingChildTabs) delete session.pendingChildTabs[String(tid)];
  return true;
}

function buildFlowRecordsKey(rootHostname, flowId) {
  return FLOW_RECORDS_KEY_PREFIX + String(rootHostname || '').replace(/[^\w.-]/g, '_') + '_' + String(flowId || '');
}

function createEmptyFlowRecordArchive() {
  return { schemaVersion: 1, flowId: '', recordsById: {}, order: [], updatedAt: Date.now() };
}

function readFlowRecordArchive(recordStorageKey) {
  return new Promise(function (resolve) {
    if (!recordStorageKey) {
      resolve(createEmptyFlowRecordArchive());
      return;
    }
    chrome.storage.local.get(recordStorageKey, function (items) {
      if (chrome.runtime.lastError) {
        resolve(createEmptyFlowRecordArchive());
        return;
      }
      var archive = items && items[recordStorageKey];
      if (typeof archive === 'string') {
        try { archive = JSON.parse(archive); } catch (e) { archive = null; }
      }
      if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
        archive = createEmptyFlowRecordArchive();
      }
      if (!archive.recordsById || typeof archive.recordsById !== 'object' || Array.isArray(archive.recordsById)) archive.recordsById = {};
      if (!Array.isArray(archive.order)) archive.order = [];
      resolve(archive);
    });
  });
}

function safeJsonStringifyArchiveValue(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return JSON.stringify(String(value));
  }
}

function cloneJsonLikeValue(value) {
  if (value === null || typeof value === 'undefined') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return String(value);
  }
}

function truncateStringValue(value, maxChars) {
  var str = String(value);
  if (str.length <= maxChars) return str;
  return str.substring(0, maxChars) + '...[archive truncated ' + (str.length - maxChars) + ' chars]';
}

function compactArchiveLargeValue(value, maxChars) {
  if (value === null || typeof value === 'undefined') return value;
  if (typeof value === 'string') return truncateStringValue(value, maxChars);
  var json = safeJsonStringifyArchiveValue(value);
  if (json.length <= maxChars) return cloneJsonLikeValue(value);
  return {
    __archiveTruncated: true,
    originalType: Array.isArray(value) ? 'array' : typeof value,
    originalLength: json.length,
    preview: truncateStringValue(json, maxChars)
  };
}

function compactArchiveHeaders(headers, maxValueChars) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return cloneJsonLikeValue(headers);
  var out = {};
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = headers[key];
    if (val === null || typeof val === 'undefined') {
      out[key] = val;
    } else if (typeof val === 'object') {
      out[key] = compactArchiveLargeValue(val, maxValueChars);
    } else {
      out[key] = truncateStringValue(val, maxValueChars);
    }
  }
  return out;
}

function sanitizeArchiveRecord(record, options) {
  options = options || {};
  var bodyMax = options.bodyMaxChars || FLOW_RECORD_BODY_FIELD_MAX_CHARS;
  var headerMax = options.headerValueMaxChars || FLOW_RECORD_HEADER_VALUE_MAX_CHARS;
  var out = cloneJsonLikeValue(record || {});
  if (!out || typeof out !== 'object' || Array.isArray(out)) {
    out = { id: record && record.id ? record.id : '', value: compactArchiveLargeValue(record, bodyMax) };
  }
  var bodyFields = ['requestBody', 'responseBody', 'mockData'];
  for (var i = 0; i < bodyFields.length; i++) {
    var field = bodyFields[i];
    if (Object.prototype.hasOwnProperty.call(out, field)) {
      out[field] = compactArchiveLargeValue(out[field], bodyMax);
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, 'requestHeaders')) {
    out.requestHeaders = compactArchiveHeaders(out.requestHeaders, headerMax);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'responseHeaders')) {
    out.responseHeaders = compactArchiveHeaders(out.responseHeaders, headerMax);
  }
  return out;
}

function compactArchiveRecordForQuota(record) {
  return sanitizeArchiveRecord(record, {
    bodyMaxChars: FLOW_RECORD_COMPACT_BODY_MAX_CHARS,
    headerValueMaxChars: FLOW_RECORD_COMPACT_HEADER_VALUE_MAX_CHARS
  });
}

function minimalArchiveRecord(record) {
  record = record || {};
  return {
    id: record.id || '',
    timestamp: record.timestamp || 0,
    method: record.method || '',
    url: truncateStringValue(record.url || '', 4096),
    originalUrl: truncateStringValue(record.originalUrl || '', 4096),
    responseStatus: record.responseStatus || 0,
    duration: record.duration || 0,
    isMocked: !!record.isMocked,
    archivedCompact: true
  };
}

function serializeArchiveUnderSoftLimit(archive) {
  var warnings = [];
  var json = JSON.stringify(archive);
  if (json.length <= FLOW_RECORD_ARCHIVE_MAX_CHARS) {
    return { json: json, warnings: warnings };
  }
  warnings.push('ARCHIVE_COMPACTED');
  var order = Array.isArray(archive.order) ? archive.order : [];
  var i;
  for (i = 0; i < order.length && json.length > FLOW_RECORD_ARCHIVE_MAX_CHARS; i++) {
    var id = order[i];
    if (archive.recordsById && archive.recordsById[id]) {
      archive.recordsById[id] = compactArchiveRecordForQuota(archive.recordsById[id]);
      json = JSON.stringify(archive);
    }
  }
  for (i = 0; i < order.length && json.length > FLOW_RECORD_ARCHIVE_MAX_CHARS; i++) {
    var minId = order[i];
    if (archive.recordsById && archive.recordsById[minId]) {
      archive.recordsById[minId] = minimalArchiveRecord(archive.recordsById[minId]);
      json = JSON.stringify(archive);
    }
  }
  while (order.length > 1 && json.length > FLOW_RECORD_ARCHIVE_MAX_CHARS) {
    var removedId = order.shift();
    if (archive.recordsById) delete archive.recordsById[removedId];
    if (warnings.indexOf('ARCHIVE_OLDEST_DROPPED') === -1) warnings.push('ARCHIVE_OLDEST_DROPPED');
    json = JSON.stringify(archive);
  }
  if (json.length > FLOW_RECORD_ARCHIVE_MAX_CHARS && order.length === 1 && archive.recordsById && archive.recordsById[order[0]]) {
    archive.recordsById[order[0]] = minimalArchiveRecord(archive.recordsById[order[0]]);
    json = JSON.stringify(archive);
  }
  return { json: json, warnings: warnings };
}

function writeFlowRecordArchive(recordStorageKey, archive) {
  return new Promise(function (resolve) {
    if (!recordStorageKey || !archive) {
      resolve({ ok: false, error: 'FLOW_RECORD_ARCHIVE_WRITE_FAILED' });
      return;
    }
    var payload = {};
    archive.updatedAt = Date.now();
    var serialized = serializeArchiveUnderSoftLimit(archive);
    payload[recordStorageKey] = serialized.json;
    chrome.storage.local.set(payload, function () {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || 'FLOW_RECORD_ARCHIVE_WRITE_FAILED'
        });
        return;
      }
      resolve({ ok: true, warnings: serialized.warnings });
    });
  });
}

function readOwnerFlows(ownerStorageKey) {
  return new Promise(function (resolve) {
    if (!ownerStorageKey) {
      resolve({});
      return;
    }
    chrome.storage.local.get(ownerStorageKey, function (items) {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      var flows = items && items[ownerStorageKey];
      if (typeof flows === 'string') {
        try { flows = JSON.parse(flows); } catch (e) { flows = null; }
      }
      if (!flows || typeof flows !== 'object' || Array.isArray(flows)) flows = {};
      resolve(flows);
    });
  });
}

function writeOwnerFlows(ownerStorageKey, flows) {
  return new Promise(function (resolve) {
    if (!ownerStorageKey || !flows) {
      resolve({ ok: false, error: 'FLOW_RECORDING_SYNC_FLOW_WRITE_FAILED' });
      return;
    }
    var payload = {};
    payload[ownerStorageKey] = JSON.stringify(flows);
    chrome.storage.local.set(payload, function () {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || 'FLOW_RECORDING_SYNC_FLOW_WRITE_FAILED'
        });
        return;
      }
      resolve({ ok: true });
    });
  });
}

function uniqueArrayUnion(a, b) {
  var out = [];
  var seen = {};
  function addList(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      var val = list[i];
      var key = String(val);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(val);
    }
  }
  addList(a);
  addList(b);
  return out;
}

function mergeFlowStep(existingStep, incomingStep) {
  var existing = existingStep && typeof existingStep === 'object' ? existingStep : {};
  var incoming = incomingStep && typeof incomingStep === 'object' ? incomingStep : {};
  var merged = Object.assign({}, existing);
  var updateKeys = ['id', 'index', 'type', 'title', 'at', 'url', 'target', 'meta'];
  for (var i = 0; i < updateKeys.length; i++) {
    var key = updateKeys[i];
    if (Object.prototype.hasOwnProperty.call(incoming, key) && incoming[key] !== undefined) {
      merged[key] = incoming[key];
    }
  }
  merged.requestIds = uniqueArrayUnion(existing.requestIds, incoming.requestIds);
  return merged;
}

function mergeFlowSteps(existingSteps, incomingSteps) {
  var merged = [];
  var byId = {};
  var i;
  if (Array.isArray(existingSteps)) {
    for (i = 0; i < existingSteps.length; i++) {
      var existingStep = existingSteps[i];
      if (!existingStep || !existingStep.id) continue;
      byId[existingStep.id] = merged.length;
      merged.push(mergeFlowStep(existingStep, null));
    }
  }
  if (Array.isArray(incomingSteps)) {
    for (i = 0; i < incomingSteps.length; i++) {
      var incomingStep = incomingSteps[i];
      if (!incomingStep || !incomingStep.id) continue;
      if (Object.prototype.hasOwnProperty.call(byId, incomingStep.id)) {
        merged[byId[incomingStep.id]] = mergeFlowStep(merged[byId[incomingStep.id]], incomingStep);
      } else {
        byId[incomingStep.id] = merged.length;
        merged.push(mergeFlowStep(null, incomingStep));
      }
    }
  }
  return merged;
}

function mergeRecordedFlow(existingFlow, incomingFlow, flowId) {
  var existing = existingFlow && typeof existingFlow === 'object' ? existingFlow : {};
  var incoming = incomingFlow && typeof incomingFlow === 'object' ? incomingFlow : {};
  var merged = {};
  var scalarKeys = ['id', 'kind', 'name', 'hostname', 'startedAt', 'notes'];
  for (var i = 0; i < scalarKeys.length; i++) {
    var key = scalarKeys[i];
    merged[key] = Object.prototype.hasOwnProperty.call(existing, key) ? existing[key] : incoming[key];
  }
  merged.id = merged.id || flowId || incoming.id || existing.id;
  merged.endedAt = incoming.endedAt || existing.endedAt || null;
  merged.steps = mergeFlowSteps(existing.steps, incoming.steps);
  merged.verifiedRequestIds = uniqueArrayUnion(existing.verifiedRequestIds, incoming.verifiedRequestIds);
  merged.classifications = Object.assign({}, existing.classifications || {}, incoming.classifications || {});
  merged.requestMeta = Object.assign({}, existing.requestMeta || {}, incoming.requestMeta || {});
  merged.manualVerificationOverrides = Object.assign(
    {},
    existing.manualVerificationOverrides || {},
    incoming.manualVerificationOverrides || {}
  );
  merged.mcpToolNames = uniqueArrayUnion(existing.mcpToolNames, incoming.mcpToolNames);
  return merged;
}

function syncRecordingFlow(ownerStorageKey, flowId, flow) {
  if (!ownerStorageKey || !flowId || !flow) {
    return Promise.resolve({ ok: false, error: 'INVALID_FLOW_SYNC' });
  }
  var queueKey = ownerStorageKey + '::' + flowId;
  var previous = flowRecordingFlowWriteQueues[queueKey] || Promise.resolve();
  var run = previous.catch(function () {}).then(function () {
    return readOwnerFlows(ownerStorageKey).then(function (flows) {
      flows[flowId] = mergeRecordedFlow(flows[flowId], flow, flowId);
      return writeOwnerFlows(ownerStorageKey, flows).then(function (result) {
        return result.ok ? { ok: true, flow: flows[flowId] } : result;
      });
    });
  });
  flowRecordingFlowWriteQueues[queueKey] = run.then(function () {}, function () {});
  return run;
}

function appendRecordToArchive(recordStorageKey, flowId, record) {
  if (!recordStorageKey || !record || !record.id) return Promise.resolve({ ok: false, error: 'INVALID_RECORD' });
  var previous = flowRecordArchiveWriteQueues[recordStorageKey] || Promise.resolve();
  var run = previous.catch(function () {}).then(function () {
    return readFlowRecordArchive(recordStorageKey).then(function (archive) {
      archive.schemaVersion = 1;
      archive.flowId = flowId;
      archive.recordsById[record.id] = sanitizeArchiveRecord(record);
      if (archive.order.indexOf(record.id) === -1) archive.order.push(record.id);
      return writeFlowRecordArchive(recordStorageKey, archive).then(function (result) {
        return result.ok ? { ok: true, warnings: result.warnings || [] } : result;
      });
    });
  });
  flowRecordArchiveWriteQueues[recordStorageKey] = run.then(function () {}, function () {});
  return run;
}

function createRecordingSessionFromMessage(message, sender) {
  var payload = message.payload || {};
  var tabId = sender.tab && sender.tab.id;
  var parsed = parseHttpUrl(payload.url);
  var hostname = payload.hostname || (parsed && parsed.hostname) || '';
  var flowId = payload.flowId || '';
  var session = {
    schemaVersion: FLOW_RECORDING_SCHEMA_VERSION,
    id: 'recording_session_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    flowId: flowId,
    rootTabId: tabId,
    rootOrigin: payload.origin || (parsed && parsed.origin) || '',
    rootHostname: hostname,
    ownerStorageKey: payload.ownerStorageKey || ('ai_req_flows_' + hostname),
    recordStorageKey: buildFlowRecordsKey(hostname, flowId),
    tabIds: [],
    tabMeta: {},
    pendingChildTabs: {},
    lastStepId: '',
    lastActionAt: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'recording'
  };
  addTabToSession(session, tabId, {
    role: 'root',
    origin: session.rootOrigin,
    hostname: hostname,
    url: payload.url || '',
    joinedAt: Date.now()
  });
  return session;
}

function buildRecordingSessionView(session, meta) {
  return {
    ok: true,
    recording: true,
    session: {
      id: session.id,
      flowId: session.flowId,
      rootHostname: session.rootHostname,
      ownerStorageKey: session.ownerStorageKey,
      recordStorageKey: session.recordStorageKey,
      lastStepId: session.lastStepId || '',
      lastActionAt: session.lastActionAt || 0,
      tabMeta: meta || null
    }
  };
}

function getSenderTabId(sender) {
  return sender && sender.tab ? normalizeTabId(sender.tab.id) : null;
}

function resolveSenderHttpContext(payload, sender) {
  payload = payload || {};
  var url = payload.url || (sender && sender.tab && sender.tab.url) || '';
  var parsed = parseHttpUrl(url);
  return {
    url: url,
    parsed: parsed,
    origin: payload.origin || (parsed && parsed.origin) || '',
    hostname: payload.hostname || (parsed && parsed.hostname) || ''
  };
}

function updateSessionTabMetaFromContext(session, tabId, context) {
  var tid = normalizeTabId(tabId);
  if (!session || tid === null) return false;
  if (!session.tabMeta) session.tabMeta = {};
  var key = String(tid);
  var meta = Object.assign({}, session.tabMeta[key] || {});
  meta.tabId = tid;
  if (context.url) meta.url = context.url;
  if (context.origin) meta.origin = context.origin;
  if (context.hostname) meta.hostname = context.hostname;
  session.tabMeta[key] = meta;
  return true;
}

function validateRecordingMessageSession(session, sender, payload, options) {
  options = options || {};
  payload = payload || {};
  if (!session) return { ok: false, error: 'NO_ACTIVE_SESSION' };
  if (options.requireFlowId !== false && payload.flowId && payload.flowId !== session.flowId) {
    return { ok: false, error: 'FLOW_ID_MISMATCH' };
  }
  if (options.requireFlowId === true && !payload.flowId) {
    return { ok: false, error: 'FLOW_ID_REQUIRED' };
  }
  var tabId = getSenderTabId(sender);
  if (options.requireTab !== false && !sessionHasTab(session, tabId)) {
    return { ok: false, error: 'TAB_NOT_IN_SESSION' };
  }
  if (options.requireHostname) {
    var context = resolveSenderHttpContext(payload, sender);
    if (!context.hostname || context.hostname !== session.rootHostname) {
      return { ok: false, error: 'HOSTNAME_MISMATCH' };
    }
    return { ok: true, tabId: tabId, context: context };
  }
  return { ok: true, tabId: tabId, context: resolveSenderHttpContext(payload, sender) };
}

function hasPendingChildTabs(session) {
  return !!(session && session.pendingChildTabs && Object.keys(session.pendingChildTabs).length > 0);
}

function validateRecordingTabHostname(session, tabId, url) {
  var parsed = parseHttpUrl(url);
  if (parsed) {
    return parsed.hostname === session.rootHostname;
  }
  var tid = normalizeTabId(tabId);
  var meta = session && session.tabMeta && tid !== null ? session.tabMeta[String(tid)] : null;
  return !!(meta && meta.hostname === session.rootHostname);
}

function validateRecordingPayloadPageHostname(session, tabId, payload) {
  payload = payload || {};
  if (payload.pageHostname) {
    return payload.pageHostname === session.rootHostname;
  }
  if (payload.pageUrl) {
    return validateRecordingTabHostname(session, tabId, payload.pageUrl);
  }
  var tid = normalizeTabId(tabId);
  var meta = session && session.tabMeta && tid !== null ? session.tabMeta[String(tid)] : null;
  return !!(meta && meta.hostname === session.rootHostname);
}

function broadcastRecordingStopped(tabIds, flowId) {
  return new Promise(function (resolve) {
    var ids = (tabIds || []).slice();
    if (!ids.length) {
      resolve();
      return;
    }
    var remaining = ids.length;
    ids.forEach(function (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'FLOW_RECORDING_STOPPED', flowId: flowId }, function () {
        if (chrome.runtime.lastError) {}
        remaining--;
        if (remaining === 0) resolve();
      });
    });
  });
}

function addChildTabToRecordingSession(session, tab, parsed, openerTabId) {
  if (!session || !tab || typeof tab.id === 'undefined' || !parsed) return false;
  if (parsed.hostname !== session.rootHostname) return false;
  return addTabToSession(session, tab.id, {
    role: 'child',
    openerTabId: normalizeTabId(openerTabId),
    origin: parsed.origin,
    hostname: parsed.hostname,
    url: tab.url || parsed.href,
    joinedAt: Date.now()
  });
}

function handleRecordingTabCreated(tab) {
  if (!tab || typeof tab.id === 'undefined' || typeof tab.openerTabId === 'undefined') return;
  updateRecordingSession(function (session) {
    if (!session || !sessionHasTab(session, tab.openerTabId)) return { skipSave: true };
    if (!session.pendingChildTabs) session.pendingChildTabs = {};
    var parsed = parseHttpUrl(tab.url);
    var changed = false;
    if (parsed) {
      changed = addChildTabToRecordingSession(session, tab, parsed, tab.openerTabId);
    } else {
      session.pendingChildTabs[String(tab.id)] = {
        openerTabId: normalizeTabId(tab.openerTabId),
        createdAt: Date.now(),
        url: tab.url || ''
      };
      changed = true;
    }
    return changed ? {} : { skipSave: true };
  }).catch(function () {});
}

function handleRecordingTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo || !changeInfo.url) return;
  updateRecordingSession(function (session) {
    if (!session) return { skipSave: true };
    var tid = normalizeTabId(tabId);
    var parsed = parseHttpUrl(changeInfo.url);
    var changed = false;
    var pending = session.pendingChildTabs && session.pendingChildTabs[String(tid)];

    if (pending && parsed) {
      delete session.pendingChildTabs[String(tid)];
      if (parsed.hostname === session.rootHostname) {
        changed = addChildTabToRecordingSession(session, tab || { id: tid, url: changeInfo.url }, parsed, pending.openerTabId) || changed;
      } else {
        changed = true;
      }
    } else if (pending) {
      pending.url = changeInfo.url;
      changed = true;
    }

    if (sessionHasTab(session, tid)) {
      updateSessionTabMetaFromContext(session, tid, {
        url: changeInfo.url,
        origin: parsed && parsed.origin,
        hostname: parsed && parsed.hostname
      });
      changed = true;
    }

    if (!session.tabIds || session.tabIds.length === 0) {
      return hasPendingChildTabs(session) ? {} : { clearSession: true };
    }
    return changed ? {} : { skipSave: true };
  }).catch(function () {});
}

function handleRecordingTabRemoved(tabId) {
  updateRecordingSession(function (session) {
    if (!session) return { skipSave: true };
    var hadTab = sessionHasTab(session, tabId);
    var hadPending = !!(session.pendingChildTabs && session.pendingChildTabs[String(normalizeTabId(tabId))]);
    if (!hadTab && !hadPending) return { skipSave: true };
    removeTabFromSession(session, tabId);
    if (!session.tabIds || session.tabIds.length === 0) {
      return hasPendingChildTabs(session) ? {} : { clearSession: true };
    }
    return {};
  }).catch(function () {});
}

chrome.runtime.onInstalled.addListener(function () {
  installMenus();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function () {
    installMenus();
  });
}

if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener(function (changeInfo) {
    AiRuntimeAuthSession.ensureRegistryLoaded().then(function () {
      return AiRuntimeAuthSession.mapCookieToRegisteredOrigins(
        changeInfo && changeInfo.cookie ? changeInfo.cookie : {}
      );
    }).then(function (affected) {
      affected.forEach(function (origin) {
        AiRuntimeAuthSession.markEpochUntrusted(origin);
        Promise.resolve().then(function () {
          return AiRuntimeAuthSession.bumpEpoch(
            origin,
            changeInfo && changeInfo.removed ? 'cookie_removed' : 'cookie_changed'
          );
        }).catch(function (error) {
          AiRuntimeAuthSession.markEpochUntrusted(origin);
          console.error(
            '[AI_REQ_ANALYZER][runtime-auth]',
            origin,
            error && error.code ? error.code : 'SESSION_EPOCH_UPDATE_FAILED'
          );
        });
      });
    }).catch(function (error) {
      console.error(
        '[AI_REQ_ANALYZER][runtime-auth]',
        '',
        error && error.code ? error.code : 'TARGET_REGISTRY_RESTORE_FAILED'
      );
    });
  });
}

function safeRuntimeAuthErrorCode(error, fallback) {
  var code = error && (error.code || error.errorCode)
    ? String(error.code || error.errorCode)
    : '';
  return /^[A-Z0-9_]{1,80}$/.test(code)
    ? code
    : (fallback || 'RUNTIME_AUTH_OPERATION_FAILED');
}

function reportRuntimeAuthListenerError(origin, error, fallback) {
  console.error(
    '[AI_REQ_ANALYZER][runtime-auth]',
    origin || '',
    safeRuntimeAuthErrorCode(error, fallback)
  );
}

if (chrome.tabs && chrome.tabs.onCreated) {
  chrome.tabs.onCreated.addListener(function (tab) {
    handleRecordingTabCreated(tab);
  });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    handleRecordingTabUpdated(tabId, changeInfo, tab);
    if (changeInfo && (changeInfo.status === 'complete' || changeInfo.url)) {
      refreshBadgeForTab(tab);
    }
    if (changeInfo && (changeInfo.status === 'loading' || changeInfo.url)) {
      Promise.resolve().then(function () {
        return AiRuntimeAuthSession.invalidateTab(tabId, 'tab_navigated');
      }).catch(function (error) {
        reportRuntimeAuthListenerError(
          '',
          error,
          'AUTH_TAB_INVALIDATION_FAILED'
        );
      });
    }
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    handleRecordingTabRemoved(tabId);
    if (disableRequestTimeouts[tabId]) {
      clearTimeout(disableRequestTimeouts[tabId]);
      delete disableRequestTimeouts[tabId];
    }
    Promise.resolve().then(function () {
      return AiRuntimeAuthSession.invalidateTab(tabId, 'tab_removed');
    }).catch(function (error) {
      reportRuntimeAuthListenerError(
        '',
        error,
        'AUTH_TAB_INVALIDATION_FAILED'
      );
    });
  });
}

if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(function (activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function (tab) {
      if (!chrome.runtime.lastError) refreshBadgeForTab(tab);
    });
  });
}

if (chrome.action && chrome.action.onClicked) {
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || typeof tab.id === 'undefined') return;
  var host = hostnameFromTabUrl(tab.url);
  if (!host) {
    try {
      chrome.action.setTitle({ tabId: tab.id, title: 'AI请求分析助手 · 当前页不可用' });
    } catch (e) {}
    return;
  }
  var key = extensionEnabledStorageKey(host);
  chrome.storage.local.get(key, function (items) {
    var currently = readEnabledFromItems(items, host);
    if (!currently) {
      var payload = {};
      payload[key] = true;
      chrome.storage.local.set(payload, function () {
        setActionBadgeForTab(tab.id, true);
        chrome.tabs.sendMessage(tab.id, {
          type: 'EXTENSION_SET_ENABLED',
          hostname: host,
          enabled: true,
          toast: true
        }).catch(function () {});
        broadcastEnabledToHostnameTabs(host, true);
      });
      return;
    }
    chrome.tabs.sendMessage(tab.id, {
      type: 'EXTENSION_REQUEST_DISABLE',
      hostname: host
    }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        var off = {};
        off[key] = false;
        chrome.storage.local.set(off, function () {
          broadcastEnabledToHostnameTabs(host, false);
        });
        return;
      }
      refreshBadgeForTab(tab);
      broadcastEnabledToHostnameTabs(host, false);
    });
    if (disableRequestTimeouts[tab.id]) clearTimeout(disableRequestTimeouts[tab.id]);
    disableRequestTimeouts[tab.id] = setTimeout(function () {
      chrome.storage.local.get(key, function (items2) {
        if (readEnabledFromItems(items2, host)) {
          var off2 = {};
          off2[key] = false;
          chrome.storage.local.set(off2, function () {
            broadcastEnabledToHostnameTabs(host, false);
          });
        }
      });
    }, 3000);
  });
});
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || typeof tab.id === 'undefined') return;
  var action = null;
  if (info.menuItemId === MENU_IDS.OPEN_PANEL) action = 'open_panel';
  else if (info.menuItemId === MENU_IDS.OPEN_CONFIG) action = 'open_config';
  else if (info.menuItemId === MENU_IDS.RESET_POS) action = 'reset_positions';
  else if (info.menuItemId === MENU_IDS.DIAG) action = 'diagnostics';
  if (!action) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'AI_REQ_ANALYZER_MENU',
    action: action
  }).catch(function () {});
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'EXTENSION_DISABLE_DONE') {
    var doneHost = message.hostname;
    if (doneHost) broadcastEnabledToHostnameTabs(doneHost, false);
    if (sender && sender.tab && typeof sender.tab.id !== 'undefined' && disableRequestTimeouts[sender.tab.id]) {
      clearTimeout(disableRequestTimeouts[sender.tab.id]);
      delete disableRequestTimeouts[sender.tab.id];
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'ENV_REPLAY_FETCH') {
    handleEnvReplayFetch(message.payload || {}).then(function (result) {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'FLOW_RECORDING_START') {
    updateRecordingSession(function () {
      var session = createRecordingSessionFromMessage(message, sender || {});
      if (!session.flowId || !session.rootHostname || !sessionHasTab(session, session.rootTabId)) {
        return { skipSave: true, response: { ok: false, error: 'INVALID_SESSION_START' } };
      }
      return {
        replaceSession: session,
        response: { ok: true, sessionId: session.id, session: session }
      };
    }).then(function (result) {
      if (result && result.response && result.saved !== false) {
        sendResponse(result.response);
        return;
      }
      sendResponse({ ok: false, sessionId: '', session: null, error: 'SAVE_SESSION_FAILED' });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.type === 'FLOW_RECORDING_GET_SESSION') {
    updateRecordingSession(function (session) {
      var payload = message.payload || {};
      var validation = validateRecordingMessageSession(session, sender, payload, {
        requireFlowId: false,
        requireHostname: true
      });
      if (!validation.ok) {
        return { skipSave: true, response: { ok: true, recording: false } };
      }
      updateSessionTabMetaFromContext(session, validation.tabId, validation.context);
      var meta = session.tabMeta && session.tabMeta[String(validation.tabId)];
      return { response: buildRecordingSessionView(session, meta) };
    }).then(function (result) {
      if (result && result.response && result.saved !== false) {
        sendResponse(result.response);
        return;
      }
      sendResponse({ ok: false, error: 'SAVE_SESSION_FAILED' });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.type === 'FLOW_RECORDING_SYNC_FLOW') {
    updateRecordingSession(function (session) {
      var payload = message.payload || {};
      var validation = validateRecordingMessageSession(session, sender, payload, { requireFlowId: true });
      if (!validation.ok) {
        return { skipSave: true, response: validation };
      }
      if (payload.ownerStorageKey && payload.ownerStorageKey !== session.ownerStorageKey) {
        return { skipSave: true, response: { ok: false, error: 'OWNER_STORAGE_KEY_MISMATCH' } };
      }
      return {
        skipSave: true,
        flowId: session.flowId,
        ownerStorageKey: session.ownerStorageKey,
        flow: payload.flow
      };
    }).then(function (result) {
      if (result && result.response) {
        sendResponse(result.response);
        return;
      }
      if (!result || !result.flow) {
        sendResponse({ ok: false, error: 'INVALID_FLOW_SYNC' });
        return;
      }
      syncRecordingFlow(result.ownerStorageKey, result.flowId, result.flow).then(function (syncResult) {
        sendResponse(syncResult);
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.type === 'FLOW_RECORDING_SYNC_STEP') {
    updateRecordingSession(function (session) {
      var payload = message.payload || {};
      var validation = validateRecordingMessageSession(session, sender, payload, { requireFlowId: true });
      if (!validation.ok) {
        return { skipSave: true, response: validation };
      }
      if (!validateRecordingTabHostname(session, validation.tabId, payload.url)) {
        return { skipSave: true, response: { ok: false, error: 'HOSTNAME_NOT_MATCHED' } };
      }
      var recordStep = payload.step || {};
      session.lastStepId = payload.lastStepId || payload.stepId || recordStep.id || session.lastStepId || '';
      session.lastActionAt = payload.actionAt || Date.now();
      updateSessionTabMetaFromContext(session, validation.tabId, validation.context);
      return {
        response: {
          ok: true,
          lastStepId: session.lastStepId,
          lastActionAt: session.lastActionAt
        }
      };
    }).then(function (result) {
      if (result && result.response) {
        if (result.saved === false && result.response.ok !== false) result.response.ok = false;
        sendResponse(result.response);
        return;
      }
      sendResponse({ ok: false, error: 'SAVE_SESSION_FAILED' });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.type === 'FLOW_RECORDING_SYNC_RECORD') {
    updateRecordingSession(function (session) {
      var payload = message.payload || {};
      var validation = validateRecordingMessageSession(session, sender, payload, { requireFlowId: true });
      if (!validation.ok) {
        return { skipSave: true, response: validation };
      }
      var record = payload.record || {};
      if (!validateRecordingPayloadPageHostname(session, validation.tabId, payload)) {
        return { skipSave: true, response: { ok: false, error: 'HOSTNAME_NOT_MATCHED' } };
      }
      return {
        skipSave: true,
        appendRecord: record,
        flowId: session.flowId,
        recordStorageKey: session.recordStorageKey
      };
    }).then(function (result) {
      if (result && result.response) {
        sendResponse(result.response);
        return;
      }
      if (!result || !result.appendRecord) {
        sendResponse({ ok: false, error: 'INVALID_RECORD' });
        return;
      }
      appendRecordToArchive(result.recordStorageKey, result.flowId, result.appendRecord).then(function (appendResult) {
        sendResponse(appendResult);
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.type === 'FLOW_RECORDING_STOP') {
    updateRecordingSession(function (session) {
      var payload = message.payload || {};
      if (!session) {
        return { skipSave: true, response: { ok: true, stopped: true } };
      }
      if (!payload.flowId) {
        return { skipSave: true, response: { ok: false, error: 'FLOW_ID_REQUIRED' } };
      }
      if (payload.flowId !== session.flowId) {
        return { skipSave: true, response: { ok: false, error: 'FLOW_ID_MISMATCH' } };
      }
      if (payload.flow) {
        return syncRecordingFlow(session.ownerStorageKey, session.flowId, payload.flow).then(function (syncResult) {
          if (!syncResult || !syncResult.ok) {
            return {
              skipSave: true,
              response: syncResult || { ok: false, error: 'FLOW_RECORDING_SYNC_FLOW_FAILED' }
            };
          }
          return {
            clearSession: true,
            tabIds: (session.tabIds || []).slice(),
            flowId: session.flowId,
            response: { ok: true, stopped: true }
          };
        });
      }
      return {
        clearSession: true,
        tabIds: (session.tabIds || []).slice(),
        flowId: session.flowId,
        response: { ok: true, stopped: true }
      };
    }).then(function (result) {
      if (result && result.tabIds) {
        broadcastRecordingStopped(result.tabIds, result.flowId).then(function () {
          sendResponse(result.response || { ok: true, stopped: true });
        });
        return;
      }
      sendResponse((result && result.response) || { ok: true, stopped: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.type === 'INJECT_PAGE_HOOK') {
    var injTabId = sender.tab && sender.tab.id;
    if (typeof injTabId === 'undefined') {
      return Promise.resolve({ ok: false, error: 'no sender.tab（内容脚本发往后台即可获得 tab）' });
    }
    return chrome.scripting
      .executeScript({
        target: { tabId: injTabId, allFrames: false },
        world: 'MAIN',
        files: ['content/page-hook.js']
      })
      .then(function () {
        return { ok: true };
      })
      .catch(function (err) {
        return {
          ok: false,
          error: err && err.message ? err.message : 'executeScript failed'
        };
      });
  }

  if (message.type === 'READ_PAGE_HOOK_INSTALLED') {
    var hookTid = sender.tab && sender.tab.id;
    if (typeof hookTid === 'undefined') {
      return Promise.resolve({ hooked: false, error: 'no tab id' });
    }
    return chrome.scripting
      .executeScript({
        target: { tabId: hookTid, allFrames: false },
        world: 'MAIN',
        func: function () {
          try {
            return !!window.__AI_REQ_ANALYZER_HOOKED__;
          } catch (e) {
            return false;
          }
        }
      })
      .then(function (results) {
        return {
          hooked: !!(results && results[0] && results[0].result)
        };
      })
      .catch(function (err) {
        return { hooked: false, error: err && err.message ? err.message : String(err) };
      });
  }

  if (message.type === 'MCP_START_HELPER') {
    var cfgPort = normalizeMcpPort(message.payload && message.payload.mcpPort);
    mcpState.serverPort = cfgPort;
    connectMcpHelper(function (result) {
      sendResponse(result);
    }, { port: cfgPort });
    return true;
  }

  if (message.type === 'MCP_STOP_HELPER') {
    disconnectMcpHelper();
    sendResponse({ ok: true, connected: false });
    return true;
  }

  if (message.type === 'MCP_SYNC_TOOLS') {
    syncToolsToHelper(function (result) {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'UPDATE_SITE_IDENTITY') {
    var apiOrigin = resolveSiteIdentityMessageOrigin(message);
    var pageOrigin = message.pageOrigin || '';
    var requestHeaders = message.requestHeaders || {};
    var senderTabId = sender && sender.tab ? sender.tab.id : undefined;
    var observationResult = Promise.resolve().then(function () {
      return AiRuntimeAuthSession.observeLiveAuth({
        apiOrigin: apiOrigin,
        tabId: senderTabId,
        requestHeaders: requestHeaders,
        observedAt: Date.now()
      });
    }).then(function (result) {
      if (result && result.ok) return null;
      if (result && result.skipped) {
        // Observation carried no reusable credential headers — surface this
        // to the panel instead of swallowing it as success.
        return result.errorCode || 'AUTH_OBSERVATION_SKIPPED';
      }
      return result && result.errorCode
        ? safeRuntimeAuthErrorCode(result, 'AUTH_OBSERVATION_FAILED')
        : 'AUTH_OBSERVATION_FAILED';
    }).catch(function (error) {
      var code = safeRuntimeAuthErrorCode(error, 'AUTH_OBSERVATION_FAILED');
      reportRuntimeAuthListenerError(apiOrigin, error, code);
      return code;
    });
    persistSiteIdentityUpdate(apiOrigin, pageOrigin, requestHeaders, function (result) {
      observationResult.then(function (observationErrorCode) {
        var response = Object.assign({}, result || {});
        response.observationErrorCode = observationErrorCode;
        sendResponse(response);
      });
    });
    return true;
  }

  if (message.type === 'RUNTIME_SAME_PATH_API_OBSERVED') {
    var samePathTabId = sender && sender.tab && sender.tab.id;
    AiRuntimeAuthSession.observeSamePathApi({
      tabId: samePathTabId,
      apiOrigin: message.apiOrigin,
      pathPatternKey: message.pathPatternKey ||
        AiSiteAffinity.buildPathPatternKey(message.method, message.url),
      observedAt: message.observedAt || Date.now()
    }).then(function (result) {
      sendResponse(result && result.ok ? { ok: true } : { ok: false });
    }).catch(function () {
      sendResponse({ ok: false });
    });
    return true;
  }

  if (message.type === 'MCP_GET_TOOLS_VIEW') {
    var siteFilterMv = message.siteFilter || 'all';
    var tabHostnameMv = message.currentTabHostname || '';
    chrome.storage.local.get(null, function (items) {
      var pack = mergeAllMcpToolsFromStorage(items);
      var merged = pack.merged;
      var mergedToolCount = Object.keys(merged).length;
      var mergedEnabledCount = 0;
      var mk;
      for (mk in merged) {
        if (!Object.prototype.hasOwnProperty.call(merged, mk)) continue;
        if (merged[mk].enabled !== false) mergedEnabledCount++;
      }
      var toolsOut;
      var hostByToolOut;
      if (siteFilterMv === 'all') {
        toolsOut = merged;
        hostByToolOut = pack.hostByTool;
      } else if (siteFilterMv === '__exclude_current__') {
        toolsOut = {};
        hostByToolOut = {};
        for (mk in merged) {
          if (!Object.prototype.hasOwnProperty.call(merged, mk)) continue;
          if (tabHostnameMv && pack.hostByTool[mk] === tabHostnameMv) continue;
          toolsOut[mk] = merged[mk];
          hostByToolOut[mk] = pack.hostByTool[mk];
        }
      } else {
        var siteKey = 'ai_req_mcp_tools_' + siteFilterMv;
        toolsOut = parseStoredTools(items[siteKey]);
        if (!toolsOut || typeof toolsOut !== 'object') toolsOut = {};
        hostByToolOut = {};
        var tk;
        for (tk in toolsOut) {
          if (Object.prototype.hasOwnProperty.call(toolsOut, tk)) {
            hostByToolOut[tk] = siteFilterMv;
          }
        }
      }
      var excludeCurrentRemainCount = mergedToolCount;
      if (tabHostnameMv && pack.hostByTool) {
        excludeCurrentRemainCount = 0;
        for (mk in merged) {
          if (!Object.prototype.hasOwnProperty.call(merged, mk)) continue;
          if (pack.hostByTool[mk] === tabHostnameMv) continue;
          excludeCurrentRemainCount++;
        }
      }
      var flowCtxCfg = parseExtensionConfigFromItems(items);
      appendFlowContextSystemTools(toolsOut, flowCtxCfg);
      var flowsById = {};
      var storageKeysMv = Object.keys(items || {});
      var fki;
      for (fki = 0; fki < storageKeysMv.length; fki++) {
        var fkey = storageKeysMv[fki];
        if (fkey.indexOf('ai_req_flows_') !== 0) continue;
        var fobj = parseStoredTools(items[fkey]);
        if (!fobj || typeof fobj !== 'object') continue;
        var fk = Object.keys(fobj);
        for (var ffi = 0; ffi < fk.length; ffi++) {
          var frec = fobj[fk[ffi]];
          if (!frec || !frec.id) continue;
          var existingFlow = flowsById[frec.id];
          if (!existingFlow) {
            flowsById[frec.id] = frec;
            continue;
          }
          var existingScore =
            ((existingFlow.steps || []).length) * 10 +
            ((existingFlow.verifiedRequestIds || []).length) * 4 +
            ((existingFlow.mcpToolNames || []).length) * 5;
          var nextScore =
            ((frec.steps || []).length) * 10 +
            ((frec.verifiedRequestIds || []).length) * 4 +
            ((frec.mcpToolNames || []).length) * 5;
          if (nextScore >= existingScore) flowsById[frec.id] = frec;
        }
      }
      var sysKeys = getFlowContextSystemToolNames(flowCtxCfg);
      for (var sk = 0; sk < sysKeys.length; sk++) {
        if (toolsOut[sysKeys[sk]]) hostByToolOut[sysKeys[sk]] = '(system)';
      }
      var viewEnabledCount = countEnabledMcpTools(toolsOut);
      sendResponse({
        ok: true,
        siteFilter: siteFilterMv,
        tools: toolsOut,
        hostByTool: hostByToolOut,
        flowsById: flowsById,
        hosts: pack.hosts,
        hostToolCounts: pack.hostToolCounts || {},
        hostEnabledCounts: pack.hostEnabledCounts || {},
        mergedToolCount: mergedToolCount,
        mergedEnabledCount: mergedEnabledCount,
        viewEnabledCount: viewEnabledCount,
        helperToolCount: mcpState.toolCount || 0,
        helperConnected: mcpState.helperConnected,
        httpReady: mcpState.httpReady,
        excludeCurrentRemainCount: excludeCurrentRemainCount,
        currentTabHostname: tabHostnameMv
      });
    });
    return true;
  }

  if (message.type === 'MCP_GET_FLOW_CONTEXT') {
    chrome.storage.local.get(null, function (items) {
      var args = {
        flowId: message.flowId || '',
        flowName: message.flowName || ''
      };
      var result = executeFlowContextSystemTool(FLOW_CONTEXT_DETAIL_TOOL, args, items);
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'MCP_GET_STATUS') {
    var statusPort = mcpState.serverPort || 9527;
    sendResponse({
      helperConnected: mcpState.helperConnected,
      httpReady: mcpState.httpReady,
      serverPort: statusPort,
      helperError: mcpState.helperError,
      httpError: mcpState.httpError,
      lastHealthAt: mcpState.lastHealthAt,
      toolCount: mcpState.toolCount,
      serverStarting: mcpState.serverStarting,
      callLogCount: mcpState.callLogs.length,
      mcpUrl: buildMcpUrl(statusPort)
    });
    return true;
  }

  if (message.type === 'MCP_GET_CALL_LOGS') {
    sendResponse({ logs: mcpState.callLogs });
    return true;
  }

  if (message.type === 'MCP_LIST_EXPORT_DIR') {
    var dpList = (message.dirPath || (message.payload && message.payload.dirPath) || '').trim();
    nmRpcExportInvoke('LIST_EXPORT_DIR', { dirPath: dpList }, sendResponse);
    return true;
  }

  if (message.type === 'MCP_READ_EXPORT_FILE') {
    var dpRead = (message.dirPath || (message.payload && message.payload.dirPath) || '').trim();
    var fnRead = message.fileName || (message.payload && message.payload.fileName) || '';
    nmRpcExportInvoke('READ_EXPORT_FILE', { dirPath: dpRead, fileName: fnRead }, sendResponse);
    return true;
  }

  if (message.type === 'MCP_WRITE_EXPORT_FILE') {
    var dpWrite = (message.dirPath || '').trim();
    var fnWrite = message.fileName || '';
    var txtWrite = typeof message.text === 'string' ? message.text : '';
    var encLen =
      typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(txtWrite).length
        : txtWrite.length;
    if (encLen > 1040000) {
      sendResponse({
        ok: false,
        error: '\u5BFC\u51FA\u5185\u5BB9\u8FC7\u5927\uFF08Native Messaging \u9650\u5236\uFF09\uFF0C\u8BF7\u6539\u7528\u6D4F\u89C8\u5668\u4E0B\u8F7D',
        tooLarge: true
      });
      return true;
    }
    nmRpcExportInvoke(
      'WRITE_EXPORT_FILE',
      { dirPath: dpWrite, fileName: fnWrite, text: txtWrite },
      sendResponse,
      60000
    );
    return true;
  }

  if (message.type === 'MCP_TOOL_TEST') {
    var testToolName = message.toolName;
    var testArgs = message.arguments || {};
    var testStartTime = Date.now();
    var senderTab = sender && sender.tab ? sender.tab : null;

    chrome.storage.local.get(null, async function (items) {
      if (
        (chrome.runtime && chrome.runtime.lastError) ||
        !items ||
        typeof items !== 'object'
      ) {
        sendResponse(buildMcpAuthError('AUTH_SOURCE_UNSAFE'));
        return;
      }
      try {
      var toolDef = null;
      var toolMeta = null;
      var matchedStorageHost = '';
      var storageKeys = Object.keys(items);
      for (var ki = 0; ki < storageKeys.length; ki++) {
        var key = storageKeys[ki];
        if (key.indexOf('ai_req_mcp_tools_') !== 0) continue;
        var hostname = key.substring('ai_req_mcp_tools_'.length);
        var toolsObj = parseStoredTools(items[key]);
        if (toolsObj && toolsObj[testToolName]) {
          toolDef = toolsObj[testToolName];
          toolMeta = toolDef._meta || {};
          matchedStorageHost = hostname;
          break;
        }
      }

      if (!toolDef) {
        sendResponse({ ok: false, error: 'Tool not found: ' + testToolName });
        return;
      }

      toolMeta = prepareToolMetaForRuntime(
        toolDef,
        toolMeta,
        items,
        matchedStorageHost
      );
        var prepared = await prepareMcpRuntimeExecution(
          'test_' + Date.now(),
          testToolName,
          toolMeta,
          testArgs,
          matchedStorageHost,
          senderTab && senderTab.id
        );
        var result = prepared.ok
          ? await dispatchPreparedMcpExecution(prepared)
          : prepared;
        addMcpCallLog({
          timestamp: Date.now(),
          toolName: testToolName,
          argsSummary: summarizeMcpArguments(testArgs),
          status: result.status || 0,
          duration: Date.now() - testStartTime,
          proxyMode: result.proxyMode || 'none',
          authSource: prepared.ok
            ? prepared.resolution.authSource
            : (result.authSource || 'none'),
          sessionEpoch: prepared.ok
            ? prepared.resolution.sessionEpoch
            : Number(result.sessionEpoch || 0),
          dispatchState: result.dispatchState ||
            (result.requestDispatched === false
              ? 'pre_dispatch'
              : 'completed'),
          requestDispatched: !!result.requestDispatched,
          retryable: !!result.retryable,
          error: result.errorCode || result.error || null
        });
        sendResponse(result);
      } catch (error) {
        var safeError = buildMcpAuthError(
          safeRuntimeAuthErrorCode(error, 'AUTH_SOURCE_UNSAFE')
        );
        addMcpCallLog({
          timestamp: Date.now(),
          toolName: testToolName,
          argsSummary: summarizeMcpArguments(testArgs),
          status: 0,
          duration: Date.now() - testStartTime,
          proxyMode: 'none',
          authSource: 'none',
          sessionEpoch: 0,
          dispatchState: 'pre_dispatch',
          requestDispatched: false,
          retryable: true,
          error: safeError.errorCode
        });
        sendResponse(safeError);
      }
    });

    return true;
  }

  if (message.type !== 'AI_CHAT_COMPLETIONS') return;

  var p = message.payload || {};
  var url = p.url;
  var apiKey = p.apiKey;
  var model = p.model;
  var messages = p.messages;
  var temperature = p.temperature;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      temperature: temperature
    })
  })
    .then(function (res) {
      return res.text().then(function (text) {
        return { ok: res.ok, status: res.status, text: text };
      });
    })
    .then(function (r) {
      try {
        var data = JSON.parse(r.text);
        if (data.choices && data.choices[0] && data.choices[0].message) {
          sendResponse({
            ok: true,
            content: data.choices[0].message.content
          });
        } else {
          sendResponse({
            ok: false,
            error: 'AI返回格式异常: ' + r.text
          });
        }
      } catch (e) {
        sendResponse({
          ok: false,
          error: '解析AI响应失败: ' + e.message + ' · ' + (r.text || '').slice(0, 200)
        });
      }
    })
    .catch(function (err) {
      sendResponse({
        ok: false,
        error: 'AI请求失败: ' + (err && err.message ? err.message : String(err))
      });
    });

  return true;
});

var mcpState = {
  helperConnected: false,
  httpReady: false,
  helperPort: null,
  helperError: null,
  httpError: null,
  lastHealthAt: 0,
  toolCount: 0,
  serverStarting: false,
  helperStopping: false,
  tools: {},
  callLogs: [],
  pendingCalls: {},
  serverPort: 9527
};

function normalizeMcpPort(n) {
  var p = parseInt(n, 10);
  if (!isFinite(p) || p < 1 || p > 65535) return 9527;
  return p;
}

function buildMcpUrl(port) {
  return 'http://127.0.0.1:' + normalizeMcpPort(port) + '/mcp';
}

function probeMcpHealth(port, callback) {
  var schedule = [200, 500, 1000];
  var idx = 0;

  function attempt() {
    fetch('http://127.0.0.1:' + port + '/health')
      .then(function (res) {
        return res.json().then(function (data) {
          if (res.ok && data && data.ok) {
            callback({
              ok: true,
              tools: typeof data.tools === 'number' ? data.tools : 0,
              port: data.port || port
            });
          } else {
            retryOrFail('invalid health response');
          }
        });
      })
      .catch(function (err) {
        retryOrFail(err && err.message ? err.message : 'connection refused');
      });
  }

  function retryOrFail(errMsg) {
    idx++;
    if (idx >= schedule.length) {
      callback({ ok: false, error: 'HTTP 健康检查失败: ' + errMsg });
      return;
    }
    setTimeout(attempt, schedule[idx]);
  }

  setTimeout(attempt, schedule[0]);
}

/** LIST_EXPORT_DIR / READ_EXPORT_FILE / WRITE_EXPORT_FILE Native Messaging RPC pending by requestId */
var nmExportRpcPending = {};

function flushNmExportRpcPending(reason) {
  var rid;
  for (rid in nmExportRpcPending) {
    if (!nmExportRpcPending.hasOwnProperty(rid)) continue;
    var p = nmExportRpcPending[rid];
    clearTimeout(p.timer);
    if (!p.done) {
      p.done = true;
      try {
        p.sendResponse({ ok: false, error: reason || 'Native Messaging \u5DF2\u65AD\u5F00' });
      } catch (eSr) {}
    }
    delete nmExportRpcPending[rid];
  }
}

function nmRpcExportInvoke(nmType, bodyObj, sendResponse, timeoutMs) {
  var tm = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 15000;
  if (!mcpState.helperPort || !mcpState.helperConnected) {
    sendResponse({ ok: false, error: 'MCP \u52A9\u624B\u672A\u8FDE\u63A5\uFF0C\u8BF7\u5148\u542F\u52A8' });
    return;
  }
  var requestId = 'ex_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  var timer = setTimeout(function () {
    var p = nmExportRpcPending[requestId];
    if (!p || p.done) return;
    p.done = true;
    delete nmExportRpcPending[requestId];
    sendResponse({ ok: false, error: 'Native Messaging \u8D85\u65F6' });
  }, tm);
  nmExportRpcPending[requestId] = { timer: timer, sendResponse: sendResponse, done: false };
  try {
    var payload = { type: nmType, requestId: requestId };
    var k;
    for (k in bodyObj) {
      if (Object.prototype.hasOwnProperty.call(bodyObj, k)) payload[k] = bodyObj[k];
    }
    mcpState.helperPort.postMessage(payload);
  } catch (ex) {
    clearTimeout(timer);
    delete nmExportRpcPending[requestId];
    sendResponse({ ok: false, error: ex && ex.message ? ex.message : String(ex) });
  }
}

function parseStoredTools(toolsVal) {
  if (!toolsVal) return null;
  if (typeof toolsVal === 'string') {
    try {
      return JSON.parse(toolsVal);
    } catch (e) {
      return null;
    }
  }
  if (typeof toolsVal === 'object') return toolsVal;
  return null;
}

function countEnabledMcpTools(toolsObj) {
  var n = 0;
  var keys = Object.keys(toolsObj || {});
  for (var i = 0; i < keys.length; i++) {
    var t = toolsObj[keys[i]];
    if (t && t.enabled !== false) n++;
  }
  return n;
}

/** 与 syncToolsToHelper 相同的合并顺序（storage key 遍历顺序后者覆盖同名工具） */
function mergeAllMcpToolsFromStorage(items) {
  var allTools = {};
  var hostByTool = {};
  var hostsObj = {};
  var hostToolCounts = {};
  var hostEnabledCounts = {};
  var storageKeys = Object.keys(items || {});
  var ki;
  for (ki = 0; ki < storageKeys.length; ki++) {
    var key = storageKeys[ki];
    if (key.indexOf('ai_req_mcp_tools_') !== 0) continue;
    var hostname = key.substring('ai_req_mcp_tools_'.length);
    hostsObj[hostname] = true;
    var toolsObj = parseStoredTools(items[key]);
    if (!toolsObj || typeof toolsObj !== 'object') {
      hostToolCounts[hostname] = 0;
      hostEnabledCounts[hostname] = 0;
      continue;
    }
    hostToolCounts[hostname] = Object.keys(toolsObj).length;
    hostEnabledCounts[hostname] = countEnabledMcpTools(toolsObj);
    var tKeys = Object.keys(toolsObj);
    var ti;
    for (ti = 0; ti < tKeys.length; ti++) {
      var tn = tKeys[ti];
      allTools[tn] = toolsObj[tn];
      hostByTool[tn] = hostname;
    }
  }
  return {
    merged: allTools,
    hostByTool: hostByTool,
    hosts: Object.keys(hostsObj).sort(),
    hostToolCounts: hostToolCounts,
    hostEnabledCounts: hostEnabledCounts
  };
}

function connectMcpHelper(onDone, options) {
  options = options || {};
  var targetPort = normalizeMcpPort(options.port != null ? options.port : mcpState.serverPort);
  mcpState.serverPort = targetPort;
  var settled = false;
  var connectTimeout = null;
  var startServerTimeout = null;
  var awaitingServerStart = false;

  function finish(result) {
    if (settled) return;
    settled = true;
    if (connectTimeout) clearTimeout(connectTimeout);
    if (startServerTimeout) clearTimeout(startServerTimeout);
    mcpState.serverStarting = false;
    if (typeof onDone === 'function') onDone(result);
  }

  function beginStartServer() {
    awaitingServerStart = true;
    mcpState.serverStarting = true;
    try {
      mcpState.helperPort.postMessage({ type: 'START_SERVER', port: targetPort });
    } catch (eStart) {
      mcpState.helperError = eStart && eStart.message ? eStart.message : 'START_SERVER 发送失败';
      finish({ ok: false, connected: false, error: mcpState.helperError });
      return;
    }
    startServerTimeout = setTimeout(function () {
      if (settled) return;
      mcpState.httpReady = false;
      mcpState.httpError = '启动 HTTP 服务超时';
      finish({ ok: false, connected: false, error: mcpState.httpError });
    }, 3000);
  }

  function onServerStarted(msg) {
    if (settled || !awaitingServerStart) return;
    if (startServerTimeout) clearTimeout(startServerTimeout);
    awaitingServerStart = false;
    mcpState.serverPort = normalizeMcpPort(msg.port != null ? msg.port : targetPort);
    probeMcpHealth(mcpState.serverPort, function (health) {
      if (health.ok) {
        mcpState.httpReady = true;
        mcpState.httpError = null;
        mcpState.toolCount = health.tools;
        mcpState.lastHealthAt = Date.now();
        syncToolsToHelper();
        finish({
          ok: true,
          connected: true,
          httpReady: true,
          serverPort: mcpState.serverPort,
          mcpUrl: buildMcpUrl(mcpState.serverPort)
        });
      } else {
        mcpState.httpReady = false;
        mcpState.httpError = health.error || 'HTTP 健康检查失败';
        finish({ ok: false, connected: false, httpReady: false, error: mcpState.httpError });
      }
    });
  }

  function onServerStartFailed(msg) {
    if (settled || !awaitingServerStart) return;
    if (startServerTimeout) clearTimeout(startServerTimeout);
    awaitingServerStart = false;
    mcpState.httpReady = false;
    mcpState.httpError = msg.error || 'HTTP 服务启动失败';
    finish({ ok: false, connected: false, error: mcpState.httpError });
  }

  disconnectMcpHelper();
  mcpState.helperConnected = false;
  mcpState.httpReady = false;
  mcpState.httpError = null;
  mcpState.helperError = null;
  mcpState.helperStopping = false;
  mcpState.serverStarting = true;

  try {
    mcpState.helperPort = chrome.runtime.connectNative('com.aireq.mcp_helper');
  } catch (e) {
    mcpState.helperConnected = false;
    mcpState.serverStarting = false;
    mcpState.helperError = e && e.message ? e.message : 'Native Messaging Host 启动失败';
    finish({ ok: false, connected: false, error: mcpState.helperError });
    return;
  }

  connectTimeout = setTimeout(function () {
    if (settled) return;
    mcpState.helperConnected = false;
    mcpState.serverStarting = false;
    mcpState.helperError = 'Native Messaging Host 未响应，请确认已执行 install.mjs 并重启浏览器';
    disconnectMcpHelper();
    finish({ ok: false, connected: false, error: mcpState.helperError });
  }, 2000);

  mcpState.helperPort.onMessage.addListener(function (msg) {
    if (
      msg &&
      msg.requestId &&
      (msg.type === 'LIST_EXPORT_DIR_RESULT' ||
        msg.type === 'READ_EXPORT_FILE_RESULT' ||
        msg.type === 'WRITE_EXPORT_FILE_RESULT')
    ) {
      var pend = nmExportRpcPending[msg.requestId];
      if (pend && !pend.done) {
        clearTimeout(pend.timer);
        pend.done = true;
        delete nmExportRpcPending[msg.requestId];
        if (msg.type === 'LIST_EXPORT_DIR_RESULT') {
          pend.sendResponse({ ok: !!msg.ok, files: msg.files, error: msg.error });
        } else if (msg.type === 'READ_EXPORT_FILE_RESULT') {
          pend.sendResponse({ ok: !!msg.ok, text: msg.text, error: msg.error });
        } else {
          pend.sendResponse({ ok: !!msg.ok, savedPath: msg.savedPath, error: msg.error });
        }
      }
      return;
    }
    if (msg && msg.type === 'PONG') {
      if (connectTimeout) clearTimeout(connectTimeout);
      mcpState.helperConnected = true;
      mcpState.helperError = null;
      beginStartServer();
      return;
    }
    if (msg && msg.type === 'SERVER_STARTED') {
      onServerStarted(msg);
      return;
    }
    if (msg && msg.type === 'SERVER_START_FAILED') {
      onServerStartFailed(msg);
      return;
    }
    handleHelperMessage(msg);
  });

  mcpState.helperPort.onDisconnect.addListener(function () {
    var lastError = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
    flushNmExportRpcPending(lastError || 'Native Messaging \u5DF2\u65AD\u5F00');
    mcpState.helperConnected = false;
    mcpState.httpReady = false;
    mcpState.helperPort = null;
    mcpState.serverStarting = false;
    if (mcpState.helperStopping) {
      mcpState.helperStopping = false;
      mcpState.helperError = null;
      finish({ ok: false, connected: false, error: null });
      return;
    }
    if (!settled) {
      mcpState.helperError = lastError || 'Native Messaging Host 已断开';
      finish({ ok: false, connected: false, error: mcpState.helperError });
    }
  });

  try {
    mcpState.helperPort.postMessage({ type: 'PING' });
  } catch (e2) {
    mcpState.helperConnected = false;
    mcpState.serverStarting = false;
    mcpState.helperError = e2 && e2.message ? e2.message : 'Native Messaging Host 通信失败';
    disconnectMcpHelper();
    finish({ ok: false, connected: false, error: mcpState.helperError });
  }
}

function disconnectMcpHelper() {
  flushNmExportRpcPending('Native Messaging \u5DF2\u65AD\u5F00');
  if (mcpState.helperPort) {
    mcpState.helperStopping = true;
    try {
      mcpState.helperPort.postMessage({ type: 'STOP_SERVER' });
    } catch (eStop) {}
    try {
      mcpState.helperPort.postMessage({ type: 'SHUTDOWN' });
    } catch (e) {}
    mcpState.helperPort.disconnect();
    mcpState.helperPort = null;
  }
  mcpState.helperConnected = false;
  mcpState.httpReady = false;
  mcpState.httpError = null;
  mcpState.lastHealthAt = 0;
  mcpState.toolCount = 0;
  mcpState.serverStarting = false;
  mcpState.helperError = null;
}

function handleHelperMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'CALL_REQUEST') {
    handleMcpToolCall(msg.callId, msg.toolName, msg.arguments || {});
  }
}

/**
 * 页面内容脚本发起 fetch 必须与标签页同源（或目标接口允许 CORS）。
 * 工具元数据里的 origin 常为 uiless-devops 等子域，与用户所在 devops.aliyun.com 不一致时会 Failed to fetch。
 * Projex 接口路径一般为 /projex/...，可在主域同源下发。
 */
function rewriteMcpProxyUrlForTab(tab, fullUrl) {
  try {
    var tabUrl = new URL(tab.url);
    var req = new URL(fullUrl);
    if (req.pathname.indexOf('/projex/') < 0) return fullUrl;
    if (req.origin === tabUrl.origin) return fullUrl;
    var tabHost = tabUrl.hostname;
    var tabOk =
      tabHost === 'devops.aliyun.com' ||
      tabHost.endsWith('.devops.aliyun.com');
    if (!tabOk) return fullUrl;
    return tabUrl.origin + req.pathname + req.search + (req.hash || '');
  } catch (e) {
    return fullUrl;
  }
}

/** 依次尝试多个页面 origin，解决工具 _meta.origin 与用户当前标签 hostname 不一致时 tabs.query 匹配不到的问题（如云效主站 vs uiless 子域）。 */
function findBestTabForProxy(resolvedOrigin, fullUrl, pathname, pageOrigins) {
  var list = [];
  function addOriginCandidate(o) {
    var b = String(o || '').trim().replace(/\/+$/, '');
    if (!b || !/^https?:\/\//i.test(b)) return;
    if (list.indexOf(b) < 0) list.push(b);
  }
  addOriginCandidate(resolvedOrigin);
  try {
    addOriginCandidate(new URL(fullUrl).origin);
  } catch (e0) {}
  var pathStr = String(pathname || '');
  var fullStr = String(fullUrl || '');
  if (pathStr.indexOf('/projex/') >= 0 || fullStr.indexOf('/projex/') >= 0) {
    addOriginCandidate('https://devops.aliyun.com');
  }
  if (pageOrigins && pageOrigins.length) {
    for (var pi = 0; pi < pageOrigins.length; pi++) {
      addOriginCandidate(pageOrigins[pi]);
    }
  }
  function chain(i) {
    if (i >= list.length) return Promise.resolve(null);
    return findTargetTab(list[i]).then(function (tab) {
      return tab || chain(i + 1);
    });
  }
  return chain(0);
}

function findTargetTab(origin) {
  return findAllTabsForProxy(origin, []).then(function (tabs) {
    if (!tabs.length) return null;
    tabs.sort(function (a, b) {
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    return tabs[0];
  });
}

function findAllTabsForProxy(origin, pageOrigins) {
  var origins = [];
  [origin].concat(Array.isArray(pageOrigins) ? pageOrigins : []).forEach(
    function (value) {
      try {
        var parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
        if (!parsed.hostname || parsed.origin === 'null') return;
        if (origins.indexOf(parsed.origin) < 0) origins.push(parsed.origin);
      } catch (_error) {}
    }
  );
  return Promise.all(origins.map(function (candidateOrigin) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ url: candidateOrigin + '/*' }, function (tabs) {
        var lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          var error = new Error('runtime auth tab query failed');
          error.code = 'AUTH_TAB_QUERY_FAILED';
          reject(error);
          return;
        }
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    });
  })).then(function (groups) {
    var seen = Object.create(null);
    var candidates = [];
    groups.forEach(function (tabs) {
      tabs.forEach(function (tab) {
        if (!tab || typeof tab.id !== 'number' || seen[tab.id]) return;
        seen[tab.id] = true;
        candidates.push(tab);
      });
    });
    return candidates;
  });
}

function findTabsForSiteAffinity(toolMeta) {
  var meta = toolMeta || {};
  var hosts = AiSiteAffinity.collectRecordedHostnames(meta);
  var siteRoot = AiSiteAffinity.resolveTrustedSiteRoot(meta);
  var urlPatterns = [];
  hosts.forEach(function (host) {
    if (!host) return;
    urlPatterns.push('http://' + host + '/*');
    urlPatterns.push('https://' + host + '/*');
  });
  if (siteRoot) {
    urlPatterns.push('http://*.' + siteRoot + '/*');
    urlPatterns.push('https://*.' + siteRoot + '/*');
    urlPatterns.push('http://' + siteRoot + '/*');
    urlPatterns.push('https://' + siteRoot + '/*');
  }

  function filterAffinityTabs(tabs) {
    var seen = Object.create(null);
    var list = [];
    (tabs || []).forEach(function (tab) {
      if (!tab || typeof tab.id !== 'number' || seen[tab.id]) return;
      if (!tab.url) return;
      try {
        var u = new URL(tab.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        var host = u.hostname.toLowerCase();
        if (hosts.indexOf(host) < 0 &&
            !(siteRoot && AiSiteAffinity.sameSiteRoot(host, siteRoot))) {
          return;
        }
        seen[tab.id] = true;
        list.push(tab);
      } catch (_e) {}
    });
    return list;
  }

  return new Promise(function (resolve, reject) {
    function finishQuery(err, tabs) {
      if (err) {
        reject(err);
        return;
      }
      resolve(filterAffinityTabs(tabs));
    }
    if (urlPatterns.length) {
      chrome.tabs.query({ url: urlPatterns }, function (patternTabs) {
        if (chrome.runtime && chrome.runtime.lastError) {
          // Fall back to full scan when URL filter is rejected.
          chrome.tabs.query({}, function (allTabs) {
            if (chrome.runtime && chrome.runtime.lastError) {
              var err = new Error(
                chrome.runtime.lastError.message || 'tab query failed'
              );
              err.code = 'AUTH_TAB_QUERY_FAILED';
              finishQuery(err, null);
              return;
            }
            finishQuery(null, allTabs);
          });
          return;
        }
        if (patternTabs && patternTabs.length) {
          finishQuery(null, patternTabs);
          return;
        }
        chrome.tabs.query({}, function (allTabs) {
          if (chrome.runtime && chrome.runtime.lastError) {
            var err2 = new Error(
              chrome.runtime.lastError.message || 'tab query failed'
            );
            err2.code = 'AUTH_TAB_QUERY_FAILED';
            finishQuery(err2, null);
            return;
          }
          finishQuery(null, allTabs);
        });
      });
      return;
    }
    chrome.tabs.query({}, function (allTabs) {
      if (chrome.runtime && chrome.runtime.lastError) {
        var err3 = new Error(
          chrome.runtime.lastError.message || 'tab query failed'
        );
        err3.code = 'AUTH_TAB_QUERY_FAILED';
        finishQuery(err3, null);
        return;
      }
      finishQuery(null, allTabs);
    });
  });
}

function resolveToolOrigin(toolMeta, matchedStorageHost, preferredTab) {
  var origin = (toolMeta && toolMeta.origin) || '';
  if (/^https?:\/\//i.test(origin)) return origin;
  if (preferredTab && preferredTab.url) {
    try {
      return new URL(preferredTab.url).origin;
    } catch (eTab) {}
  }
  if (matchedStorageHost) return 'https://' + matchedStorageHost;
  return '';
}

function resolveSiteIdentityMessageOrigin(message) {
  var payload = message || {};
  function normalizeHttpOrigin(value) {
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (!parsed.hostname || parsed.origin === 'null') return '';
      return parsed.origin;
    } catch (e) {
      return '';
    }
  }
  if (payload.apiOrigin) {
    return normalizeHttpOrigin(payload.apiOrigin);
  }
  if (payload.apiHostname) {
    return normalizeHttpOrigin('https://' + payload.apiHostname);
  }
  return '';
}

function sendMcpProxyToTab(tabId, proxyPayload, callback) {
  chrome.tabs.sendMessage(tabId, { type: 'MCP_PROXY_REQUEST', payload: proxyPayload }, function (response) {
    var lastErr = chrome.runtime.lastError;
    if (lastErr) {
      callback(null, lastErr.message || 'content script 无响应');
      return;
    }
    if (!response) {
      callback(null, 'No response from content script');
      return;
    }
    callback(response, null);
  });
}

function buildMcpProxyPayload(
  callId,
  toolName,
  toolMeta,
  toolArguments,
  executionHeaders,
  authBundle,
  operationClass
) {
  var parted = partitionMcpToolArguments(toolMeta, toolArguments || {});
  var pathname = parted.pathname;
  var method = toolMeta.method || 'GET';
  var execHeaders = executionHeaders &&
    typeof executionHeaders === 'object'
    ? executionHeaders
    : {};
  var queryString = '';
  var bodyData = {};
  var argKeys = Object.keys(parted.restArgs);
  var ai;
  for (ai = 0; ai < argKeys.length; ai++) {
    var argKey = argKeys[ai];
    if (argKey.charAt(0) === '_') continue;
    var isInQuery = toolMeta.queryParams && toolMeta.queryParams.indexOf(argKey) >= 0;
    if (isInQuery || method.toUpperCase() === 'GET') {
      queryString += (queryString ? '&' : '?') + encodeURIComponent(argKey) + '=' + encodeURIComponent(String(parted.restArgs[argKey]));
    } else {
      bodyData[argKey] = parted.restArgs[argKey];
    }
  }
  var normalizedBody = normalizeMcpRequestBody(bodyData);
  return {
    pathname: pathname,
    method: method,
    execHeaders: execHeaders,
    bodyData: normalizedBody,
    queryString: queryString,
    payload: {
      callId: callId,
      toolName: toolName,
      url: '',
      method: method,
      headers: execHeaders,
      authBundle: authBundle || {},
      operationClass: operationClass || 'write_sensitive',
      body: normalizedBody,
      timeout: 30000
    }
  };
}

function fallbackFetch(url, method, headers, body, credentialsMode) {
  var fetchHeaders = {};
  if (headers && typeof headers === 'object') {
    var hKeys = Object.keys(headers);
    for (var hi = 0; hi < hKeys.length; hi++) {
      fetchHeaders[hKeys[hi]] = headers[hKeys[hi]];
    }
  }
  // Bearer/token auth already carries Authorization. Using credentials:include
  // can Set-Cookie from the response, which bumps sessionEpoch and wipes the
  // in-memory live token — breaking the next MCP call in the same flow.
  var credentials = credentialsMode === 'omit' ||
    credentialsMode === 'same-origin' ||
    credentialsMode === 'include'
    ? credentialsMode
    : 'include';
  var fetchOpts = {
    method: method || 'GET',
    headers: fetchHeaders,
    credentials: credentials,
    redirect: 'manual'
  };
  if (method && method.toUpperCase() !== 'GET' && body != null) {
    var normalizedBody = normalizeMcpRequestBody(body);
    var hasBody = Array.isArray(normalizedBody)
      ? normalizedBody.length > 0
      : (typeof normalizedBody === 'object' ? Object.keys(normalizedBody).length > 0 : !!normalizedBody);
    if (hasBody) {
      fetchOpts.body = typeof normalizedBody === 'string' ? normalizedBody : JSON.stringify(normalizedBody);
      if (!fetchHeaders['Content-Type']) {
        fetchHeaders['Content-Type'] = 'application/json';
      }
    }
  }
  return fetch(url, fetchOpts).then(function (res) {
    return res.text().then(function (text) {
      var resHeaders = {};
      res.headers.forEach(function (val, key) {
        resHeaders[key] = val;
      });
      return {
        ok: res.ok,
        status: res.status,
        headers: resHeaders,
        body: text,
        proxyMode: 'fallback'
      };
    });
  });
}

// Attach the real session epoch to error details so logs and MCP error
// payloads stop reporting the meaningless default 0.
async function withSessionEpoch(details, origin) {
  var result = details && typeof details === 'object' ? details : {};
  var normalized = '';
  try {
    var parsed = new URL(origin);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname
    ) {
      normalized = parsed.origin;
    }
  } catch (_parseError) {}
  if (!normalized) return result;
  try {
    await AiRuntimeAuthSession.ensureEpochLoaded(normalized);
    if (AiRuntimeAuthSession.isEpochTrusted(normalized)) {
      result.sessionEpoch = AiRuntimeAuthSession.getEpoch(normalized);
    }
  } catch (_epochError) {}
  return result;
}

function buildMcpAuthError(errorCode, details) {  var source = details && typeof details === 'object' ? details : {};
  var code = safeRuntimeAuthErrorCode(
    { errorCode: errorCode },
    'AUTH_SOURCE_UNSAFE'
  );
  var messages = {
    AUTH_TAB_REQUIRED: '请打开并登录目标站点后重试。',
    AUTH_COOKIE_MISSING: '当前浏览器没有目标站点 Cookie。',
    AUTH_SESSION_MISSING: '未获取到当前页面的实时登录凭据。若目标站点当前使用 Cookie 会话，可在入参加 __authMode: \'cookie\' 后重试。',
    AUTH_REJECTED: '服务端拒绝了当前浏览器会话。',
    AUTH_CONTEXT_STALE: '检测到账号会话已变化，请重新发起操作。',
    AUTH_ACCOUNT_AMBIGUOUS: '存在多个账号上下文，请从候选列表中选择目标页面后以 __authTabId 重试。',
    AUTH_SOURCE_UNSAFE: '只能取得录制时的旧凭据，已拒绝执行。'
  };
  var result = {
    ok: false,
    status: Number(source.status || 0),
    errorCode: code,
    error: messages[code] || '运行时鉴权失败。',
    proxyMode: source.proxyMode || 'none',
    authSource: source.authSource || 'none',
    sessionEpoch: Number(source.sessionEpoch || 0),
    dispatchState: Object.prototype.hasOwnProperty.call(source, 'dispatchState')
      ? source.dispatchState
      : 'pre_dispatch',
    requestDispatched: Object.prototype.hasOwnProperty.call(source, 'requestDispatched')
      ? !!source.requestDispatched
      : false,
    retryable: Object.prototype.hasOwnProperty.call(source, 'retryable')
      ? !!source.retryable
      : true
  };
  if (Array.isArray(source.candidates) && source.candidates.length) {
    result.candidates = source.candidates;
    result.selectionHint =
      '多个账号上下文：请选择一个候选页面，将其 tabId 作为 __authTabId 参数加入工具入参后重试。';
  }
  return result;
}

function summarizeMcpArguments(toolArguments) {
  var source = toolArguments && typeof toolArguments === 'object'
    ? toolArguments
    : {};
  var summary = {};
  Object.keys(source).sort().forEach(function (key) {
    var value = source[key];
    summary[key] = value === null
      ? 'null'
      : (Array.isArray(value) ? 'array' : typeof value);
  });
  return JSON.stringify(summary).substring(0, 200);
}

function finishMcpToolCall(
  callId,
  toolName,
  toolArguments,
  startTime,
  result,
  resolution
) {
  var safeResult = result && typeof result === 'object'
    ? result
    : buildMcpAuthError('AUTH_SOURCE_UNSAFE');
  var authDetails = resolution && typeof resolution === 'object'
    ? resolution
    : safeResult;
  safeResult.callId = callId;
  addMcpCallLog({
    timestamp: Date.now(),
    toolName: toolName,
    argsSummary: summarizeMcpArguments(toolArguments),
    status: safeResult.status || 0,
    duration: Date.now() - startTime,
    proxyMode: safeResult.proxyMode || 'none',
    authSource: authDetails.authSource || 'none',
    authModeOverride: authDetails.authModeOverride || '',
    sessionEpoch: Number(authDetails.sessionEpoch || 0),
    dispatchState: safeResult.dispatchState ||
      (safeResult.requestDispatched === false ? 'pre_dispatch' : 'completed'),
    requestDispatched: !!safeResult.requestDispatched,
    retryable: !!safeResult.retryable,
    error: safeResult.errorCode || safeResult.error || null
  });
  if (mcpState.helperPort && mcpState.helperConnected) {
    mcpState.helperPort.postMessage({
      type: 'CALL_RESULT',
      callId: callId,
      result: safeResult
    });
  }
  return safeResult;
}

function safeInitiatorTabId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return undefined;
}

function decodeMcpPathForSafety(pathname) {
  var decoded = pathname;
  for (var i = 0; i < 8; i++) {
    var next;
    try {
      next = decodeURIComponent(decoded);
    } catch (_decodeError) {
      return '';
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function isSafeMcpPathname(pathname) {
  if (
    typeof pathname !== 'string' ||
    pathname.charAt(0) !== '/' ||
    pathname.charAt(1) === '/' ||
    pathname.indexOf('\\') >= 0
  ) {
    return false;
  }
  var decodedPath = decodeMcpPathForSafety(pathname);
  return !(
    !decodedPath ||
    decodedPath.charAt(0) !== '/' ||
    decodedPath.charAt(1) === '/' ||
    decodedPath.indexOf('\\') >= 0
  );
}

function buildSameOriginMcpUrl(origin, pathname, queryString) {
  if (!isSafeMcpPathname(pathname)) return null;
  try {
    var target = new URL(pathname + (queryString || ''), origin);
    if (
      (target.protocol !== 'http:' && target.protocol !== 'https:') ||
      target.origin !== origin
    ) {
      return null;
    }
    return target.toString();
  } catch (_targetError) {
    return null;
  }
}

function validateSameOriginMcpUrl(url, origin) {
  try {
    var target = new URL(url);
    return (
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      target.origin === origin &&
      isSafeMcpPathname(target.pathname)
    );
  } catch (_targetError) {
    return false;
  }
}

function mergeMcpUntrustedHeaderSources(toolMeta) {
  var meta = toolMeta || {};
  return Object.assign(
    {},
    meta.sampleRequestHeaders,
    meta.rawRequestHeaders,
    meta.recordedBusinessHeaders
  );
}

function enrichToolMetaHosts(toolMeta, matchedStorageHost) {
  var meta = toolMeta && typeof toolMeta === 'object'
    ? Object.assign({}, toolMeta)
    : {};
  var inferredHost = String(meta.toolHost || meta.apiHostname || '').trim();
  if (!inferredHost && meta.origin) {
    try {
      var parsed = new URL(meta.origin);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.hostname &&
        parsed.origin !== 'null'
      ) {
        inferredHost = parsed.hostname;
      }
    } catch (_originError) {}
  }
  if (!inferredHost && matchedStorageHost) {
    inferredHost = String(matchedStorageHost).trim();
  }
  if (inferredHost) {
    meta.toolHost = inferredHost;
    meta.apiHostname = meta.apiHostname || inferredHost;
    if (!meta.origin) meta.origin = 'https://' + inferredHost;
    if (!Array.isArray(meta.recordedApiOrigins) || !meta.recordedApiOrigins.length) {
      meta.recordedApiOrigins = [meta.origin];
    }
    if (!meta.siteRoot && typeof AiSiteAffinity !== 'undefined') {
      meta.siteRoot = AiSiteAffinity.deriveSiteRoot(inferredHost) || '';
    }
  }
  return meta;
}

function resolveIdentityOriginForToolMeta(toolMeta, matchedStorageHost) {
  var meta = toolMeta || {};
  if (meta.origin && /^https?:\/\//i.test(meta.origin)) {
    try {
      var parsed = new URL(meta.origin);
      if (parsed.hostname && parsed.origin !== 'null') return parsed.origin;
    } catch (_e) {}
  }
  var host = String(
    meta.toolHost || meta.apiHostname || matchedStorageHost || ''
  ).trim();
  return host ? 'https://' + host : '';
}

function prepareToolMetaForRuntime(toolDef, toolMeta, items, matchedStorageHost) {
  var meta = enrichBrainstormToolMeta(toolDef, toolMeta);
  var identityOrigin = resolveIdentityOriginForToolMeta(meta, matchedStorageHost);
  if (
    identityOrigin &&
    typeof applyLiveSiteIdentityToToolMeta === 'function' &&
    items
  ) {
    meta = applyLiveSiteIdentityToToolMeta(meta, items, identityOrigin) || meta;
  }
  return enrichToolMetaHosts(meta, matchedStorageHost);
}

// Revalidate a recently-expired live auth record by replaying it against the
// very GET endpoint the caller wanted. 2xx proves the credential is still
// accepted and re-arms the observation; 401/403 proves it is dead.
// Returns 'refreshed' | 'rejected' | 'failed'.
async function attemptAuthProbeRevalidation(probeHint, meta, toolArguments) {
  var origin = probeHint && probeHint.origin;
  var tabId = probeHint && probeHint.tabId;
  if (!origin || typeof tabId !== 'number') return 'failed';
  await AiRuntimeAuthSession.ensureLiveAuthRestored();
  var stale = AiRuntimeAuthSession.getStaleAuthForProbe(origin, tabId, Date.now());
  if (!stale.ok) return 'failed';
  var parted = partitionMcpToolArguments(meta, toolArguments || {});
  var queryString = '';
  var argKeys = Object.keys(parted.restArgs);
  for (var i = 0; i < argKeys.length; i++) {
    queryString += (queryString ? '&' : '?') +
      encodeURIComponent(argKeys[i]) + '=' +
      encodeURIComponent(String(parted.restArgs[argKeys[i]]));
  }
  var probeUrl = buildSameOriginMcpUrl(origin, parted.pathname, queryString);
  if (!probeUrl) return 'failed';
  var status = 0;
  try {
    var resp = await fetch(probeUrl, {
      method: 'GET',
      headers: stale.staleAuth.explicitHeaders,
      credentials: 'omit',
      cache: 'no-store'
    });
    status = resp.status;
  } catch (_probeError) {
    return 'failed';
  }
  if (status === 401 || status === 403) return 'rejected';
  if (status < 200 || status >= 300) return 'failed';
  await AiRuntimeAuthSession.observeLiveAuth({
    apiOrigin: origin,
    tabId: tabId,
    requestHeaders: stale.staleAuth.explicitHeaders,
    observedAt: Date.now()
  });
  await AiRuntimeAuthSession.observeSamePathApi({
    tabId: tabId,
    apiOrigin: origin,
    pathPatternKey: meta.pathPatternKey ||
      AiSiteAffinity.buildPathPatternKey(meta.method, meta.pathname || meta.pathnameTemplate),
    observedAt: Date.now()
  });
  return 'refreshed';
}

async function prepareMcpRuntimeExecution(
  callId,
  toolName,
  toolMeta,
  toolArguments,
  matchedStorageHost,
  trustedInitiatorTabId
) {
  var meta = enrichToolMetaHosts(toolMeta, matchedStorageHost);
  var affinityTabs;
  try {
    affinityTabs = await findTabsForSiteAffinity(meta);
  } catch (error) {
    return buildMcpAuthError(
      safeRuntimeAuthErrorCode(error, 'AUTH_TAB_QUERY_FAILED'),
      await withSessionEpoch(
        null,
        resolveIdentityOriginForToolMeta(meta, matchedStorageHost)
      )
    );
  }
  var selectedTabIdArg = toolArguments && toolArguments.__authTabId;
  if (typeof selectedTabIdArg === 'string' && /^\d+$/.test(selectedTabIdArg)) {
    selectedTabIdArg = Number(selectedTabIdArg);
  }
  // Explicit caller opt-in: allow a bearer/custom-recorded tool to fall back
  // to the browser cookie session. Without this parameter the pipeline stays
  // fail-closed on AUTH_SESSION_MISSING.
  var authModeOverrideArg =
    toolArguments && toolArguments.__authMode === 'cookie' ? 'cookie' : '';
  function selectAffinity() {
    return AiRuntimeAuthSession.selectSiteAffinityExecution({
      toolMeta: meta,
      tabs: affinityTabs.map(function (tab) {
        return { tabId: tab.id, url: tab.url };
      }),
      initiatorTabId: safeInitiatorTabId(trustedInitiatorTabId),
      selectedTabId: safeInitiatorTabId(selectedTabIdArg)
    });
  }
  var affinity = await selectAffinity();
  if (
    !affinity.ok &&
    affinity.errorCode === 'AUTH_SESSION_MISSING' &&
    affinity.probeHint &&
    AiRuntimeAuth.classifyOperation(meta) === 'read'
  ) {
    // One shot at revalidating a recently-expired credential via probe.
    var probeOutcome = await attemptAuthProbeRevalidation(
      affinity.probeHint,
      meta,
      toolArguments
    );
    if (probeOutcome === 'rejected') {
      return buildMcpAuthError(
        'AUTH_REJECTED',
        await withSessionEpoch(affinity, affinity.probeHint.origin)
      );
    }
    if (probeOutcome === 'refreshed') {
      affinity = await selectAffinity();
    }
  }
  if (
    !affinity.ok &&
    affinity.errorCode === 'AUTH_SESSION_MISSING' &&
    authModeOverrideArg === 'cookie'
  ) {
    // Caller explicitly asked for the cookie session: re-run selection with
    // the token requirement dropped so the browser_cookie path can proceed.
    meta = Object.assign({}, meta, {
      detectedAuthType: 'cookie',
      authHeaderNames: ['cookie']
    });
    affinity = await selectAffinity();
    if (affinity.ok) affinity.authModeOverride = 'cookie';
  }
  if (!affinity.ok) {
    if (Array.isArray(affinity.candidates)) {
      affinity.candidates.forEach(function (candidate) {
        var tab = affinityTabs.find(function (item) {
          return item && item.id === candidate.tabId;
        });
        if (tab && tab.title) candidate.title = tab.title;
      });
    }
    return buildMcpAuthError(
      affinity.errorCode || 'AUTH_TAB_REQUIRED',
      await withSessionEpoch(
        affinity,
        resolveIdentityOriginForToolMeta(meta, matchedStorageHost)
      )
    );
  }
  var origin = '';
  try {
    var parsedOrigin = new URL(affinity.finalOrigin);
    if (
      (parsedOrigin.protocol === 'http:' ||
        parsedOrigin.protocol === 'https:') &&
      parsedOrigin.hostname &&
      parsedOrigin.origin !== 'null'
    ) {
      origin = parsedOrigin.origin;
    }
  } catch (_originError) {}
  if (!origin) return buildMcpAuthError('AUTH_SOURCE_UNSAFE', affinity);

  if (
    affinity.authModeOverride === 'cookie' ||
    affinity.matchLevel === 'cookie_session_fallback'
  ) {
    meta = Object.assign({}, meta, {
      detectedAuthType: 'cookie',
      authHeaderNames: ['cookie']
    });
  }

  AiRuntimeAuthSession.registerTarget(
    origin + (meta.pathname || '/'),
    null
  );
  try {
    await AiRuntimeAuthSession.ensureRegistryLoaded();
  } catch (_registryError) {
    return buildMcpAuthError(
      'AUTH_CONTEXT_STALE',
      await withSessionEpoch(affinity, origin)
    );
  }

  var operationClass = AiRuntimeAuth.classifyOperation(meta);
  var resolveTabs = [];
  var resolveInitiator = undefined;
  if (affinity.tabId != null) {
    resolveTabs = [{ tabId: affinity.tabId }];
    resolveInitiator = affinity.tabId;
  }
  var resolution = await AiRuntimeAuthSession.resolveRuntimeAuth({
    origin: origin,
    toolMeta: meta,
    tabs: resolveTabs,
    initiatorTabId: resolveInitiator
  });
  if (!resolution.ok) {
    return buildMcpAuthError(
      resolution.errorCode || 'AUTH_SOURCE_UNSAFE',
      await withSessionEpoch(resolution, origin)
    );
  }
  if (authModeOverrideArg) {
    resolution.authModeOverride = authModeOverrideArg;
  }
  var merged = AiRuntimeAuth.mergeAndValidateHeaders(
    mergeMcpUntrustedHeaderSources(meta),
    operationClass,
    resolution.authBundle
  );
  if (!merged.ok) {
    return buildMcpAuthError(
      merged.errorCode || 'AUTH_SOURCE_UNSAFE',
      await withSessionEpoch(resolution, origin)
    );
  }
  var built = buildMcpProxyPayload(
    callId,
    toolName,
    meta,
    toolArguments,
    merged.headers,
    resolution.authBundle,
    operationClass
  );
  var selectedTab = null;
  if (resolution.tabId != null) {
    selectedTab = affinityTabs.find(function (tab) {
      return tab && tab.id === resolution.tabId;
    }) || null;
    if (resolution.proxyMode === 'tab' && !selectedTab) {
      return buildMcpAuthError('AUTH_TAB_REQUIRED', resolution);
    }
  }
  var fullUrl = buildSameOriginMcpUrl(
    origin,
    built.pathname,
    built.queryString
  );
  if (!fullUrl) {
    return buildMcpAuthError('AUTH_SOURCE_UNSAFE', resolution);
  }
  return {
    ok: true,
    origin: origin,
    operationClass: operationClass,
    resolution: resolution,
    built: built,
    selectedTab: selectedTab,
    fullUrl: fullUrl
  };
}

async function validatePreparedMcpDispatch(prepared) {
  var validation = await AiRuntimeAuthSession.validateBeforeDispatch(
    prepared.origin,
    prepared.resolution.sessionEpoch,
    prepared.operationClass
  );
  return validation.ok
    ? validation
    : buildMcpAuthError(
      validation.errorCode || 'AUTH_CONTEXT_STALE',
      prepared.resolution
    );
}

async function dispatchPreparedMcpExecution(prepared) {
  var validation = await validatePreparedMcpDispatch(prepared);
  if (!validation.ok) return validation;
  if (!validateSameOriginMcpUrl(prepared.fullUrl, prepared.origin)) {
    return buildMcpAuthError('AUTH_SOURCE_UNSAFE', prepared.resolution);
  }
  var resolution = prepared.resolution || {};

  function attachDispatchMeta(result) {
    var mapped = AiRuntimeAuthSession.mapHttpAuthResult(result) || {};
    return Object.assign({}, mapped, {
      proxyMode: mapped.proxyMode || resolution.proxyMode || 'none',
      authSource: mapped.authSource || resolution.authSource || 'none',
      sessionEpoch: Number(
        mapped.sessionEpoch != null
          ? mapped.sessionEpoch
          : (resolution.sessionEpoch || 0)
      )
    });
  }

  if (resolution.proxyMode === 'fallback') {
    // Include cookies even with live Bearer — Cookie-session sites (Yunxiao)
    // reject Authorization-only requests. Cookie bumps rebind live-token epochs.
    return attachDispatchMeta(
      await AiRuntimeAuthSession.dispatchOnce(function () {
        return fallbackFetch(
          prepared.fullUrl,
          prepared.built.method,
          prepared.built.execHeaders,
          prepared.built.bodyData,
          'include'
        );
      })
    );
  }
  if (resolution.proxyMode !== 'tab' || !prepared.selectedTab) {
    return buildMcpAuthError('AUTH_SOURCE_UNSAFE', prepared.resolution);
  }
  var rewrittenUrl = rewriteMcpProxyUrlForTab(
    prepared.selectedTab,
    prepared.fullUrl
  );
  try {
    if (!validateSameOriginMcpUrl(rewrittenUrl, prepared.origin)) {
      return buildMcpAuthError(
        'AUTH_SOURCE_UNSAFE',
        prepared.resolution
      );
    }
  } catch (_rewrittenUrlError) {
    return buildMcpAuthError(
      'AUTH_SOURCE_UNSAFE',
      prepared.resolution
    );
  }
  var payload = Object.assign({}, prepared.built.payload, {
    url: rewrittenUrl
  });
  return attachDispatchMeta(
    await AiRuntimeAuthSession.dispatchOnce(function () {
      return new Promise(function (resolve, reject) {
        sendMcpProxyToTab(
          resolution.tabId,
          payload,
          function (response, error) {
            if (response) {
              resolve(response);
              return;
            }
            reject(new Error(error || 'No response from content script'));
          }
        );
      });
    })
  );
}

function handleMcpToolCall(callId, toolName, toolArguments) {
  var startTime = Date.now();
  if (isFlowContextSystemTool(toolName)) {
    chrome.storage.local.get(null, function (items) {
      if (toolName === BRAINSTORM_MCP_TOOL && toolArguments && toolArguments.confirmCreate === true) {
        var prep = prepareBrainstormMcpToolCreate(toolArguments, items);
        if (!prep.ok) {
          prep.callId = callId;
          addMcpCallLog({
            timestamp: Date.now(),
            toolName: toolName,
            argsSummary: summarizeMcpArguments(toolArguments),
            status: 0,
            duration: Date.now() - startTime,
            proxyMode: 'flow_context',
            error: prep.message || prep.errorCode || 'brainstorm create error'
          });
          if (mcpState.helperPort && mcpState.helperConnected) {
            mcpState.helperPort.postMessage({ type: 'CALL_RESULT', callId: callId, result: prep });
          }
          return;
        }
        var writePayload = {};
        writePayload[prep.storageKey] = prep.toolsJson;
        chrome.storage.local.set(writePayload, function () {
          var sysResult;
          if (chrome.runtime.lastError) {
            sysResult = {
              ok: false,
              errorCode: 'CREATE_TOOL_FAILED',
              message: '写入 storage 失败: ' + chrome.runtime.lastError.message
            };
          } else {
            sysResult = {
              ok: true,
              mode: prep.mode || 'created',
              createdToolName: prep.createdToolName,
              createdToolNames: prep.createdToolNames || (prep.createdToolName ? [prep.createdToolName] : []),
              createdCount: prep.createdCount || (prep.createdToolName ? 1 : 0),
              failed: prep.failed || [],
              failedCount: prep.failedCount || 0,
              partial: !!prep.partial,
              targetHost: prep.targetHost,
              siteIdentityWarning: prep.siteIdentityWarning || null,
              message: (prep.partial ?
                ('已创建 ' + (prep.createdCount || 0) + ' 个 MCP 工具，' + (prep.failedCount || 0) + ' 个失败，并已同步。') :
                ('已创建 ' + (prep.createdCount || 1) + ' 个 MCP 工具并同步。')) +
                (prep.siteIdentityWarning ? (' ' + prep.siteIdentityWarning) : '')
            };
          }
          sysResult.callId = callId;
          addMcpCallLog({
            timestamp: Date.now(),
            toolName: toolName,
            argsSummary: summarizeMcpArguments(toolArguments),
            status: sysResult.ok ? 200 : 0,
            duration: Date.now() - startTime,
            proxyMode: 'flow_context',
            error: sysResult.ok ? null : (sysResult.message || sysResult.errorCode || 'brainstorm create error')
          });
          if (!sysResult.ok) {
            if (mcpState.helperPort && mcpState.helperConnected) {
              mcpState.helperPort.postMessage({ type: 'CALL_RESULT', callId: callId, result: sysResult });
            }
            return;
          }
          syncToolsToHelper(function (syncResult) {
            sysResult.synced = !!(syncResult && syncResult.synced);
            if (mcpState.helperPort && mcpState.helperConnected) {
              mcpState.helperPort.postMessage({ type: 'CALL_RESULT', callId: callId, result: sysResult });
            }
          });
        });
        return;
      }
      var sysResult = executeFlowContextSystemTool(toolName, toolArguments, items);
      sysResult.callId = callId;
      addMcpCallLog({
        timestamp: Date.now(),
        toolName: toolName,
        argsSummary: summarizeMcpArguments(toolArguments),
        status: sysResult.ok ? 200 : 0,
        duration: Date.now() - startTime,
        proxyMode: 'flow_context',
        error: sysResult.ok ? null : (sysResult.message || sysResult.errorCode || 'flow context error')
      });
      if (mcpState.helperPort && mcpState.helperConnected) {
        mcpState.helperPort.postMessage({ type: 'CALL_RESULT', callId: callId, result: sysResult });
      }
    });
    return;
  }
  chrome.storage.local.get(null, async function (items) {
    if (
      (chrome.runtime && chrome.runtime.lastError) ||
      !items ||
      typeof items !== 'object'
    ) {
      finishMcpToolCall(
        callId,
        toolName,
        toolArguments,
        startTime,
        buildMcpAuthError('AUTH_SOURCE_UNSAFE')
      );
      return;
    }
    try {
    var toolDef = null;
    var toolMeta = null;
    var matchedStorageHost = '';
    var storageKeys = Object.keys(items);
    for (var ki = 0; ki < storageKeys.length; ki++) {
      var key = storageKeys[ki];
      if (key.indexOf('ai_req_mcp_tools_') !== 0) continue;
      var hostname = key.substring('ai_req_mcp_tools_'.length);
      var toolsObj = parseStoredTools(items[key]);
      if (toolsObj && toolsObj[toolName]) {
        toolDef = toolsObj[toolName];
        toolMeta = toolDef._meta || {};
        matchedStorageHost = hostname;
        break;
      }
    }

    if (!toolDef) {
      var notFoundResult = { ok: false, error: 'Tool not found: ' + toolName, callId: callId };
      addMcpCallLog({
        timestamp: Date.now(),
        toolName: toolName,
        argsSummary: summarizeMcpArguments(toolArguments),
        status: 0,
        duration: Date.now() - startTime,
        proxyMode: 'none',
        error: 'Tool not found'
      });
      if (mcpState.helperPort && mcpState.helperConnected) {
        mcpState.helperPort.postMessage({ type: 'CALL_RESULT', callId: callId, result: notFoundResult });
      }
      return;
    }

    toolMeta = prepareToolMetaForRuntime(
      toolDef,
      toolMeta,
      items,
      matchedStorageHost
    );
      var prepared = await prepareMcpRuntimeExecution(
        callId,
        toolName,
        toolMeta,
        toolArguments,
        matchedStorageHost
      );
      if (!prepared.ok) {
        finishMcpToolCall(
          callId,
          toolName,
          toolArguments,
          startTime,
          prepared
        );
        return;
      }
      var result = await dispatchPreparedMcpExecution(prepared);
      finishMcpToolCall(
        callId,
        toolName,
        toolArguments,
        startTime,
        result,
        prepared.resolution
      );
    } catch (error) {
      finishMcpToolCall(
        callId,
        toolName,
        toolArguments,
        startTime,
        buildMcpAuthError(
          safeRuntimeAuthErrorCode(error, 'AUTH_SOURCE_UNSAFE')
        )
      );
    }
  });
}

function syncToolsToHelper(callback) {
  if (!mcpState.helperPort || !mcpState.helperConnected) {
    if (typeof callback === 'function') {
      callback({
        ok: false,
        synced: false,
        error: 'MCP helper 未连接',
        toolCount: mcpState.toolCount || 0
      });
    }
    return;
  }
  chrome.storage.local.get(null, function (items) {
    var pack = mergeAllMcpToolsFromStorage(items);
    var allTools = pack.merged;
    var flowCtxCfg = parseExtensionConfigFromItems(items);
    appendFlowContextSystemTools(allTools, flowCtxCfg);
    var enabledCount = countEnabledMcpTools(allTools);
    try {
      mcpState.helperPort.postMessage({ type: 'SYNC_TOOLS', tools: allTools });
      mcpState.tools = allTools;
      mcpState.toolCount = enabledCount;
      console.log('[AI_REQ_ANALYZER] synced tools to helper:', Object.keys(allTools).length, 'enabled:', enabledCount);
      if (typeof callback === 'function') {
        callback({
          ok: true,
          synced: true,
          toolCount: enabledCount,
          totalToolCount: Object.keys(allTools).length
        });
      }
    } catch (e) {
      if (typeof callback === 'function') {
        callback({
          ok: false,
          synced: false,
          error: e && e.message ? e.message : String(e),
          toolCount: mcpState.toolCount || 0
        });
      }
    }
  });
}

function addMcpCallLog(logEntry) {
  mcpState.callLogs.push(logEntry);
  if (mcpState.callLogs.length > 200) {
    mcpState.callLogs.shift();
  }
}
