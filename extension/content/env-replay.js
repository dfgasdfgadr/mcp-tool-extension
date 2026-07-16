'use strict';

var ENV_REPLAY_CONFIG_PREFIX = 'ai_req_env_replay_config_';
var ENV_REPLAY_SELECTIONS_PREFIX = 'ai_req_env_replay_selections_';
var ENV_REPLAY_HIT_MSG = 'AI_REQ_ANALYZER_ENV_REPLAY_HIT';
var ENV_REPLAY_RESULT_MSG = 'AI_REQ_ANALYZER_ENV_REPLAY_RESULT';
var ENV_REPLAY_CONSUMED_MSG = 'AI_REQ_ANALYZER_ENV_REPLAY_CONSUMED';

function envReplayConfigKey(host) {
  return ENV_REPLAY_CONFIG_PREFIX + (host || location.hostname);
}

function envReplaySelectionsKey(host) {
  return ENV_REPLAY_SELECTIONS_PREFIX + (host || location.hostname);
}

function envReplayHostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname;
  } catch (e) {
    return '';
  }
}

function loadEnvReplayConfig() {
  try {
    var raw = storageGet(envReplayConfigKey(), null);
    if (raw) {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      state.envReplayConfig = (parsed && typeof parsed === 'object') ? parsed : null;
    } else {
      state.envReplayConfig = null;
    }
  } catch (e) {
    state.envReplayConfig = null;
  }
}

function saveEnvReplayConfig(prodOrigin, tokenStorageKey, manualToken, prodHeadersJson) {
  var trimmed = String(prodOrigin || '').trim();
  if (!trimmed) {
    state.envReplayConfig = null;
    storageSet(envReplayConfigKey(), null);
    if (typeof syncEnvReplaySelectionsToPage === 'function') syncEnvReplaySelectionsToPage();
    return;
  }
  if (trimmed.indexOf('://') === -1) trimmed = 'https://' + trimmed;
  // 解析自定义请求头 JSON
  var prodHeaders = null;
  var rawHeaders = String(prodHeadersJson || '').trim();
  if (rawHeaders) {
    try {
      var parsed = JSON.parse(rawHeaders);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prodHeaders = {};
        Object.keys(parsed).forEach(function (k) { prodHeaders[k] = String(parsed[k]); });
      }
    } catch (e) {
      prodHeaders = null;
    }
  }
  var cfg = {
    prodOrigin: trimmed,
    tokenStorageKey: (String(tokenStorageKey || '').trim()) || 'token',
    manualToken: String(manualToken || '').trim(),
    prodHeaders: prodHeaders,
    updatedAt: Date.now()
  };
  state.envReplayConfig = cfg;
  storageSet(envReplayConfigKey(), JSON.stringify(cfg));
  if (typeof syncEnvReplaySelectionsToPage === 'function') syncEnvReplaySelectionsToPage();
}

function getEnvReplayProdOrigin() {
  return (state.envReplayConfig && state.envReplayConfig.prodOrigin) || '';
}

function getEnvReplayTokenStorageKey() {
  return (state.envReplayConfig && state.envReplayConfig.tokenStorageKey) || 'token';
}

function getEnvReplayManualToken() {
  return (state.envReplayConfig && state.envReplayConfig.manualToken) || '';
}

function getEnvReplayProdHeaders() {
  return (state.envReplayConfig && state.envReplayConfig.prodHeaders) || null;
}

function isEnvReplayConfiguredForCurrentHost() {
  var prod = getEnvReplayProdOrigin();
  if (!prod) return false;
  var prodHost = envReplayHostnameFromOrigin(prod);
  return !!prodHost && prodHost !== location.hostname;
}

function loadEnvReplaySelections() {
  try {
    var raw = storageGet(envReplaySelectionsKey(), null);
    if (raw) {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      state.envReplaySelections = (parsed && typeof parsed === 'object') ? parsed : {};
    } else {
      state.envReplaySelections = {};
    }
  } catch (e) {
    state.envReplaySelections = {};
  }
}

function saveEnvReplaySelections() {
  storageSet(envReplaySelectionsKey(), JSON.stringify(state.envReplaySelections || {}));
}

function normalizeEnvReplayQuery(queryStr) {
  if (!queryStr) return '';
  var str = String(queryStr).replace(/^\?/, '');
  if (!str) return '';
  var pairs = [];
  try {
    str.split('&').forEach(function (pair) {
      if (!pair) return;
      var idx = pair.indexOf('=');
      var k, v;
      if (idx === -1) { k = pair; v = ''; } else { k = pair.substring(0, idx); v = pair.substring(idx + 1); }
      pairs.push([k, v]);
    });
  } catch (e) {
    return str;
  }
  pairs.sort(function (a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  return pairs.map(function (p) { return p[0] + '=' + p[1]; }).join('&');
}

function buildEnvReplaySelectionKey(method, pathname, query, matchQuery) {
  var m = String(method || 'GET').toUpperCase();
  var p = pathname || '';
  var key = m + '|' + p;
  if (matchQuery) {
    var nq = normalizeEnvReplayQuery(query);
    key += '|' + nq;
  }
  return key;
}

function parseUrlForEnvReplay(url) {
  try {
    var u = new URL(url, location.href);
    return { pathname: u.pathname, query: u.search ? u.search.substring(1) : '' };
  } catch (e) {
    return { pathname: url, query: '' };
  }
}

function upsertEnvReplaySelection(method, pathname, query, matchQuery, enabled, mode) {
  if (!state.envReplaySelections || typeof state.envReplaySelections !== 'object') {
    state.envReplaySelections = {};
  }
  var key = buildEnvReplaySelectionKey(method, pathname, query, matchQuery);
  state.envReplaySelections[key] = {
    enabled: !!enabled,
    method: String(method || 'GET').toUpperCase(),
    pathname: pathname,
    matchQuery: !!matchQuery,
    mode: mode === 'persistent' ? 'persistent' : 'next',
    enabledAt: enabled ? Date.now() : 0
  };
  saveEnvReplaySelections();
  if (typeof syncEnvReplaySelectionsToPage === 'function') syncEnvReplaySelectionsToPage();
  return key;
}

function removeEnvReplaySelection(method, pathname, query, matchQuery) {
  if (!state.envReplaySelections) return;
  var key = buildEnvReplaySelectionKey(method, pathname, query, matchQuery);
  delete state.envReplaySelections[key];
  saveEnvReplaySelections();
  if (typeof syncEnvReplaySelectionsToPage === 'function') syncEnvReplaySelectionsToPage();
}

function clearAllEnvReplaySelections() {
  state.envReplaySelections = {};
  saveEnvReplaySelections();
  if (typeof syncEnvReplaySelectionsToPage === 'function') syncEnvReplaySelectionsToPage();
}

function consumeEnvReplaySelectionByKey(key) {
  if (!state.envReplaySelections || !state.envReplaySelections[key]) return;
  var sel = state.envReplaySelections[key];
  if (sel.mode === 'next') {
    delete state.envReplaySelections[key];
    saveEnvReplaySelections();
    if (typeof syncEnvReplaySelectionsToPage === 'function') syncEnvReplaySelectionsToPage();
  }
}

function findEnvReplaySelectionInState(method, url) {
  if (!isEnvReplayConfiguredForCurrentHost()) return null;
  if (String(method || '').toUpperCase() !== 'GET') return null;
  var parsed = parseUrlForEnvReplay(url);
  var sels = state.envReplaySelections || {};
  var keys = Object.keys(sels);
  for (var i = 0; i < keys.length; i++) {
    var sel = sels[keys[i]];
    if (!sel || !sel.enabled || String(sel.method).toUpperCase() !== 'GET') continue;
    if (sel.pathname !== parsed.pathname) continue;
    if (sel.matchQuery) {
      // key 形如 GET|/path|normalizedQuery，取第三段比对
      var parts = keys[i].split('|');
      var selNq = parts.length >= 3 ? parts.slice(2).join('|') : '';
      var nq = normalizeEnvReplayQuery(parsed.query);
      if (nq !== selNq) continue;
    }
    sel.__key = keys[i];
    return sel;
  }
  return null;
}
