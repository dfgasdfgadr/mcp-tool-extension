var FIELD_SOURCES_KEY_PREFIX = 'ai_req_field_sources_';
var MAX_PROVENANCE_NODES = 40000;
var MAX_PROVENANCE_TEXT_CHARS = 2 * 1024 * 1024;
var MAX_PROVENANCE_SELECTED_TEXT = 120;
var MAX_PROVENANCE_CANDIDATES = 10;

var DISPLAY_FIELD_KEYWORDS = ['name', 'title', 'status', 'amount', 'id', 'label', 'text', 'value'];

function getFieldSourcesKey(hostname) {
  return FIELD_SOURCES_KEY_PREFIX + (hostname || location.hostname);
}

function ensureFieldSourceState() {
  if (!state.fieldSources || typeof state.fieldSources !== 'object') state.fieldSources = {};
}

function loadFieldSources() {
  ensureFieldSourceState();
  try {
    var saved = storageGet(getFieldSourcesKey(), null);
    if (saved) {
      var parsed = JSON.parse(saved);
      state.fieldSources = parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch (e) {
    state.fieldSources = {};
  }
}

function saveFieldSources() {
  ensureFieldSourceState();
  storageSet(getFieldSourcesKey(), JSON.stringify(state.fieldSources || {}));
}

function upsertFieldSourceRecord(record) {
  ensureFieldSourceState();
  if (!record || !record.id) return null;
  state.fieldSources[record.id] = record;
  saveFieldSources();
  return record;
}

function parseJsonPathSegments(path) {
  if (!path || typeof path !== 'string' || path.charAt(0) !== '$') return null;
  var rest = path.slice(1);
  if (!rest) return [];
  var segments = [];
  var i = 0;
  while (i < rest.length) {
    if (rest.charAt(i) === '.') {
      i++;
      var start = i;
      while (i < rest.length && rest.charAt(i) !== '.' && rest.charAt(i) !== '[') i++;
      var key = rest.slice(start, i);
      if (!key || /[.\[\]"\\]/.test(key)) return null;
      segments.push(key);
      continue;
    }
    if (rest.charAt(i) === '[') {
      i++;
      var numStart = i;
      while (i < rest.length && rest.charAt(i) >= '0' && rest.charAt(i) <= '9') i++;
      if (rest.charAt(i) !== ']' || numStart === i) return null;
      segments.push(parseInt(rest.slice(numStart, i), 10));
      i++;
      continue;
    }
    return null;
  }
  return segments;
}

function formatJsonPathFromSegments(segments) {
  var path = '$';
  for (var i = 0; i < segments.length; i++) {
    if (typeof segments[i] === 'number') path += '[' + segments[i] + ']';
    else path += '.' + segments[i];
  }
  return path;
}

function isSupportedJsonPath(path) {
  return !!parseJsonPathSegments(path);
}

function getValueAtJsonPath(obj, path) {
  var segments = parseJsonPathSegments(path);
  if (!segments) return { ok: false, reason: 'INVALID_PATH' };
  var cur = obj;
  for (var i = 0; i < segments.length; i++) {
    if (cur == null || typeof cur !== 'object') return { ok: false, reason: 'PATH_NOT_FOUND' };
    var seg = segments[i];
    if (!(seg in cur)) return { ok: false, reason: 'PATH_NOT_FOUND' };
    cur = cur[seg];
  }
  return { ok: true, value: cur };
}

function setValueAtJsonPath(obj, path, value) {
  var segments = parseJsonPathSegments(path);
  if (!segments || !segments.length) return { ok: false, reason: 'INVALID_PATH' };
  var cur = obj;
  for (var i = 0; i < segments.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return { ok: false, reason: 'PATH_NOT_FOUND' };
    var seg = segments[i];
    if (!(seg in cur)) return { ok: false, reason: 'PATH_NOT_FOUND' };
    cur = cur[seg];
  }
  var last = segments[segments.length - 1];
  if (cur == null || typeof cur !== 'object' || !(last in cur)) {
    return { ok: false, reason: 'PATH_NOT_FOUND' };
  }
  cur[last] = value;
  return { ok: true, value: obj };
}

function normalizeProvenanceText(text) {
  if (text == null) return '';
  return String(text).trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeProvenanceNumberText(text) {
  return normalizeProvenanceText(String(text).replace(/,/g, ''));
}

function primitiveToMatchString(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function matchPrimitiveValue(selectedText, value) {
  var sel = String(selectedText || '').trim();
  if (!sel) return null;
  var valStr = primitiveToMatchString(value);
  if (!valStr && value !== 0 && value !== false) return null;
  if (valStr === sel) return 'exact';
  if (valStr.indexOf(sel) !== -1 || sel.indexOf(valStr) !== -1) return 'contains';
  var nSel = normalizeProvenanceText(sel);
  var nVal = normalizeProvenanceText(valStr);
  if (nSel && nVal && nSel === nVal) return 'normalized';
  var nSelNum = normalizeProvenanceNumberText(sel);
  var nValNum = normalizeProvenanceNumberText(valStr);
  if (nSelNum && nValNum && nSelNum === nValNum) return 'normalized';
  if (typeof value === 'boolean') {
    var boolSel = normalizeProvenanceText(sel);
    if ((boolSel === 'true' || boolSel === 'false') && boolSel === nVal) return 'normalized';
  }
  return null;
}

function walkJsonPrimitives(value, segments, visitor, limits) {
  if (!limits) limits = { nodeCount: 0, partial: false };
  if (limits.nodeCount >= MAX_PROVENANCE_NODES) {
    limits.partial = true;
    return;
  }
  limits.nodeCount++;
  if (value === null || typeof value === 'undefined' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    visitor(segments, value);
    return;
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      walkJsonPrimitives(value[i], segments.concat([i]), visitor, limits);
      if (limits.partial) return;
    }
    return;
  }
  if (typeof value === 'object') {
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (/[.\[\]"\\]/.test(key)) continue;
      walkJsonPrimitives(value[key], segments.concat([key]), visitor, limits);
      if (limits.partial) return;
    }
  }
}

function isTruncatedArchiveResponseBody(body) {
  return !!(body && typeof body === 'object' && !Array.isArray(body) && body.__archiveTruncated);
}

function getRecordResponseJson(record) {
  if (!record) return null;
  var body = record.responseBody;
  if (body === null || typeof body === 'undefined') return null;
  if (isTruncatedArchiveResponseBody(body)) {
    if (typeof body.preview === 'string' && body.preview) {
      try {
        var fromPreview = JSON.parse(body.preview);
        if (fromPreview && typeof fromPreview === 'object') return fromPreview;
      } catch (ePreview) {}
    }
    return null;
  }
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    if (body.length > MAX_PROVENANCE_TEXT_CHARS) return null;
    try {
      var parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {}
  }
  return null;
}

function shouldSkipProvenanceRecord(record) {
  if (!record) return true;
  var url = record.originalUrl || record.url || '';
  if (!url) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|mp4|mp3|wav|avi|map|webp)(\?|#|$)/i.test(url)) return true;
  if (url.indexOf('api.moonshot.cn') !== -1) return true;
  var lower = String(url).toLowerCase();
  if (/(?:^|[\/_.?=&-])(?:track|analytics|sentry|beacon|collect|logs?|monitor)(?:[\/_.?=&-]|$)/.test(lower)) return true;
  if (getRecordResponseJson(record)) return false;
  if (isTruncatedArchiveResponseBody(record.responseBody) && record.responseBody.preview) return false;
  return true;
}

function findFlowMetaForRequestId(requestId) {
  ensureFlowState();
  var flowIds = Object.keys(state.flows || {});
  for (var fi = 0; fi < flowIds.length; fi++) {
    var flow = state.flows[flowIds[fi]];
    if (!flow || !flow.steps) continue;
    for (var si = 0; si < flow.steps.length; si++) {
      var step = flow.steps[si];
      if ((step.requestIds || []).indexOf(requestId) !== -1) {
        return { flowId: flow.id, flowName: flow.name, stepId: step.id, stepIndex: step.index, stepTitle: step.title };
      }
    }
  }
  return null;
}

function getFlowRecordsStorageKey(hostname, flowId) {
  return 'ai_req_flow_records_' + String(hostname || '').replace(/[^\w.-]/g, '_') + '_' + String(flowId || '');
}

function resolveProvenanceTargetFlow() {
  ensureFlowState();
  var flow = typeof getSelectedFlow === 'function' ? getSelectedFlow() : null;
  if (!flow && state.flowUi && state.flowUi.selectedFlowId) {
    flow = state.flows[state.flowUi.selectedFlowId] || null;
  }
  if (!flow && state.activeFlowId) flow = state.flows[state.activeFlowId] || null;
  if (!flow) {
    var fids = Object.keys(state.flows || {}).sort(function (a, b) {
      return ((state.flows[b] && state.flows[b].startedAt) || 0) - ((state.flows[a] && state.flows[a].startedAt) || 0);
    });
    if (fids.length) flow = state.flows[fids[0]];
  }
  return flow || null;
}

function ensureFlowRecordsLoadedForProvenance(done) {
  var flow = resolveProvenanceTargetFlow();
  if (!flow || !flow.id) {
    if (typeof done === 'function') done(0);
    return;
  }
  var hosts = [];
  var primaryHost = flow.hostname || (typeof location !== 'undefined' ? location.hostname : '');
  if (primaryHost) hosts.push(primaryHost);
  if (typeof location !== 'undefined' && location.hostname && hosts.indexOf(location.hostname) === -1) {
    hosts.push(location.hostname);
  }
  var keys = [];
  for (var hi = 0; hi < hosts.length; hi++) {
    keys.push(getFlowRecordsStorageKey(hosts[hi], flow.id));
  }
  var pending = keys.length;
  var totalAdded = 0;
  if (!pending) {
    if (typeof done === 'function') done(0);
    return;
  }
  function finishOne(added) {
    totalAdded += added || 0;
    pending--;
    if (pending <= 0 && typeof done === 'function') done(totalAdded);
  }
  for (var ki = 0; ki < keys.length; ki++) {
    var key = keys[ki];
    if (typeof loadArchivedFlowRecords === 'function') loadArchivedFlowRecords(key);
    if (typeof loadArchivedFlowRecordsFresh === 'function') {
      loadArchivedFlowRecordsFresh(key, finishOne);
    } else {
      finishOne(0);
    }
  }
}

function buildProvenanceSearchRecords() {
  var seen = {};
  var ordered = [];
  function pushRecord(rec, scope) {
    if (!rec || !rec.id || seen[rec.id] || shouldSkipProvenanceRecord(rec)) return;
    seen[rec.id] = true;
    ordered.push({ record: rec, scope: scope });
  }

  var flow = resolveProvenanceTargetFlow();
  if (flow && flow.steps) {
    for (var si = 0; si < flow.steps.length; si++) {
      var ids = flow.steps[si].requestIds || [];
      for (var ri = 0; ri < ids.length; ri++) {
        var recF = typeof findRequestById === 'function' ? findRequestById(ids[ri]) : null;
        pushRecord(recF, 'flow');
      }
    }
  }

  var pageHref = typeof location !== 'undefined' ? location.href : '';
  var records = state.requestRecords || [];
  for (var i = records.length - 1; i >= 0; i--) {
    var rec = records[i];
    if (rec.pageUrl && pageHref && rec.pageUrl === pageHref) pushRecord(rec, 'page');
  }
  for (var j = records.length - 1; j >= 0; j--) {
    pushRecord(records[j], 'recent');
  }
  return ordered;
}

function scoreFieldCandidate(ctx) {
  var score = 0;
  if (ctx.matchType === 'exact') score += 60;
  else if (ctx.matchType === 'contains') score += 35;
  else if (ctx.matchType === 'normalized') score += 25;
  if (ctx.scope === 'flow') score += 20;
  else if (ctx.scope === 'page') score += 12;
  else score += 4;
  if (ctx.flowMeta) score += 8;
  if (ctx.verified) score += 10;
  if (ctx.core) score += 6;
  var pathLower = (ctx.jsonPath || '').toLowerCase();
  for (var i = 0; i < DISPLAY_FIELD_KEYWORDS.length; i++) {
    if (pathLower.indexOf(DISPLAY_FIELD_KEYWORDS[i]) !== -1) {
      score += 3;
      break;
    }
  }
  if (ctx.recencyBoost) score += Math.min(10, ctx.recencyBoost);
  return score;
}

function confidenceLevelFromScore(score) {
  if (score >= 70) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function buildMatchReasons(ctx) {
  var reasons = [];
  if (ctx.matchType === 'exact') reasons.push('精确匹配');
  else if (ctx.matchType === 'contains') reasons.push('包含匹配');
  else if (ctx.matchType === 'normalized') reasons.push('规范化匹配');
  if (ctx.scope === 'flow') reasons.push('当前 Flow');
  else if (ctx.scope === 'page') reasons.push('当前页面');
  else reasons.push('最近请求');
  if (ctx.verified) reasons.push('已验证');
  if (ctx.core) reasons.push('核心请求');
  return reasons;
}

var MAX_PROVENANCE_INDEX_BYTES = 2 * 1024 * 1024;
var PROVENANCE_INDEX_MAX_DEPTH = 200;
var PROV_KEY_SKIP_RE = /[.\[\]"\\]/;

function getRecordProvBodyString(record) {
  if (!record) return null;
  if (record._provBodyStr !== undefined) return record._provBodyStr;
  var body = record.responseBody;
  var str = null;
  if (typeof body === 'string') {
    str = body;
  } else if (isTruncatedArchiveResponseBody(body) && typeof body.preview === 'string') {
    str = body.preview;
  } else if (body && typeof body === 'object') {
    try { str = JSON.stringify(body); } catch (e) { str = null; }
  }
  if (!str || str.length > MAX_PROVENANCE_INDEX_BYTES) {
    record._provBodyStr = null;
    return null;
  }
  record._provBodyStr = str;
  return str;
}

function buildProvenanceOffsetIndex(bodyStr) {
  if (!bodyStr || typeof bodyStr !== 'string') return null;
  var len = bodyStr.length;
  var entries = [];
  var i = 0;
  var depth = 0;

  function skipWs() {
    while (i < len) {
      var cc = bodyStr.charCodeAt(i);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 13) i++;
      else break;
    }
  }
  function parseString() {
    var start = i;
    i++;
    var buf = '';
    while (i < len) {
      var c = bodyStr.charAt(i);
      if (c === '\\') {
        var n = bodyStr.charAt(i + 1);
        if (n === 'u') {
          var hex = bodyStr.slice(i + 2, i + 6);
          try { buf += String.fromCharCode(parseInt(hex, 16)); } catch (e) { return null; }
          i += 6;
          continue;
        }
        if (n === '"') buf += '"';
        else if (n === '\\') buf += '\\';
        else if (n === '/') buf += '/';
        else if (n === 'b') buf += '\b';
        else if (n === 'f') buf += '\f';
        else if (n === 'n') buf += '\n';
        else if (n === 'r') buf += '\r';
        else if (n === 't') buf += '\t';
        else buf += n;
        i += 2;
        continue;
      }
      if (c === '"') { i++; return { start: start, end: i, value: buf, rawHasEscape: start + 1 < i - 1 && bodyStr.slice(start + 1, i - 1).indexOf('\\') !== -1 }; }
      buf += c;
      i++;
    }
    return null;
  }
  function parseScalar() {
    var start = i;
    var c = bodyStr.charAt(i);
    if (c === 't') { i += 4; return { start: start, end: i, value: true, kind: 'boolean' }; }
    if (c === 'f') { i += 5; return { start: start, end: i, value: false, kind: 'boolean' }; }
    if (c === 'n') { i += 4; return { start: start, end: i, value: null, kind: 'null' }; }
    var rest = bodyStr.slice(i);
    var m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!m) return null;
    i += m[0].length;
    return { start: start, end: i, value: Number(m[0]), kind: 'number' };
  }
  function parseValue(segments, suppress) {
    if (depth > PROVENANCE_INDEX_MAX_DEPTH) return false;
    skipWs();
    if (i >= len) return false;
    var c = bodyStr.charAt(i);
    if (c === '{') { depth++; var ok = parseObject(segments, suppress); depth--; return ok; }
    if (c === '[') { depth++; var ok2 = parseArray(segments, suppress); depth--; return ok2; }
    if (c === '"') {
      var s = parseString();
      if (!s) return false;
      if (!suppress) entries.push({ start: s.start, end: s.end, segments: segments.slice(), value: s.value, kind: 'string', rawHasEscape: s.rawHasEscape });
      return true;
    }
    var nk = parseScalar();
    if (!nk) return false;
    if (!suppress) entries.push({ start: nk.start, end: nk.end, segments: segments.slice(), value: nk.value, kind: nk.kind, rawHasEscape: false });
    return true;
  }
  function parseObject(parentSegments, suppress) {
    i++;
    skipWs();
    if (bodyStr.charAt(i) === '}') { i++; return true; }
    while (true) {
      skipWs();
      if (bodyStr.charAt(i) !== '"') return false;
      var key = parseString();
      if (!key) return false;
      var keyStr = key.value;
      var childSuppress = suppress || PROV_KEY_SKIP_RE.test(keyStr);
      skipWs();
      if (bodyStr.charAt(i) !== ':') return false;
      i++;
      if (!parseValue(parentSegments.concat([keyStr]), childSuppress)) return false;
      skipWs();
      var c = bodyStr.charAt(i);
      if (c === ',') { i++; continue; }
      if (c === '}') { i++; return true; }
      return false;
    }
  }
  function parseArray(parentSegments, suppress) {
    i++;
    skipWs();
    if (bodyStr.charAt(i) === ']') { i++; return true; }
    var idx = 0;
    while (true) {
      if (!parseValue(parentSegments.concat([idx]), suppress)) return false;
      idx++;
      skipWs();
      var c = bodyStr.charAt(i);
      if (c === ',') { i++; continue; }
      if (c === ']') { i++; return true; }
      return false;
    }
  }

  try {
    skipWs();
    if (!parseValue([], false)) return null;
  } catch (e) {
    return null;
  }
  entries.sort(function (a, b) { return a.start - b.start; });
  return { entries: entries, lowerBody: bodyStr.toLowerCase() };
}

function ensureRecordOffsetIndex(record) {
  if (!record) return null;
  if (record._provIndex !== undefined) return record._provIndex;
  var str = getRecordProvBodyString(record);
  if (!str) { record._provIndex = null; return null; }
  var index = buildProvenanceOffsetIndex(str);
  record._provIndex = index;
  return index;
}

function invalidateProvenanceCache(record) {
  if (!record) return;
  delete record._provBodyStr;
  delete record._provIndex;
}

function buildProvenanceCandidate(rec, item, jsonPath, value, matchType, flowMeta, verified, core, idx, totalRecords) {
  var recencyBoost = Math.max(0, 10 - Math.floor((totalRecords - idx) / 10));
  var ctx = {
    matchType: matchType,
    scope: item.scope,
    flowMeta: flowMeta,
    verified: verified,
    core: core,
    jsonPath: jsonPath,
    recencyBoost: recencyBoost
  };
  return {
    candidateId: 'candidate_' + rec.id + '_' + jsonPath,
    requestId: rec.id,
    flowId: flowMeta ? flowMeta.flowId : null,
    stepId: flowMeta ? flowMeta.stepId : null,
    method: (rec.method || 'GET').toUpperCase(),
    url: rec.url || '',
    originalUrl: rec.originalUrl || rec.url || '',
    mockKey: getMockKey(rec.originalUrl || rec.url || ''),
    jsonPath: jsonPath,
    value: value,
    valuePreview: primitiveToMatchString(value).slice(0, 120),
    matchType: matchType,
    score: scoreFieldCandidate(ctx),
    confidenceLevel: '',
    matchReasons: buildMatchReasons(ctx),
    partialSearch: false,
    truncated: false,
    flowStepTitle: flowMeta ? flowMeta.stepTitle : '',
    flowName: flowMeta ? flowMeta.flowName : ''
  };
}

function collectCandidatesByWalk(rec, item, text, idx, totalRecords, rawCandidates, seenKey) {
  var json = getRecordResponseJson(rec);
  if (!json) return false;
  var limits = { nodeCount: 0, partial: false };
  var flowMeta = findFlowMetaForRequestId(rec.id);
  var flowId = flowMeta ? flowMeta.flowId : null;
  var verified = false;
  var core = false;
  if (flowId && state.flows[flowId]) {
    verified = (state.flows[flowId].verifiedRequestIds || []).indexOf(rec.id) !== -1;
    core = ((state.flows[flowId].classifications || {})[rec.id] || '') === 'core';
  }
  walkJsonPrimitives(json, [], function (segments, value) {
    var matchType = matchPrimitiveValue(text, value);
    if (!matchType) return;
    var jsonPath = formatJsonPathFromSegments(segments);
    if (!isSupportedJsonPath(jsonPath)) return;
    var dk = rec.id + '\n' + jsonPath;
    if (seenKey[dk]) return;
    seenKey[dk] = true;
    rawCandidates.push(buildProvenanceCandidate(rec, item, jsonPath, value, matchType, flowMeta, verified, core, idx, totalRecords));
  }, limits);
  return limits.partial;
}

function collectCandidatesByIndex(rec, item, index, text, idx, totalRecords, rawCandidates, seenKey) {
  if (!index || !index.entries) return false;
  var flowMeta = findFlowMetaForRequestId(rec.id);
  var flowId = flowMeta ? flowMeta.flowId : null;
  var verified = false;
  var core = false;
  if (flowId && state.flows[flowId]) {
    verified = (state.flows[flowId].verifiedRequestIds || []).indexOf(rec.id) !== -1;
    core = ((state.flows[flowId].classifications || {})[rec.id] || '') === 'core';
  }
  var entries = index.entries;
  for (var ei = 0; ei < entries.length; ei++) {
    var e = entries[ei];
    var matchType = matchPrimitiveValue(text, e.value);
    if (!matchType) continue;
    var jsonPath = formatJsonPathFromSegments(e.segments);
    if (!isSupportedJsonPath(jsonPath)) continue;
    var dk = rec.id + '\n' + jsonPath;
    if (seenKey[dk]) continue;
    seenKey[dk] = true;
    rawCandidates.push(buildProvenanceCandidate(rec, item, jsonPath, e.value, matchType, flowMeta, verified, core, idx, totalRecords));
  }
  return false;
}

function collectCandidatesByRawContains(rec, item, text, idx, totalRecords, rawCandidates, seenKey) {
  var str = getRecordProvBodyString(rec);
  if (!str && isTruncatedArchiveResponseBody(rec.responseBody) && typeof rec.responseBody.preview === 'string') {
    str = rec.responseBody.preview;
  }
  if (!str) return false;
  var lowerSel = normalizeProvenanceText(text);
  if (!lowerSel || str.toLowerCase().indexOf(lowerSel) === -1) return false;
  var jsonPath = '$';
  var dk = rec.id + '\n' + jsonPath + '\nraw';
  if (seenKey[dk]) return true;
  seenKey[dk] = true;
  var flowMeta = findFlowMetaForRequestId(rec.id);
  var flowId = flowMeta ? flowMeta.flowId : null;
  var verified = false;
  var core = false;
  if (flowId && state.flows[flowId]) {
    verified = (state.flows[flowId].verifiedRequestIds || []).indexOf(rec.id) !== -1;
    core = ((state.flows[flowId].classifications || {})[rec.id] || '') === 'core';
  }
  var quoted = '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  var matchType = str.indexOf(quoted) !== -1 ? 'exact' : 'contains';
  var candidate = buildProvenanceCandidate(rec, item, jsonPath, text, matchType, flowMeta, verified, core, idx, totalRecords);
  candidate.truncated = true;
  candidate.partialSearch = true;
  candidate.matchReasons = (candidate.matchReasons || []).concat(['响应体过大或已截断，仅定位到请求']);
  rawCandidates.push(candidate);
  return true;
}

function findFieldSourceCandidates(selectedText, options) {
  options = options || {};
  var text = String(selectedText || '').trim();
  var truncatedSelection = false;
  if (text.length > MAX_PROVENANCE_SELECTED_TEXT) {
    text = text.slice(0, MAX_PROVENANCE_SELECTED_TEXT);
    truncatedSelection = true;
  }
  if (!text) {
    return { selectedText: '', candidates: [], partialSearch: false, truncatedSelection: false };
  }

  var lowerSel = normalizeProvenanceText(text);
  if (!lowerSel) {
    return { selectedText: text, candidates: [], partialSearch: false, truncatedSelection: truncatedSelection };
  }

  var searchItems = buildProvenanceSearchRecords();
  var rawCandidates = [];
  var partialSearch = false;
  var seenKey = {};
  var totalRecords = searchItems.length;

  for (var idx = 0; idx < searchItems.length; idx++) {
    var item = searchItems[idx];
    var rec = item.record;
    var index = ensureRecordOffsetIndex(rec);
    var beforeCount = rawCandidates.length;

    if (!index) {
      if (collectCandidatesByWalk(rec, item, text, idx, totalRecords, rawCandidates, seenKey)) {
        partialSearch = true;
      }
      if (rawCandidates.length === beforeCount) {
        if (collectCandidatesByRawContains(rec, item, text, idx, totalRecords, rawCandidates, seenKey)) {
          partialSearch = true;
        }
      }
      continue;
    }

    collectCandidatesByIndex(rec, item, index, text, idx, totalRecords, rawCandidates, seenKey);
  }

  rawCandidates.sort(function (a, b) { return b.score - a.score; });
  var deduped = [];
  for (var ci = 0; ci < rawCandidates.length; ci++) {
    var c = rawCandidates[ci];
    c.confidenceLevel = confidenceLevelFromScore(c.score);
    c.partialSearch = partialSearch;
    deduped.push(c);
    if (deduped.length >= MAX_PROVENANCE_CANDIDATES) break;
  }

  return {
    selectedText: text,
    candidates: deduped,
    partialSearch: partialSearch,
    truncatedSelection: truncatedSelection
  };
}

function parseFieldMockValueInput(raw, valueType) {
  var t = valueType || 'string';
  if (t === 'null') return null;
  if (t === 'boolean') {
    if (raw === true || raw === false) return raw;
    var bs = String(raw).trim().toLowerCase();
    if (bs === 'true') return true;
    if (bs === 'false') return false;
    throw new Error('无效布尔值');
  }
  if (t === 'number' || t === 'integer') {
    var n = Number(raw);
    if (isNaN(n)) throw new Error('无效数字');
    return t === 'integer' ? Math.trunc(n) : n;
  }
  if (t === 'object' || t === 'array') {
    if (typeof raw === 'string') {
      if (!raw.trim()) throw new Error('JSON 不能为空');
      var parsed = JSON.parse(raw);
      if (t === 'array' && !Array.isArray(parsed)) throw new Error('需要 JSON 数组');
      if (t === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('需要 JSON 对象');
      }
      return parsed;
    }
    return raw;
  }
  return raw == null ? '' : String(raw);
}

function inferValueTypeFromPrimitive(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function upsertFieldMockPatch(mockKey, method, patch, options) {
  options = options || {};
  if (!mockKey) throw new Error('缺少 mockKey');
  var key = mockKey;
  var existing = state.mockRules[key] ? normalizeRule(state.mockRules[key], key, method) : normalizeRule({
    __aiReqRule: true,
    enabled: true,
    once: false,
    match: { pathname: key, method: (method || 'GET').toUpperCase() },
    request: { url: '', headersSet: {}, headersRemove: [] },
    response: {
      status: 200,
      statusText: 'OK',
      headersSet: { 'Content-Type': 'application/json' },
      headersRemove: [],
      bodyEnabled: false,
      body: null,
      patches: []
    }
  }, key, method);
  if (options.once === true) existing.once = true;
  if (!existing.response.patches) existing.response.patches = [];
  var replaced = false;
  for (var i = 0; i < existing.response.patches.length; i++) {
    if (existing.response.patches[i].jsonPath === patch.jsonPath) {
      existing.response.patches[i] = patch;
      replaced = true;
      break;
    }
  }
  if (!replaced) existing.response.patches.push(patch);
  state.mockRules[key] = existing;
  saveMockRules();
  return existing;
}

function saveFieldMockFromCandidate(candidate, selectedText, newValue, valueType, once) {
  if (!candidate || !candidate.mockKey) throw new Error('候选无效');
  var parsedValue = parseFieldMockValueInput(newValue, valueType);
  var sourceId = 'fieldsrc_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  var now = Date.now();
  var sourceRecord = {
    id: sourceId,
    hostname: location.hostname,
    pageUrl: location.href,
    selectedText: selectedText,
    requestId: candidate.requestId,
    flowId: candidate.flowId || null,
    stepId: candidate.stepId || null,
    method: candidate.method,
    url: candidate.url,
    originalUrl: candidate.originalUrl,
    mockKey: candidate.mockKey,
    jsonPath: candidate.jsonPath,
    originalValue: candidate.value,
    lastMockValue: parsedValue,
    confidence: candidate.score / 100,
    matchType: candidate.matchType,
    createdAt: now,
    updatedAt: now
  };
  upsertFieldSourceRecord(sourceRecord);
  var patch = {
    id: 'patch_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6),
    enabled: true,
    jsonPath: candidate.jsonPath,
    value: parsedValue,
    valueType: valueType || inferValueTypeFromPrimitive(parsedValue),
    sourceId: sourceId,
    createdAt: now
  };
  upsertFieldMockPatch(candidate.mockKey, candidate.method, patch, { once: !!once });
  materializeFieldMockResponseBody(candidate.mockKey, candidate.method, candidate.requestId);
  return { sourceRecord: sourceRecord, patch: patch };
}

function materializeFieldMockResponseBody(mockKey, method, requestId) {
  if (!mockKey) return;
  var rule = state.mockRules[mockKey];
  if (!rule || !hasResponsePatches(rule)) return;
  var baseBody = null;
  if (requestId && typeof findRequestById === 'function') {
    var req = findRequestById(requestId);
    baseBody = getRecordResponseJson(req);
  }
  if (!baseBody) return;
  var normalized = normalizeRule(rule, mockKey, method);
  var built = buildMockedResponseBody(
    { response: { bodyEnabled: false, body: null, patches: normalized.response.patches } },
    baseBody
  );
  normalized.response.bodyEnabled = true;
  normalized.response.body = built.body;
  state.mockRules[mockKey] = normalized;
  saveMockRules();
}
