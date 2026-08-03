(function (root) {
  'use strict';

  var EPOCH_STORAGE_PREFIX = 'ai_req_session_epoch_';
  var TARGET_REGISTRY_STORAGE_KEY = 'ai_req_runtime_auth_target_registry';
  var registeredTargets = Object.create(null);
  var registryTrusted = false;
  var registryLoadResult = null;
  var registryMutationQueue = Promise.resolve();
  var registryLastResult = Promise.resolve({ ok: true });
  var epochs = Object.create(null);
  var epochTrusted = Object.create(null);
  var epochLoads = Object.create(null);
  var epochQueues = Object.create(null);
  var liveAuthByOrigin = Object.create(null);
  var liveObservationQueues = Object.create(null);
  var samePathApiByTab = Object.create(null);
  var invalidationHook = null;
  var LIVE_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
  var SAME_PATH_MAX_AGE_MS = 5 * 60 * 1000;
  // Recently-expired records are retained (not usable for dispatch) so an
  // MCP call can revalidate them with a lightweight probe request.
  var STALE_AUTH_MAX_AGE_MS = 30 * 60 * 1000;
  // Live auth records are mirrored into chrome.storage.session so an MV3
  // service-worker restart does not silently wipe observed credentials.
  // storage.session is scoped to the browser session and never hits disk.
  var LIVE_AUTH_STORAGE_KEY = 'ai_req_live_auth_snapshot_v1';
  var SAME_PATH_STORAGE_KEY = 'ai_req_same_path_api_snapshot_v1';
  var liveAuthRestoreResult = null;
  var liveAuthPersistQueue = Promise.resolve();
  var samePathRestoreResult = null;
  var samePathPersistQueue = Promise.resolve();

  function normalizeHttpUrl(value) {
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname || parsed.origin === 'null') return null;
      return parsed;
    } catch (_err) {
      return null;
    }
  }

  function normalizeOrigin(value) {
    var parsed = normalizeHttpUrl(value);
    return parsed ? parsed.origin : '';
  }

  function canonicalize(value, ancestors) {
    if (value === null) return null;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      if (ancestors && ancestors.indexOf(value) >= 0) {
        throw new Error('cyclic cookie partition metadata');
      }
      var arrayAncestors = (ancestors || []).concat([value]);
      return value.map(function (item) {
        return canonicalize(item, arrayAncestors);
      });
    }
    if (!value || typeof value !== 'object') return null;
    if (ancestors && ancestors.indexOf(value) >= 0) {
      throw new Error('cyclic cookie partition metadata');
    }
    var objectAncestors = (ancestors || []).concat([value]);
    var output = {};
    var keys = Object.keys(value).sort();
    var i;
    for (i = 0; i < keys.length; i++) {
      output[keys[i]] = canonicalize(value[keys[i]], objectAncestors);
    }
    return output;
  }

  function normalizeCookieContext(value) {
    var source = value && typeof value === 'object' ? value : {};
    return {
      storeId: source.storeId == null ? '' : String(source.storeId),
      partitionKey: source.partitionKey == null
        ? null
        : canonicalize(source.partitionKey)
    };
  }

  function cookieContextKey(value) {
    var context = normalizeCookieContext(value);
    return context.storeId + '|' + JSON.stringify(context.partitionKey);
  }

  function hasCookieContextMetadata(value) {
    return !!(
      value &&
      typeof value === 'object' &&
      (
        Object.prototype.hasOwnProperty.call(value, 'storeId') ||
        Object.prototype.hasOwnProperty.call(value, 'partitionKey')
      )
    );
  }

  function normalizeTargetCookieContext(value) {
    if (value == null) return null;
    if (
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, 'storeId') ||
      !Object.prototype.hasOwnProperty.call(value, 'partitionKey')
    ) {
      throw new Error('incomplete target cookie context');
    }
    var normalized = normalizeCookieContext(value);
    if (!normalized.storeId) {
      throw new Error('missing target cookie store');
    }
    return normalized;
  }

  function sameRegisteredTarget(target, pathname, cookieContext) {
    if (!target || target.pathname !== pathname) return false;
    if (!target.cookieContext || !cookieContext) {
      return target.cookieContext === null && cookieContext === null;
    }
    return cookieContextKey(target.cookieContext) ===
      cookieContextKey(cookieContext);
  }

  function registerTarget(value, cookieContext) {
    var parsed = normalizeHttpUrl(value);
    if (!parsed) return '';
    var origin = parsed.origin;
    var pathname = parsed.pathname || '/';
    var targetCookieContext;
    try {
      targetCookieContext = normalizeTargetCookieContext(cookieContext);
    } catch (_contextError) {
      return '';
    }
    var operation = registryMutationQueue.then(function (previousResult) {
      if (previousResult && !previousResult.ok) throw previousResult.error;
      return requireRegistryLoad();
    }).then(function () {
      var nextRegistry = cloneRegistry(registeredTargets);
      if (!nextRegistry[origin]) nextRegistry[origin] = [];
      var targets = nextRegistry[origin];
      var existingIndex = -1;
      var i;
      for (i = 0; i < targets.length; i++) {
        if (sameRegisteredTarget(
          targets[i],
          pathname,
          targetCookieContext
        )) {
          existingIndex = i;
          break;
        }
      }
      var nextTarget = {
        pathname: pathname,
        cookieContext: targetCookieContext
      };
      if (existingIndex >= 0) {
        targets[existingIndex] = nextTarget;
      } else {
        targets.push(nextTarget);
      }
      return persistRegistry(nextRegistry).then(function () {
        registeredTargets = nextRegistry;
        registryTrusted = true;
        return origin;
      });
    });
    registryLastResult = operation.then(function (result) {
      return { ok: true, value: result };
    }, function (error) {
      registryTrusted = false;
      return { ok: false, error: error };
    });
    registryMutationQueue = registryLastResult;
    return origin;
  }

  function cloneRegistry(source) {
    var clone = Object.create(null);
    Object.keys(source || {}).forEach(function (origin) {
      clone[origin] = (source[origin] || []).map(function (target) {
        return {
          pathname: target.pathname,
          cookieContext: target.cookieContext
            ? normalizeCookieContext(target.cookieContext)
            : null
        };
      });
    });
    return clone;
  }

  function serializeRegistry(source) {
    var records = [];
    Object.keys(source || {}).sort().forEach(function (origin) {
      (source[origin] || []).slice().sort(function (left, right) {
        if (left.pathname < right.pathname) return -1;
        if (left.pathname > right.pathname) return 1;
        var leftContext = left.cookieContext
          ? cookieContextKey(left.cookieContext)
          : '';
        var rightContext = right.cookieContext
          ? cookieContextKey(right.cookieContext)
          : '';
        return leftContext < rightContext ? -1 :
          (leftContext > rightContext ? 1 : 0);
      }).forEach(function (target) {
        records.push({
          origin: origin,
          pathname: target.pathname,
          cookieContext: target.cookieContext
            ? normalizeCookieContext(target.cookieContext)
            : null
        });
      });
    });
    return records;
  }

  function parseRegistry(value) {
    if (value == null) return Object.create(null);
    if (!Array.isArray(value)) {
      throw storageError(
        'TARGET_REGISTRY_STORAGE_GET_FAILED',
        'invalid target registry'
      );
    }
    var restored = Object.create(null);
    var i;
    for (i = 0; i < value.length; i++) {
      var record = value[i];
      var parsed = record && normalizeHttpUrl(record.origin);
      var restoredContext;
      try {
        restoredContext = normalizeTargetCookieContext(
          Object.prototype.hasOwnProperty.call(record || {}, 'cookieContext')
            ? record.cookieContext
            : null
        );
      } catch (_contextError) {
        restoredContext = undefined;
      }
      if (
        !parsed ||
        parsed.origin !== record.origin ||
        typeof record.pathname !== 'string' ||
        record.pathname.charAt(0) !== '/' ||
        restoredContext === undefined
      ) {
        throw storageError(
          'TARGET_REGISTRY_STORAGE_GET_FAILED',
          'invalid target registry record'
        );
      }
      if (!restored[record.origin]) restored[record.origin] = [];
      var existingIndex = -1;
      var targetIndex;
      for (targetIndex = 0; targetIndex < restored[record.origin].length; targetIndex++) {
        if (sameRegisteredTarget(
          restored[record.origin][targetIndex],
          record.pathname,
          restoredContext
        )) {
          existingIndex = targetIndex;
          break;
        }
      }
      var restoredTarget = {
        pathname: record.pathname,
        cookieContext: restoredContext
      };
      if (existingIndex >= 0) {
        restored[record.origin][existingIndex] = restoredTarget;
      } else {
        restored[record.origin].push(restoredTarget);
      }
    }
    return restored;
  }

  function loadRegistry() {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.get(TARGET_REGISTRY_STORAGE_KEY, function (items) {
          var lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            reject(storageError(
              'TARGET_REGISTRY_STORAGE_GET_FAILED',
              lastError.message || 'target registry storage get failed'
            ));
            return;
          }
          try {
            registeredTargets = parseRegistry(
              items && items[TARGET_REGISTRY_STORAGE_KEY]
            );
            registryTrusted = true;
            resolve(true);
          } catch (error) {
            registryTrusted = false;
            reject(error);
          }
        });
      } catch (error) {
        registryTrusted = false;
        reject(storageError(
          'TARGET_REGISTRY_STORAGE_GET_FAILED',
          error && error.message ? error.message : String(error)
        ));
      }
    });
  }

  function persistRegistry(nextRegistry) {
    return new Promise(function (resolve, reject) {
      var payload = {};
      payload[TARGET_REGISTRY_STORAGE_KEY] = serializeRegistry(nextRegistry);
      try {
        chrome.storage.local.set(payload, function () {
          var lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            reject(storageError(
              'TARGET_REGISTRY_STORAGE_SET_FAILED',
              lastError.message || 'target registry storage set failed'
            ));
            return;
          }
          resolve(true);
        });
      } catch (error) {
        reject(storageError(
          'TARGET_REGISTRY_STORAGE_SET_FAILED',
          error && error.message ? error.message : String(error)
        ));
      }
    });
  }

  function requireRegistryLoad() {
    return registryLoadResult.then(function (result) {
      if (!result.ok) throw result.error;
      return true;
    });
  }

  function ensureRegistryLoaded() {
    var pending = registryLastResult;
    return requireRegistryLoad().then(function () {
      return pending;
    }).then(function (result) {
      if (!result.ok) throw result.error;
      if (!registryTrusted) {
        throw storageError(
          'TARGET_REGISTRY_UNTRUSTED',
          'target registry is untrusted'
        );
      }
      return true;
    });
  }

  function getEpoch(origin) {
    var normalized = normalizeOrigin(origin);
    if (!normalized || epochTrusted[normalized] !== true) return 0;
    return Object.prototype.hasOwnProperty.call(epochs, normalized)
      ? epochs[normalized]
      : 0;
  }

  function epochStorageKey(origin) {
    var normalized = normalizeOrigin(origin);
    return normalized
      ? EPOCH_STORAGE_PREFIX + encodeURIComponent(normalized)
      : '';
  }

  function storageError(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
  }

  function ensureEpochLoaded(origin) {
    var normalized = normalizeOrigin(origin);
    if (!normalized) return Promise.resolve(0);
    if (
      epochTrusted[normalized] === true &&
      Object.prototype.hasOwnProperty.call(epochs, normalized)
    ) {
      return Promise.resolve(epochs[normalized]);
    }
    if (epochLoads[normalized]) return epochLoads[normalized];

    var load = new Promise(function (resolve, reject) {
      var key = epochStorageKey(normalized);
      try {
        chrome.storage.local.get(key, function (items) {
          var lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            epochTrusted[normalized] = false;
            reject(storageError(
              'SESSION_EPOCH_STORAGE_GET_FAILED',
              lastError.message || 'session epoch storage get failed'
            ));
            return;
          }
          var hasStoredEpoch = !!(
            items &&
            Object.prototype.hasOwnProperty.call(items, key)
          );
          var stored = hasStoredEpoch ? items[key] : 0;
          if (
            typeof stored !== 'number' ||
            !isFinite(stored) ||
            stored < 0 ||
            Math.floor(stored) !== stored ||
            stored > 9007199254740991
          ) {
            epochTrusted[normalized] = false;
            reject(storageError(
              'SESSION_EPOCH_INVALID',
              'stored session epoch is invalid'
            ));
            return;
          }
          epochs[normalized] = stored;
          epochTrusted[normalized] = true;
          resolve(epochs[normalized]);
        });
      } catch (error) {
        epochTrusted[normalized] = false;
        reject(storageError(
          'SESSION_EPOCH_STORAGE_GET_FAILED',
          error && error.message ? error.message : String(error)
        ));
      }
    });
    epochLoads[normalized] = load.then(function (epoch) {
      return epoch;
    }, function (error) {
      delete epochLoads[normalized];
      epochTrusted[normalized] = false;
      throw error;
    });
    return epochLoads[normalized];
  }

  function persistEpoch(origin, epoch) {
    return new Promise(function (resolve, reject) {
      var payload = {};
      payload[epochStorageKey(origin)] = epoch;
      try {
        chrome.storage.local.set(payload, function () {
          var lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            reject(storageError(
              'SESSION_EPOCH_STORAGE_SET_FAILED',
              lastError.message || 'session epoch storage set failed'
            ));
            return;
          }
          resolve(epoch);
        });
      } catch (error) {
        reject(storageError(
          'SESSION_EPOCH_STORAGE_SET_FAILED',
          error && error.message ? error.message : String(error)
        ));
      }
    });
  }

  function rebindLiveAuthEpoch(origin, epoch) {
    var records = liveAuthByOrigin[origin];
    if (!records) return;
    Object.keys(records).forEach(function (tabId) {
      if (records[tabId]) records[tabId].sessionEpoch = epoch;
    });
  }

  function bumpEpoch(origin, reason) {
    var normalized = normalizeOrigin(origin);
    if (!normalized) return Promise.resolve(0);
    var previous = epochQueues[normalized] || Promise.resolve();
    var next = previous.catch(function () {}).then(function () {
      return ensureEpochLoaded(normalized);
    }).then(function (current) {
      var candidate = current + 1;
      if (!Number.isSafeInteger(candidate) || candidate < 0) {
        markEpochUntrusted(normalized);
        delete liveAuthByOrigin[normalized];
        scheduleLiveAuthPersist();
        throw storageError(
          'SESSION_EPOCH_OVERFLOW',
          'session epoch cannot be incremented safely'
        );
      }
      var preserveLiveAuth = reason === 'cookie_changed' ||
        reason === 'cookie_removed';
      markEpochUntrusted(normalized);
      return persistEpoch(normalized, candidate).then(function () {
        epochs[normalized] = candidate;
        epochTrusted[normalized] = true;
        if (preserveLiveAuth) {
          // Cookie jar churn must not drop a still-valid live Bearer observation.
          rebindLiveAuthEpoch(normalized, candidate);
        } else {
          delete liveAuthByOrigin[normalized];
          purgeSamePathApiForOrigin(normalized);
        }
        scheduleLiveAuthPersist();
        scheduleSamePathPersist();
        if (typeof invalidationHook === 'function') {
          try {
            invalidationHook(normalized, reason || '');
          } catch (_err) {}
        }
        return candidate;
      }, function (error) {
        markEpochUntrusted(normalized);
        delete liveAuthByOrigin[normalized];
        scheduleLiveAuthPersist();
        throw error;
      });
    });
    epochQueues[normalized] = next;
    return next;
  }

  function domainMatches(hostname, domain) {
    var normalized = String(domain || '').trim().replace(/^\./, '').toLowerCase();
    if (!normalized) return false;
    var host = String(hostname || '').toLowerCase();
    return host === normalized || host.endsWith('.' + normalized);
  }

  function cookieDomainMatches(hostname, cookie) {
    var normalized = String(cookie.domain || '')
      .trim()
      .replace(/^\./, '')
      .toLowerCase();
    var host = String(hostname || '').toLowerCase();
    if (!normalized) return false;
    if (cookie.hostOnly === true) return host === normalized;
    return domainMatches(host, normalized);
  }

  function cookiePathMatches(requestPath, cookiePath) {
    var request = typeof requestPath === 'string' && requestPath
      ? requestPath
      : '/';
    var cookie = typeof cookiePath === 'string' && cookiePath
      ? cookiePath
      : '/';
    if (request === cookie) return true;
    if (request.indexOf(cookie) !== 0) return false;
    if (cookie.charAt(cookie.length - 1) === '/') return true;
    return request.charAt(cookie.length) === '/';
  }

  function mapCookieToRegisteredOrigins(cookie) {
    if (!registryTrusted || !cookie || typeof cookie !== 'object') return [];
    try {
      var cookiePath = typeof cookie.path === 'string' && cookie.path
        ? cookie.path
        : '/';
      if (
        !Object.prototype.hasOwnProperty.call(cookie, 'storeId') ||
        cookie.storeId == null
      ) {
        return [];
      }
      var eventContextKey = cookieContextKey(cookie);
      return Object.keys(registeredTargets).filter(function (origin) {
        var parsed = normalizeHttpUrl(origin);
        if (!parsed || !cookieDomainMatches(parsed.hostname, cookie)) return false;
        if (cookie.secure === true && parsed.protocol !== 'https:') return false;
        var targets = registeredTargets[origin];
        var i;
        for (i = 0; i < targets.length; i++) {
          if (!targets[i].cookieContext) continue;
          if (
            cookieContextKey(targets[i].cookieContext) !== eventContextKey
          ) continue;
          if (!cookiePathMatches(targets[i].pathname, cookiePath)) continue;
          return true;
        }
        return false;
      });
    } catch (_contextError) {
      return [];
    }
  }

  function selectUniqueCookieContext(cookies) {
    var source = Array.isArray(cookies) ? cookies : [];
    var contexts = Object.create(null);
    var i;
    for (i = 0; i < source.length; i++) {
      if (!source[i] || typeof source[i] !== 'object') continue;
      try {
        var context = normalizeCookieContext(source[i]);
        contexts[cookieContextKey(context)] = context;
      } catch (_contextError) {
        return { ok: false, errorCode: 'AUTH_COOKIE_MISSING' };
      }
    }
    var keys = Object.keys(contexts);
    if (!keys.length) {
      return { ok: false, errorCode: 'AUTH_COOKIE_MISSING' };
    }
    if (keys.length > 1) {
      return { ok: false, errorCode: 'AUTH_ACCOUNT_AMBIGUOUS' };
    }
    return {
      ok: true,
      cookieContext: contexts[keys[0]]
    };
  }

  function setInvalidationHook(hook) {
    invalidationHook = typeof hook === 'function' ? hook : null;
  }

  function markEpochUntrusted(origin) {
    var normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    epochTrusted[normalized] = false;
    delete epochLoads[normalized];
    // Do not wipe liveAuth here — bumpEpoch decides whether to rebind (cookie)
    // or delete (logout / credential fingerprint change / tab invalidation).
    return true;
  }

  function isEpochTrusted(origin) {
    var normalized = normalizeOrigin(origin);
    return !!(normalized && epochTrusted[normalized] === true);
  }

  function liveAuthError(errorCode) {
    return { ok: false, errorCode: errorCode };
  }

  function normalizeObservedAt(value) {
    return typeof value === 'number' &&
      isFinite(value) &&
      value >= 0
      ? value
      : null;
  }

  function collectExplicitAuth(requestHeaders) {
    var source = requestHeaders && typeof requestHeaders === 'object'
      ? requestHeaders
      : null;
    if (!source) return liveAuthError('AUTH_OBSERVATION_INVALID');
    var hint = AiRuntimeAuth.describeAuthHeaders(source);
    var declared = Array.isArray(hint.authHeaderNames)
      ? hint.authHeaderNames
      : [];
    var allowed = Object.create(null);
    var i;
    for (i = 0; i < declared.length; i++) {
      var normalized = String(declared[i] || '').trim().toLowerCase();
      if (!normalized || normalized === 'cookie' || normalized === 'set-cookie') {
        continue;
      }
      allowed[normalized] = true;
    }

    var explicitHeaders = Object.create(null);
    var normalizedToOriginal = Object.create(null);
    var names = Object.keys(source);
    for (i = 0; i < names.length; i++) {
      var name = names[i];
      var normalizedName = String(name || '').trim().toLowerCase();
      if (!allowed[normalizedName]) continue;
      if (normalizedToOriginal[normalizedName]) {
        return liveAuthError('AUTH_SOURCE_UNSAFE');
      }
      var value = source[name];
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        continue;
      }
      if (!String(value)) continue;
      normalizedToOriginal[normalizedName] = name;
      explicitHeaders[name] = value;
    }

    var authHeaderNames = Object.keys(normalizedToOriginal).sort();
    if (!authHeaderNames.length) {
      return { ok: false, skipped: true };
    }
    return {
      ok: true,
      explicitHeaders: explicitHeaders,
      authHeaderNames: authHeaderNames,
      detectedAuthType: hint.detectedAuthType
    };
  }

  function canonicalCredentialSnapshot(explicitHeaders) {
    var pairs = Object.keys(explicitHeaders).map(function (name) {
      return [
        String(name).trim().toLowerCase(),
        String(explicitHeaders[name])
      ];
    }).sort(function (left, right) {
      if (left[0] < right[0]) return -1;
      if (left[0] > right[0]) return 1;
      if (left[1] < right[1]) return -1;
      if (left[1] > right[1]) return 1;
      return 0;
    });
    return pairs.map(function (pair) {
      return pair[0].length + ':' + pair[0] +
        pair[1].length + ':' + pair[1];
    }).join('');
  }

  // Short non-reversible tag used only to let users tell accounts apart.
  // Never expose the fingerprint itself (it contains raw credential bytes).
  function fingerprintAccountTag(fingerprint) {
    var hash = 0x811c9dc5;
    var str = String(fingerprint || '');
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ('0000000' + hash.toString(16)).slice(-8);
  }

  function getLiveAuthStorageArea() {
    try {
      return (
        typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.session
      ) ? chrome.storage.session : null;
    } catch (_err) {
      return null;
    }
  }

  function serializeLiveAuthSnapshot() {
    var snapshot = Object.create(null);
    Object.keys(liveAuthByOrigin).forEach(function (origin) {
      var records = liveAuthByOrigin[origin];
      if (!records) return;
      var out = Object.create(null);
      Object.keys(records).forEach(function (tabId) {
        var record = records[tabId];
        if (!record) return;
        var explicitHeaders = Object.create(null);
        Object.keys(record.explicitHeaders || {}).forEach(function (name) {
          explicitHeaders[name] = record.explicitHeaders[name];
        });
        out[tabId] = {
          origin: record.origin,
          tabId: record.tabId,
          explicitHeaders: explicitHeaders,
          authHeaderNames: (record.authHeaderNames || []).slice(),
          detectedAuthType: record.detectedAuthType,
          observedAt: record.observedAt,
          sessionEpoch: record.sessionEpoch,
          fingerprint: record.fingerprint
        };
      });
      if (Object.keys(out).length) snapshot[origin] = out;
    });
    return snapshot;
  }

  // Write-through mirror of liveAuthByOrigin. Serialized behind a queue so
  // bursts of observations collapse into sequential storage writes.
  function scheduleLiveAuthPersist() {
    liveAuthPersistQueue = liveAuthPersistQueue
      .catch(function () {})
      .then(function () {
        return new Promise(function (resolve) {
          var area = getLiveAuthStorageArea();
          if (!area) {
            resolve(false);
            return;
          }
          var payload = {};
          payload[LIVE_AUTH_STORAGE_KEY] = serializeLiveAuthSnapshot();
          try {
            area.set(payload, function () {
              resolve(!(chrome.runtime && chrome.runtime.lastError));
            });
          } catch (_err) {
            resolve(false);
          }
        });
      });
    return liveAuthPersistQueue;
  }

  // One-time restore of the persisted snapshot after a service-worker
  // restart. Records outside the stale-retention window are dropped; the
  // epoch checks in getLiveAuth/getStaleAuthForProbe reject anything whose
  // sessionEpoch no longer matches the trusted epoch.
  function ensureLiveAuthRestored() {
    if (liveAuthRestoreResult) return liveAuthRestoreResult;
    liveAuthRestoreResult = new Promise(function (resolve) {
      var area = getLiveAuthStorageArea();
      if (!area) {
        resolve(false);
        return;
      }
      try {
        area.get(LIVE_AUTH_STORAGE_KEY, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          var snapshot = items && items[LIVE_AUTH_STORAGE_KEY];
          var now = Date.now();
          if (snapshot && typeof snapshot === 'object') {
            Object.keys(snapshot).forEach(function (origin) {
              var normalized = normalizeOrigin(origin);
              if (!normalized || normalized !== origin) return;
              var records = snapshot[origin];
              if (!records || typeof records !== 'object') return;
              Object.keys(records).forEach(function (tabIdKey) {
                var record = records[tabIdKey];
                if (!record || typeof record !== 'object') return;
                var tabId = Number(tabIdKey);
                var observedAt = normalizeObservedAt(record.observedAt);
                if (!Number.isSafeInteger(tabId) || tabId < 0) return;
                if (observedAt === null) return;
                if (now < observedAt || now - observedAt > STALE_AUTH_MAX_AGE_MS) {
                  return;
                }
                if (
                  !record.explicitHeaders ||
                  typeof record.explicitHeaders !== 'object'
                ) {
                  return;
                }
                if (!liveAuthByOrigin[normalized]) {
                  liveAuthByOrigin[normalized] = Object.create(null);
                }
                // In-memory records are newer — never overwrite them.
                if (liveAuthByOrigin[normalized][tabId]) return;
                liveAuthByOrigin[normalized][tabId] = {
                  origin: normalized,
                  tabId: tabId,
                  explicitHeaders: record.explicitHeaders,
                  authHeaderNames: Array.isArray(record.authHeaderNames)
                    ? record.authHeaderNames
                    : [],
                  detectedAuthType:
                    typeof record.detectedAuthType === 'string'
                      ? record.detectedAuthType
                      : 'none',
                  observedAt: observedAt,
                  sessionEpoch: Number(record.sessionEpoch || 0),
                  fingerprint: String(record.fingerprint || '')
                };
              });
            });
          }
          resolve(true);
        });
      } catch (_err) {
        resolve(false);
      }
    });
    return liveAuthRestoreResult;
  }

  function serializeSamePathSnapshot() {
    var snapshot = Object.create(null);
    var now = Date.now();
    Object.keys(samePathApiByTab).forEach(function (tabIdKey) {
      var list = samePathApiByTab[tabIdKey];
      if (!Array.isArray(list) || !list.length) return;
      var kept = list.filter(function (row) {
        return row &&
          row.apiOrigin &&
          row.pathPatternKey &&
          typeof row.observedAt === 'number' &&
          isFinite(row.observedAt) &&
          row.observedAt >= 0 &&
          now - row.observedAt <= SAME_PATH_MAX_AGE_MS;
      }).map(function (row) {
        return {
          apiOrigin: row.apiOrigin,
          pathPatternKey: row.pathPatternKey,
          observedAt: row.observedAt
        };
      });
      if (kept.length) snapshot[tabIdKey] = kept;
    });
    return snapshot;
  }

  function scheduleSamePathPersist() {
    samePathPersistQueue = samePathPersistQueue
      .catch(function () {})
      .then(function () {
        return new Promise(function (resolve) {
          var area = getLiveAuthStorageArea();
          if (!area) {
            resolve(false);
            return;
          }
          var payload = {};
          payload[SAME_PATH_STORAGE_KEY] = serializeSamePathSnapshot();
          try {
            area.set(payload, function () {
              resolve(!(chrome.runtime && chrome.runtime.lastError));
            });
          } catch (_err) {
            resolve(false);
          }
        });
      });
    return samePathPersistQueue;
  }

  function ensureSamePathRestored() {
    if (samePathRestoreResult) return samePathRestoreResult;
    samePathRestoreResult = new Promise(function (resolve) {
      var area = getLiveAuthStorageArea();
      if (!area) {
        resolve(false);
        return;
      }
      try {
        area.get(SAME_PATH_STORAGE_KEY, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          var snapshot = items && items[SAME_PATH_STORAGE_KEY];
          var now = Date.now();
          if (snapshot && typeof snapshot === 'object') {
            Object.keys(snapshot).forEach(function (tabIdKey) {
              var tabId = Number(tabIdKey);
              if (!Number.isSafeInteger(tabId) || tabId < 0) return;
              var rows = snapshot[tabIdKey];
              if (!Array.isArray(rows)) return;
              // In-memory rows are newer — never overwrite a tab that already
              // has observations from this SW lifetime.
              if (samePathApiByTab[tabId] && samePathApiByTab[tabId].length) {
                return;
              }
              var restored = [];
              rows.forEach(function (row) {
                if (!row || typeof row !== 'object') return;
                var apiOrigin = normalizeOrigin(row.apiOrigin);
                var pathPatternKey = String(row.pathPatternKey || '');
                var observedAt = normalizeObservedAt(row.observedAt);
                if (!apiOrigin || !pathPatternKey || observedAt === null) return;
                if (now < observedAt || now - observedAt > SAME_PATH_MAX_AGE_MS) {
                  return;
                }
                restored.push({
                  apiOrigin: apiOrigin,
                  pathPatternKey: pathPatternKey,
                  observedAt: observedAt
                });
              });
              if (restored.length) samePathApiByTab[tabId] = restored;
            });
          }
          resolve(true);
        });
      } catch (_err) {
        resolve(false);
      }
    });
    return samePathRestoreResult;
  }

  function observeLiveAuth(observation) {
    var source = observation && typeof observation === 'object'
      ? observation
      : {};
    var origin = normalizeOrigin(source.apiOrigin);
    var observedAt = normalizeObservedAt(source.observedAt);
    if (
      !origin ||
      typeof source.tabId !== 'number' ||
      !Number.isSafeInteger(source.tabId) ||
      source.tabId < 0 ||
      observedAt === null
    ) {
      return Promise.resolve(liveAuthError('AUTH_OBSERVATION_INVALID'));
    }
    var extracted = collectExplicitAuth(source.requestHeaders);
    if (!extracted.ok) return Promise.resolve(extracted);

    var tabId = source.tabId;
    var fingerprint = canonicalCredentialSnapshot(extracted.explicitHeaders);
    var previous = liveObservationQueues[origin] || Promise.resolve();
    var operation = previous.catch(function () {}).then(function () {
      return ensureLiveAuthRestored();
    }).then(function () {
      return ensureEpochLoaded(origin);
    }).then(function () {
      var records = liveAuthByOrigin[origin];
      var existing = records && records[tabId];
      if (
        existing &&
        existing.sessionEpoch === getEpoch(origin) &&
        observedAt < existing.observedAt
      ) {
        // Older packet than what we already stored — ignore quietly.
        return {
          ignoreStaleObservation: true,
          epoch: existing.sessionEpoch
        };
      }
      if (
        existing &&
        existing.sessionEpoch === getEpoch(origin) &&
        existing.fingerprint === fingerprint
      ) {
        existing.observedAt = observedAt;
        return {
          skipSave: true,
          epoch: existing.sessionEpoch
        };
      }
      if (
        existing &&
        existing.sessionEpoch === getEpoch(origin) &&
        existing.fingerprint !== fingerprint
      ) {
        markEpochUntrusted(origin);
        return bumpEpoch(origin, 'live_auth_changed').then(function (epoch) {
          return { skipSave: false, epoch: epoch };
        });
      }
      return { skipSave: false, epoch: getEpoch(origin) };
    }).then(function (decision) {
      if (decision.ignoreStaleObservation) {
        return {
          ok: true,
          ignored: true,
          reason: 'stale_observation',
          sessionEpoch: decision.epoch
        };
      }
      if (decision.skipSave) {
        scheduleLiveAuthPersist();
        return {
          ok: true,
          refreshed: true,
          sessionEpoch: decision.epoch
        };
      }
      if (!liveAuthByOrigin[origin]) {
        liveAuthByOrigin[origin] = Object.create(null);
      }
      liveAuthByOrigin[origin][tabId] = {
        origin: origin,
        tabId: tabId,
        explicitHeaders: extracted.explicitHeaders,
        authHeaderNames: extracted.authHeaderNames,
        detectedAuthType: extracted.detectedAuthType,
        observedAt: observedAt,
        sessionEpoch: decision.epoch,
        fingerprint: fingerprint
      };
      scheduleLiveAuthPersist();
      return { ok: true, sessionEpoch: decision.epoch };
    });
    liveObservationQueues[origin] = operation;
    return operation;
  }

  function getLiveAuth(origin, tabId, now) {
    var normalized = normalizeOrigin(origin);
    var records = normalized && liveAuthByOrigin[normalized];
    var record = records && records[tabId];
    if (!record) return liveAuthError('AUTH_SESSION_MISSING');
    if (
      !isEpochTrusted(normalized) ||
      record.sessionEpoch !== getEpoch(normalized)
    ) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    var checkedAt = typeof now === 'number' && isFinite(now) ? now : Date.now();
    var ageMs = checkedAt - record.observedAt;
    if (checkedAt < record.observedAt || ageMs > LIVE_AUTH_MAX_AGE_MS) {
      // Only physically drop the record once it passes the stale-retention
      // window; before that it can still be revalidated via probe.
      if (checkedAt < record.observedAt || ageMs > STALE_AUTH_MAX_AGE_MS) {
        delete records[tabId];
        if (!Object.keys(records).length) delete liveAuthByOrigin[normalized];
        scheduleLiveAuthPersist();
      }
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    var explicitHeaders = Object.create(null);
    Object.keys(record.explicitHeaders).forEach(function (name) {
      explicitHeaders[name] = record.explicitHeaders[name];
    });
    return {
      ok: true,
      authBundle: {
        origin: record.origin,
        tabId: record.tabId,
        explicitHeaders: explicitHeaders,
        authHeaderNames: record.authHeaderNames.slice(),
        detectedAuthType: record.detectedAuthType,
        observedAt: record.observedAt,
        sessionEpoch: record.sessionEpoch
      }
    };
  }

  // Returns a recently-expired record for probe revalidation only. The record
  // must sit inside the stale-retention window and match the current trusted
  // epoch (cookie/logout changes bump the epoch and make it unusable).
  function getStaleAuthForProbe(origin, tabId, now) {
    var normalized = normalizeOrigin(origin);
    var records = normalized && liveAuthByOrigin[normalized];
    var record = records && records[tabId];
    if (!record) return liveAuthError('AUTH_SESSION_MISSING');
    if (
      !isEpochTrusted(normalized) ||
      record.sessionEpoch !== getEpoch(normalized)
    ) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    var checkedAt = typeof now === 'number' && isFinite(now) ? now : Date.now();
    var ageMs = checkedAt - record.observedAt;
    if (checkedAt < record.observedAt || ageMs > STALE_AUTH_MAX_AGE_MS) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    var explicitHeaders = Object.create(null);
    Object.keys(record.explicitHeaders).forEach(function (name) {
      explicitHeaders[name] = record.explicitHeaders[name];
    });
    return {
      ok: true,
      staleAuth: {
        origin: record.origin,
        tabId: record.tabId,
        explicitHeaders: explicitHeaders,
        authHeaderNames: record.authHeaderNames.slice(),
        observedAt: record.observedAt,
        sessionEpoch: record.sessionEpoch
      }
    };
  }

  function observeSamePathApi(observation) {
    var tabId = observation && observation.tabId;
    var apiOrigin = normalizeOrigin(observation && observation.apiOrigin);
    var pathPatternKey = String(observation && observation.pathPatternKey || '');
    var observedAt = Number(observation && observation.observedAt);
    if (
      !Number.isSafeInteger(tabId) ||
      tabId < 0 ||
      !apiOrigin ||
      !pathPatternKey ||
      !Number.isFinite(observedAt) ||
      observedAt < 0
    ) {
      return Promise.resolve({ ok: false, errorCode: 'AUTH_SOURCE_UNSAFE' });
    }
    // Never trust a future client clock — clamp so TTL cannot exceed 5 minutes from now.
    observedAt = Math.min(observedAt, Date.now());
    return ensureSamePathRestored().then(function () {
      if (!samePathApiByTab[tabId]) samePathApiByTab[tabId] = [];
      var list = samePathApiByTab[tabId].filter(function (row) {
        return !(row.apiOrigin === apiOrigin && row.pathPatternKey === pathPatternKey);
      });
      list.push({
        apiOrigin: apiOrigin,
        pathPatternKey: pathPatternKey,
        observedAt: observedAt
      });
      samePathApiByTab[tabId] = list;
      scheduleSamePathPersist();
      return { ok: true };
    });
  }

  function listSamePathApiOrigins(tabId, pathPatternKey, now) {
    var list = samePathApiByTab[tabId] || [];
    var ts = Number(now) || Date.now();
    var out = [];
    list.forEach(function (row) {
      if (row.pathPatternKey !== pathPatternKey) return;
      if (ts - row.observedAt > SAME_PATH_MAX_AGE_MS) return;
      if (out.indexOf(row.apiOrigin) < 0) out.push(row.apiOrigin);
    });
    return out;
  }

  function purgeSamePathApiForOrigin(origin) {
    var normalized = normalizeOrigin(origin);
    if (!normalized) return;
    Object.keys(samePathApiByTab).forEach(function (tabId) {
      var list = samePathApiByTab[tabId];
      if (!list) return;
      var filtered = list.filter(function (row) {
        return row.apiOrigin !== normalized;
      });
      if (filtered.length) {
        samePathApiByTab[tabId] = filtered;
      } else {
        delete samePathApiByTab[tabId];
      }
    });
    scheduleSamePathPersist();
  }

  async function selectSiteAffinityExecution(input) {
    await ensureLiveAuthRestored();
    await ensureSamePathRestored();
    var source = input || {};
    var meta = source.toolMeta || {};
    var tabs = Array.isArray(source.tabs) ? source.tabs : [];
    var initiatorTabId = source.initiatorTabId;
    var selectedTabId = source.selectedTabId;
    var pathPatternKey = meta.pathPatternKey ||
      AiSiteAffinity.buildPathPatternKey(meta.method, meta.pathname || meta.pathnameTemplate);
    var recordedHosts = AiSiteAffinity.collectRecordedHostnames(meta);
    var siteRoot = AiSiteAffinity.resolveTrustedSiteRoot(meta);
    var tokenRequired = hasExplicitTokenRequirement(meta);

    if (!tokenRequired) {
      var recorded = AiSiteAffinity.normalizeRecordedApiOrigin(meta);
      if (!recorded.ok) return liveAuthError(recorded.errorCode || 'AUTH_SOURCE_UNSAFE');
      var authType = String(meta.detectedAuthType || '').toLowerCase();
      return {
        ok: true,
        finalOrigin: recorded.origin,
        tabId: null,
        matchLevel: authType === 'cookie' ? 'cookie_only' : 'no_token',
        pathPatternKey: pathPatternKey
      };
    }

    function hostLevel(tabUrl, level) {
      var host = '';
      try { host = new URL(tabUrl).hostname.toLowerCase(); } catch (_e) { return false; }
      if (level === 'L1') return recordedHosts.indexOf(host) >= 0;
      return !!(siteRoot && AiSiteAffinity.sameSiteRoot(host, siteRoot));
    }

    function evaluate(tab, level) {
      if (!hostLevel(tab.url, level)) {
        return { ok: false, reason: 'host_mismatch' };
      }
      var samePath = listSamePathApiOrigins(tab.tabId, pathPatternKey, Date.now());
      var probe = AiSiteAffinity.resolveProbeOriginForTab({
        level: level,
        samePathApiOrigins: samePath,
        recordedApiOrigins: meta.recordedApiOrigins,
        toolHost: meta.toolHost || meta.apiHostname
      });
      if (!probe.ok) {
        return {
          ok: false,
          reason: probe.reason || probe.errorCode,
          errorCode: probe.errorCode
        };
      }
      if (tokenRequired) {
        var live = getLiveAuth(probe.origin, tab.tabId, Date.now());
        if (!live.ok) {
          var stale = getStaleAuthForProbe(probe.origin, tab.tabId, Date.now());
          // TTL-expired but still probeable → AUTH_SESSION_MISSING + probeHint.
          // Epoch mismatch / unrecoverable stale → AUTH_CONTEXT_STALE.
          var errorCode = live.errorCode === 'AUTH_CONTEXT_STALE' && !stale.ok
            ? 'AUTH_CONTEXT_STALE'
            : 'AUTH_SESSION_MISSING';
          return {
            ok: false,
            reason: errorCode === 'AUTH_CONTEXT_STALE'
              ? 'stale_live_auth'
              : 'missing_live_auth',
            errorCode: errorCode,
            probe: stale.ok
              ? { tabId: tab.tabId, origin: probe.origin }
              : null
          };
        }
      }
      return {
        ok: true,
        tabId: tab.tabId,
        url: tab.url,
        finalOrigin: probe.origin,
        matchLevel: level
      };
    }

    function buildEffectiveResult(entry, extra) {
      var result = {
        ok: true,
        finalOrigin: entry.finalOrigin,
        tabId: entry.tabId,
        matchLevel: entry.matchLevel,
        pathPatternKey: pathPatternKey
      };
      if (extra) Object.assign(result, extra);
      return result;
    }

    // Sanitized candidate list for user-side account selection. Carries only a
    // non-reversible accountTag — never raw credentials or fingerprints.
    function buildAmbiguousCandidates(effectiveList) {
      var candidates = [];
      for (var i = 0; i < effectiveList.length; i++) {
        var entry = effectiveList[i];
        var live = getLiveAuth(entry.finalOrigin, entry.tabId, Date.now());
        candidates.push({
          tabId: entry.tabId,
          url: entry.url || '',
          observedAt: live.ok ? live.authBundle.observedAt : null,
          accountTag: live.ok
            ? fingerprintAccountTag(
                canonicalCredentialSnapshot(live.authBundle.explicitHeaders)
              )
            : 'unknown',
          _fingerprint: live.ok
            ? canonicalCredentialSnapshot(live.authBundle.explicitHeaders)
            : ''
        });
      }
      return candidates;
    }

    function sanitizeCandidates(candidates) {
      return candidates.map(function (c) {
        return {
          tabId: c.tabId,
          url: c.url,
          observedAt: c.observedAt,
          accountTag: c.accountTag
        };
      });
    }

    function ambiguousWithCandidates(effectiveList) {
      var error = liveAuthError('AUTH_ACCOUNT_AMBIGUOUS');
      error.candidates = sanitizeCandidates(
        buildAmbiguousCandidates(effectiveList)
      );
      return error;
    }

    function collect(level) {
      var effective = [];
      var probeCandidates = [];
      var multiOrigin = false;
      var sourceUnsafe = false;
      var hostHitMissingAuth = false;
      var hostHitStaleAuth = false;
      var hostHit = false;
      tabs.forEach(function (tab) {
        if (!tab || typeof tab.tabId !== 'number') return;
        if (!hostLevel(tab.url, level)) return;
        hostHit = true;
        var ev = evaluate(tab, level);
        if (ev.ok) effective.push(ev);
        else if (ev.errorCode === 'AUTH_SOURCE_UNSAFE') sourceUnsafe = true;
        else if (ev.reason === 'multi_api_origin') multiOrigin = true;
        else if (ev.reason === 'stale_live_auth') {
          hostHitStaleAuth = true;
        } else if (ev.reason === 'missing_live_auth') {
          hostHitMissingAuth = true;
          if (ev.probe) probeCandidates.push(ev.probe);
        }
      });
      return {
        effective: effective,
        probeCandidates: probeCandidates,
        multiOrigin: multiOrigin,
        sourceUnsafe: sourceUnsafe,
        hostHitMissingAuth: hostHitMissingAuth,
        hostHitStaleAuth: hostHitStaleAuth,
        hostHit: hostHit
      };
    }

    var l1 = collect('L1');
    var l2 = null;
    var chosen = l1;
    if (!l1.effective.length) {
      l2 = collect('L2');
      chosen = l2;
    }
    var probeCandidates = l1.probeCandidates.length
      ? l1.probeCandidates
      : (l2 ? l2.probeCandidates : []);
    var multiOrigin = l1.multiOrigin || !!(l2 && l2.multiOrigin);
    var sourceUnsafe = l1.sourceUnsafe || !!(l2 && l2.sourceUnsafe);
    var hostHitMissingAuth = l1.hostHitMissingAuth ||
      !!(l2 && l2.hostHitMissingAuth);
    var hostHitStaleAuth = l1.hostHitStaleAuth ||
      !!(l2 && l2.hostHitStaleAuth);

    if (Number.isSafeInteger(initiatorTabId) && initiatorTabId >= 0) {
      var hit = chosen.effective.filter(function (e) {
        return e.tabId === initiatorTabId;
      });
      if (hit.length === 1) {
        return {
          ok: true,
          finalOrigin: hit[0].finalOrigin,
          tabId: hit[0].tabId,
          matchLevel: hit[0].matchLevel,
          pathPatternKey: pathPatternKey
        };
      }
      if (sourceUnsafe) return liveAuthError('AUTH_SOURCE_UNSAFE');
      return liveAuthError('AUTH_TAB_REQUIRED');
    }

    // Explicit user selection from a previous AUTH_ACCOUNT_AMBIGUOUS response.
    // Only honored against tabs that already passed evaluate() — it cannot be
    // used to pin an arbitrary tab.
    if (
      Number.isSafeInteger(selectedTabId) &&
      selectedTabId >= 0 &&
      chosen.effective.length >= 1
    ) {
      var picked = chosen.effective.filter(function (e) {
        return e.tabId === selectedTabId;
      });
      if (picked.length === 1) return buildEffectiveResult(picked[0]);
      // Stale or invalid selection: surface the current candidates again.
      return ambiguousWithCandidates(chosen.effective);
    }

    if (chosen.effective.length === 1) {
      return buildEffectiveResult(chosen.effective[0]);
    }
    if (chosen.effective.length > 1) {
      var originGroups = Object.create(null);
      var originKeys = [];
      chosen.effective.forEach(function (e) {
        if (!originGroups[e.finalOrigin]) {
          originGroups[e.finalOrigin] = true;
          originKeys.push(e.finalOrigin);
        }
      });
      // Distinct API origins (e.g. different ports) cannot be merged safely.
      if (originKeys.length > 1) return liveAuthError('AUTH_ACCOUNT_AMBIGUOUS');
      var candidates = buildAmbiguousCandidates(chosen.effective);
      var firstFingerprint = candidates[0]._fingerprint;
      var allSameAccount = !!firstFingerprint && candidates.every(function (c) {
        return c._fingerprint === firstFingerprint;
      });
      if (allSameAccount) {
        // Same credentials in every effective tab — one account, pick the
        // most recently observed tab instead of failing.
        var newestIndex = 0;
        for (var ci = 0; ci < candidates.length; ci++) {
          if (
            (candidates[ci].observedAt || 0) >=
            (candidates[newestIndex].observedAt || 0)
          ) {
            newestIndex = ci;
          }
        }
        return buildEffectiveResult(chosen.effective[newestIndex], {
          authMerged: 'same_account'
        });
      }
      var ambiguous = liveAuthError('AUTH_ACCOUNT_AMBIGUOUS');
      ambiguous.candidates = sanitizeCandidates(candidates);
      return ambiguous;
    }
    // Prefer AUTH_SOURCE_UNSAFE over multi-origin ambiguity / tab-required when
    // recorded origins cannot be safely resolved (e.g. same host, two ports).
    if (sourceUnsafe) return liveAuthError('AUTH_SOURCE_UNSAFE');
    if (multiOrigin) return liveAuthError('AUTH_ACCOUNT_AMBIGUOUS');
    // Prefer AUTH_CONTEXT_STALE (epoch churn) over generic SESSION_MISSING so
    // callers do not treat a cookie/logout bump as "never observed a token".
    if (hostHitStaleAuth && !hostHitMissingAuth) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    if (hostHitMissingAuth) {
      // Bearer/custom tools require a live token observation from the matched
      // tab. Cookie-only fallback looks "successful" then gets 403 on sites
      // that actually need Authorization (e.g. dh-platform). Fail closed.
      var missingAuthError = liveAuthError('AUTH_SESSION_MISSING');
      if (probeCandidates.length === 1) {
        // Single tab with a recently-expired record: caller may revalidate
        // it with a lightweight probe instead of failing outright.
        missingAuthError.probeHint = {
          tabId: probeCandidates[0].tabId,
          origin: probeCandidates[0].origin
        };
      }
      return missingAuthError;
    }
    if (hostHitStaleAuth) return liveAuthError('AUTH_CONTEXT_STALE');
    return liveAuthError('AUTH_TAB_REQUIRED');
  }

  function listLiveTabContexts(origin, now) {
    var normalized = normalizeOrigin(origin);
    var records = normalized && liveAuthByOrigin[normalized];
    if (!records) return [];
    return Object.keys(records).map(function (tabId) {
      var result = getLiveAuth(normalized, Number(tabId), now);
      if (!result.ok) return null;
      return {
        origin: normalized,
        tabId: Number(tabId),
        observedAt: result.authBundle.observedAt,
        sessionEpoch: result.authBundle.sessionEpoch
      };
    }).filter(function (item) {
      return !!item;
    });
  }

  function invalidateTab(tabId, reason) {
    if (
      typeof tabId !== 'number' ||
      !Number.isSafeInteger(tabId) ||
      tabId < 0
    ) {
      return Promise.resolve({ ok: true, affectedOrigins: [] });
    }
    return ensureLiveAuthRestored().then(function () {
      return ensureSamePathRestored();
    }).then(function () {
      delete samePathApiByTab[tabId];
      scheduleSamePathPersist();
      var origins = Object.keys(liveAuthByOrigin);
      Object.keys(liveObservationQueues).forEach(function (origin) {
        if (origins.indexOf(origin) < 0) origins.push(origin);
      });
      var invalidations = origins.map(function (origin) {
        var previous = liveObservationQueues[origin] || Promise.resolve();
        var operation = previous.catch(function () {}).then(function () {
          var records = liveAuthByOrigin[origin];
          if (!records || !records[tabId]) return null;
          delete records[tabId];
          return bumpEpoch(origin, reason || 'tab_invalidated').then(function () {
            return origin;
          });
        });
        liveObservationQueues[origin] = operation;
        return operation;
      });
      return Promise.all(invalidations).then(function (results) {
        var affectedOrigins = results.filter(function (origin) {
          return !!origin;
        });
        return { ok: true, affectedOrigins: affectedOrigins };
      });
    });
  }

  function selectUniqueTabContext(candidates, initiatorTabId) {
    var list = Array.isArray(candidates) ? candidates : [];
    if (
      Number.isSafeInteger(initiatorTabId) &&
      initiatorTabId >= 0
    ) {
      var exact = list.filter(function (item) {
        return item && item.tabId === initiatorTabId;
      });
      return exact.length === 1
        ? { ok: true, context: exact[0] }
        : liveAuthError('AUTH_TAB_REQUIRED');
    }
    if (!list.length) return liveAuthError('AUTH_TAB_REQUIRED');
    if (list.length > 1) return liveAuthError('AUTH_ACCOUNT_AMBIGUOUS');
    return { ok: true, context: list[0] };
  }

  function queryRuntimeCookies(origin) {
    return new Promise(function (resolve) {
      try {
        chrome.cookies.getAll({ url: origin + '/' }, function (cookies) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(liveAuthError('AUTH_COOKIE_QUERY_FAILED'));
            return;
          }
          resolve({
            ok: true,
            cookies: Array.isArray(cookies) ? cookies : []
          });
        });
      } catch (_error) {
        resolve(liveAuthError('AUTH_COOKIE_QUERY_FAILED'));
      }
    });
  }

  function hasExplicitTokenRequirement(meta) {
    var source = meta && typeof meta === 'object' ? meta : {};
    var authType = String(source.detectedAuthType || '').toLowerCase();
    if (authType === 'bearer' || authType === 'custom') return true;
    var names = Array.isArray(source.authHeaderNames)
      ? source.authHeaderNames
      : [];
    return names.some(function (name) {
      var normalized = String(name || '').trim().toLowerCase();
      return !!normalized &&
        normalized !== 'cookie' &&
        normalized !== 'set-cookie';
    });
  }

  function hasExplicitCookieRequirement(meta) {
    var names = Array.isArray(meta && meta.authHeaderNames)
      ? meta.authHeaderNames
      : [];
    return names.some(function (name) {
      return String(name || '').trim().toLowerCase() === 'cookie';
    });
  }

  function bindResolvedCookieContext(origin, pathname, cookieContext) {
    var targetPath = typeof pathname === 'string' &&
      pathname.charAt(0) === '/'
      ? pathname
      : '/';
    registerTarget(origin + targetPath, cookieContext);
    return ensureRegistryLoaded().then(function () {
      return true;
    });
  }

  async function resolveRuntimeAuth(input) {
    await ensureLiveAuthRestored();
    var source = input && typeof input === 'object' ? input : {};
    var origin = normalizeOrigin(source.origin);
    if (!origin) return liveAuthError('AUTH_SOURCE_UNSAFE');
    try {
      await ensureEpochLoaded(origin);
    } catch (_epochError) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    if (!isEpochTrusted(origin)) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }

    var meta = source.toolMeta && typeof source.toolMeta === 'object'
      ? source.toolMeta
      : {};
    var operationClass = AiRuntimeAuth.classifyOperation(meta);
    var sessionEpoch = getEpoch(origin);
    var tokenRequired = hasExplicitTokenRequirement(meta);
    var authType = String(meta.detectedAuthType || 'none').toLowerCase();
    var authBundle;
    var tabId;

    if (tokenRequired) {
      if (hasExplicitCookieRequirement(meta)) {
        return liveAuthError('AUTH_SOURCE_UNSAFE');
      }
      var selected = selectUniqueTabContext(
        source.tabs,
        source.initiatorTabId
      );
      if (!selected.ok) return selected;
      tabId = selected.context.tabId;
      var live = getLiveAuth(origin, tabId, Date.now());
      if (!live.ok) return live;
      authBundle = live.authBundle;
      // Token is captured from the tab, but the request is sent from the
      // extension background (host_permissions). Content-script fetch often
      // fails with "Failed to fetch" due to page CORS.
      return {
        ok: true,
        operationClass: operationClass,
        authSource: 'live_tab_token',
        proxyMode: 'fallback',
        sessionEpoch: sessionEpoch,
        authBundle: authBundle,
        tabId: tabId
      };
    }

    if (authType !== 'cookie') {
      return {
        ok: true,
        operationClass: operationClass,
        authSource: 'none',
        proxyMode: 'fallback',
        sessionEpoch: sessionEpoch,
        authBundle: {
          explicitHeaders: {},
          authHeaderNames: [],
          origin: origin,
          sessionEpoch: sessionEpoch
        }
      };
    }

    var cookieQuery = await queryRuntimeCookies(origin);
    if (!cookieQuery.ok) return cookieQuery;
    var cookies = cookieQuery.cookies;
    var cookieSelection = null;
    if (cookies.length) {
      cookieSelection = selectUniqueCookieContext(cookies);
      if (!cookieSelection.ok) return cookieSelection;
    } else {
      return liveAuthError('AUTH_COOKIE_MISSING');
    }

    if (cookieSelection) {
      try {
        await bindResolvedCookieContext(
          origin,
          meta.pathname,
          cookieSelection.cookieContext
        );
      } catch (_registryError) {
        return liveAuthError('AUTH_CONTEXT_STALE');
      }
      if (
        !isEpochTrusted(origin) ||
        getEpoch(origin) !== sessionEpoch
      ) {
        return liveAuthError('AUTH_CONTEXT_STALE');
      }
    }

    return {
      ok: true,
      operationClass: operationClass,
      authSource: 'browser_cookie',
      proxyMode: 'fallback',
      sessionEpoch: sessionEpoch,
      authBundle: {
        explicitHeaders: {},
        authHeaderNames: [],
        origin: origin,
        cookieContext: normalizeCookieContext(
          cookieSelection.cookieContext
        ),
        sessionEpoch: sessionEpoch
      }
    };
  }

  async function validateBeforeDispatch(origin, expectedEpoch, operationClass) {
    var normalized = normalizeOrigin(origin);
    if (!normalized) return liveAuthError('AUTH_CONTEXT_STALE');
    if (!isEpochTrusted(normalized)) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    try {
      await ensureEpochLoaded(normalized);
    } catch (_epochError) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    if (!isEpochTrusted(normalized)) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    if (
      operationClass === 'write_sensitive' &&
      getEpoch(normalized) !== Number(expectedEpoch)
    ) {
      return liveAuthError('AUTH_CONTEXT_STALE');
    }
    return { ok: true };
  }

  function dispatchOnce(transport) {
    var state = 'pre_dispatch';
    try {
      state = 'dispatched';
      return Promise.resolve(transport()).then(function (result) {
        return Object.assign({}, result, {
          dispatchState: 'completed',
          requestDispatched: true,
          retryable: false
        });
      }, function (error) {
        return {
          ok: false,
          status: 0,
          error: error && error.message ? error.message : String(error),
          dispatchState: state === 'dispatched' ? 'unknown' : 'pre_dispatch',
          requestDispatched: state === 'dispatched',
          retryable: state !== 'dispatched'
        };
      });
    } catch (error) {
      return Promise.resolve({
        ok: false,
        status: 0,
        error: error && error.message ? error.message : String(error),
        dispatchState: 'pre_dispatch',
        requestDispatched: false,
        retryable: true
      });
    }
  }

  function mapHttpAuthResult(result) {
    if (result && (result.status === 401 || result.status === 403)) {
      return Object.assign({}, result, {
        ok: false,
        errorCode: 'AUTH_REJECTED',
        error: '服务端拒绝了当前浏览器会话。',
        retryable: false,
        dispatchState: result.dispatchState || 'completed',
        requestDispatched: result.requestDispatched != null
          ? !!result.requestDispatched
          : true
      });
    }
    if (result && typeof result === 'object' && !result.dispatchState) {
      return Object.assign({}, result, {
        dispatchState: result.requestDispatched === false
          ? 'pre_dispatch'
          : 'completed'
      });
    }
    return result;
  }

  registryLoadResult = loadRegistry().then(function () {
    return { ok: true };
  }, function (error) {
    registryTrusted = false;
    return { ok: false, error: error };
  });

  root.AiRuntimeAuthSession = {
    registerTarget: registerTarget,
    ensureRegistryLoaded: ensureRegistryLoaded,
    getEpoch: getEpoch,
    isEpochTrusted: isEpochTrusted,
    markEpochUntrusted: markEpochUntrusted,
    ensureEpochLoaded: ensureEpochLoaded,
    bumpEpoch: bumpEpoch,
    observeLiveAuth: observeLiveAuth,
    observeSamePathApi: observeSamePathApi,
    getLiveAuth: getLiveAuth,
    getStaleAuthForProbe: getStaleAuthForProbe,
    ensureLiveAuthRestored: ensureLiveAuthRestored,
    ensureSamePathRestored: ensureSamePathRestored,
    scheduleLiveAuthPersist: scheduleLiveAuthPersist,
    scheduleSamePathPersist: scheduleSamePathPersist,
    listSamePathApiOrigins: listSamePathApiOrigins,
    selectSiteAffinityExecution: selectSiteAffinityExecution,
    listLiveTabContexts: listLiveTabContexts,
    invalidateTab: invalidateTab,
    selectUniqueTabContext: selectUniqueTabContext,
    resolveRuntimeAuth: resolveRuntimeAuth,
    validateBeforeDispatch: validateBeforeDispatch,
    dispatchOnce: dispatchOnce,
    mapHttpAuthResult: mapHttpAuthResult,
    mapCookieToRegisteredOrigins: mapCookieToRegisteredOrigins,
    selectUniqueCookieContext: selectUniqueCookieContext,
    setInvalidationHook: setInvalidationHook
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
