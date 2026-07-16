(function (global) {
  'use strict';

  var DEFAULT_SENSITIVE_HEADER_NAMES = [
    'cookie',
    'set-cookie',
    'authorization',
    'proxy-authorization',
    'www-authenticate',
    'proxy-authenticate',
    'x-csrf-token',
    'x-xsrf-token',
    'x-auth-token',
    'access-token',
    'x-api-key',
    'api-key',
    'x-token',
    'token',
    'id-token',
    'x-id-token',
    'refresh-token',
    'x-refresh-token',
    'session-token',
    'x-session-token',
    'refresh',
    'session'
  ];

  var WRITE_SENSITIVE_ALLOWLIST = [
    'accept',
    'accept-language',
    'content-type',
    'cache-control'
  ];

  function normalizeHeaderName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function includesHeaderName(names, name) {
    var normalized = normalizeHeaderName(name);
    var list = Array.isArray(names) ? names : [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (normalizeHeaderName(list[i]) === normalized) return true;
    }
    return false;
  }

  function buildNormalizedHeaderNameSet(names) {
    var set = Object.create(null);
    var list = Array.isArray(names) ? names : [];
    var i;
    for (i = 0; i < list.length; i++) {
      set[normalizeHeaderName(list[i])] = true;
    }
    return set;
  }

  function getDuplicateHeaderNameSet(headers) {
    var duplicates = Object.create(null);
    var seen = Object.create(null);
    var names = Object.keys(headers);
    var i;
    for (i = 0; i < names.length; i++) {
      var normalized = normalizeHeaderName(names[i]);
      if (seen[normalized]) duplicates[normalized] = true;
      seen[normalized] = true;
    }
    return duplicates;
  }

  function hasOwnKeys(value) {
    return Object.keys(value).length > 0;
  }

  function hasSideEffectPath(pathname) {
    var rawPath = String(pathname || '');
    var rawQueryIndex = rawPath.indexOf('?');
    var decoded = rawQueryIndex >= 0
      ? rawPath.substring(0, rawQueryIndex)
      : rawPath;
    var decodeRound = 0;
    while (decoded.indexOf('%') >= 0) {
      if (decodeRound >= 8) return true;
      decodeRound++;
      try {
        var nextDecoded = decodeURIComponent(decoded);
        if (nextDecoded === decoded) return true;
        decoded = nextDecoded;
      } catch (e) {
        return true;
      }
    }
    var tokenizedPath = decoded
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    var rawTokens = tokenizedPath.split(/[^A-Za-z0-9]+/);
    var tokens = [];
    for (var ri = 0; ri < rawTokens.length; ri++) {
      if (rawTokens[ri]) tokens.push(rawTokens[ri].toLowerCase());
    }
    var sideEffectTerms = [
      'logout', 'signout', 'login', 'signin', 'register', 'cancel', 'pay',
      'delete', 'remove', 'create', 'update', 'submit', 'approve', 'reject',
      'reset', 'execute', 'run', 'action', 'confirm', 'close', 'open',
      'publish', 'unpublish', 'enable', 'disable', 'archive', 'restore',
      'revoke', 'grant', 'invite', 'upload', 'save', 'send', 'commit',
      'merge', 'start', 'stop', 'retry', 'activate', 'deactivate'
    ];
    var sideEffectSet = Object.create(null);
    for (var ti = 0; ti < sideEffectTerms.length; ti++) {
      sideEffectSet[sideEffectTerms[ti]] = true;
    }
    for (var tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      if (sideEffectSet[tokens[tokenIndex]]) return true;
      if (
        tokenIndex + 1 < tokens.length &&
        sideEffectSet[tokens[tokenIndex] + tokens[tokenIndex + 1]]
      ) {
        return true;
      }
    }
    return false;
  }

  function classifyOperation(meta) {
    var operation = meta || {};
    var method = String(operation.method || '').toUpperCase();
    if (
      operation.operationClass === 'read' &&
      operation.isReadOnly === true &&
      (method === 'GET' || method === 'HEAD') &&
      !hasSideEffectPath(operation.pathname)
    ) {
      return 'read';
    }
    return 'write_sensitive';
  }

  function isSensitiveHeaderName(name, authHeaderNames) {
    return (
      includesHeaderName(DEFAULT_SENSITIVE_HEADER_NAMES, name) ||
      includesHeaderName(authHeaderNames, name)
    );
  }

  function sanitizeUntrustedHeaders(headers, operationClass, authHeaderNames) {
    var source = headers && typeof headers === 'object'
      ? headers
      : Object.create(null);
    var sanitized = Object.create(null);
    var names = Object.keys(source);
    var duplicates = getDuplicateHeaderNameSet(source);
    var isRead = operationClass === 'read';
    var i;
    for (i = 0; i < names.length; i++) {
      var name = names[i];
      var normalized = normalizeHeaderName(name);
      if (duplicates[normalized]) continue;
      if (isSensitiveHeaderName(normalized, authHeaderNames)) continue;
      if (!isRead && !includesHeaderName(WRITE_SENSITIVE_ALLOWLIST, normalized)) continue;
      if (
        typeof source[name] !== 'string' &&
        typeof source[name] !== 'number' &&
        typeof source[name] !== 'boolean'
      ) continue;
      sanitized[name] = source[name];
    }
    return sanitized;
  }

  function describeAuthHeaders(headers) {
    var source = headers && typeof headers === 'object'
      ? headers
      : Object.create(null);
    var names = Object.keys(source);
    var authHeaderNames = [];
    var detectedAuthType = 'none';
    var i;

    for (i = 0; i < names.length; i++) {
      var normalized = normalizeHeaderName(names[i]);
      if (!isSensitiveHeaderName(normalized)) continue;
      if (authHeaderNames.indexOf(normalized) === -1) {
        authHeaderNames.push(normalized);
      }
    }

    if (authHeaderNames.indexOf('authorization') !== -1) {
      var authorization = String(source[names.find(function (name) {
        return normalizeHeaderName(name) === 'authorization';
      })] || '');
      if (/^bearer\s/i.test(authorization)) detectedAuthType = 'bearer';
      else detectedAuthType = 'custom';
    } else if (
      authHeaderNames.length === 1 &&
      authHeaderNames[0] === 'cookie'
    ) {
      detectedAuthType = 'cookie';
    } else if (authHeaderNames.length) {
      detectedAuthType = 'custom';
    }

    return {
      detectedAuthType: detectedAuthType,
      authHeaderNames: authHeaderNames
    };
  }

  function deleteHeaderCaseInsensitive(headers, name) {
    var normalized = normalizeHeaderName(name);
    var existingNames = Object.keys(headers);
    var i;
    for (i = 0; i < existingNames.length; i++) {
      if (normalizeHeaderName(existingNames[i]) === normalized) {
        delete headers[existingNames[i]];
      }
    }
  }

  function mergeAndValidateHeaders(untrusted, operationClass, authBundle) {
    var bundle = authBundle && typeof authBundle === 'object' ? authBundle : {};
    var authHeaderNames = Array.isArray(bundle.authHeaderNames)
      ? bundle.authHeaderNames
      : [];
    var untrustedHeaders = untrusted && typeof untrusted === 'object'
      ? untrusted
      : Object.create(null);
    if (hasOwnKeys(getDuplicateHeaderNameSet(untrustedHeaders))) {
      return {
        ok: false,
        errorCode: 'AUTH_SOURCE_UNSAFE'
      };
    }
    var merged = sanitizeUntrustedHeaders(
      untrustedHeaders,
      operationClass,
      authHeaderNames
    );
    var explicitHeaders = bundle.explicitHeaders &&
      typeof bundle.explicitHeaders === 'object'
      ? bundle.explicitHeaders
      : Object.create(null);
    var names = Object.keys(explicitHeaders);
    if (hasOwnKeys(getDuplicateHeaderNameSet(explicitHeaders))) {
      return {
        ok: false,
        errorCode: 'AUTH_SOURCE_UNSAFE'
      };
    }
    var declaredSet = buildNormalizedHeaderNameSet(authHeaderNames);
    var explicitSet = buildNormalizedHeaderNameSet(names);
    if (
      declaredSet.cookie ||
      declaredSet['set-cookie'] ||
      explicitSet.cookie ||
      explicitSet['set-cookie']
    ) {
      return {
        ok: false,
        errorCode: 'AUTH_SOURCE_UNSAFE'
      };
    }
    var declaredNames = Object.keys(declaredSet);
    var explicitNames = Object.keys(explicitSet);
    if (declaredNames.length !== explicitNames.length) {
      return {
        ok: false,
        errorCode: 'AUTH_SOURCE_UNSAFE'
      };
    }
    var i;
    for (i = 0; i < declaredNames.length; i++) {
      if (!explicitSet[declaredNames[i]]) {
        return {
          ok: false,
          errorCode: 'AUTH_SOURCE_UNSAFE'
        };
      }
    }

    for (i = 0; i < names.length; i++) {
      var name = names[i];
      deleteHeaderCaseInsensitive(merged, name);
      merged[name] = explicitHeaders[name];
    }

    return {
      ok: true,
      headers: merged
    };
  }

  function sanitizeToolForStorage(tool) {
    var sanitizedTool;
    try {
      sanitizedTool = JSON.parse(JSON.stringify(tool));
    } catch (e) {
      return null;
    }
    if (!sanitizedTool || typeof sanitizedTool !== 'object') return null;
    var meta = sanitizedTool._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      meta = {};
      sanitizedTool._meta = meta;
    }
    var headerContainers = [];
    function isHeaderContainerName(name) {
      var normalized = normalizeHeaderName(name).replace(/[-_\s]/g, '');
      if (normalized === 'authheadernames') return false;
      return normalized === 'headers' ||
        normalized === 'rawheaders' ||
        normalized === 'sampleheaders' ||
        /^(raw|sample|recorded)?(request|response|business)?headers$/.test(normalized);
    }
    function isResponseContextName(name) {
      return normalizeHeaderName(name).replace(/[-_\s]/g, '').indexOf('response') >= 0;
    }
    function collectAndRemoveHeaderContainers(value, inInputSchema, inResponseContext) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (var ai = 0; ai < value.length; ai++) {
          collectAndRemoveHeaderContainers(
            value[ai],
            inInputSchema,
            inResponseContext
          );
        }
        return;
      }
      var keys = Object.keys(value);
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var child = value[key];
        var childInInputSchema = inInputSchema || key === 'inputSchema';
        var childInResponseContext = inResponseContext ||
          isResponseContextName(key);
        if (!childInInputSchema && isHeaderContainerName(key)) {
          if (
            !childInResponseContext &&
            child &&
            typeof child === 'object' &&
            !Array.isArray(child)
          ) {
            headerContainers.push(child);
          }
          delete value[key];
          continue;
        }
        collectAndRemoveHeaderContainers(
          child,
          childInInputSchema,
          childInResponseContext
        );
      }
    }
    collectAndRemoveHeaderContainers(sanitizedTool, false, false);
    var operationClass = classifyOperation({
      method: meta.method,
      operationClass: meta.operationClass,
      isReadOnly: meta.isReadOnly === true,
      pathname: meta.pathname
    });
    var untrustedHeaders = Object.create(null);
    for (var ci = 0; ci < headerContainers.length; ci++) {
      var headerNames = Object.keys(headerContainers[ci]);
      for (var hi = 0; hi < headerNames.length; hi++) {
        var headerName = headerNames[hi];
        var headerValue = headerContainers[ci][headerName];
        if (
          typeof headerValue === 'string' ||
          typeof headerValue === 'number' ||
          typeof headerValue === 'boolean'
        ) {
          untrustedHeaders[headerName] = headerValue;
        }
      }
    }
    var authHint = describeAuthHeaders(untrustedHeaders);
    var authHeaderNames = authHint.authHeaderNames.slice();
    var existingNames = Array.isArray(meta.authHeaderNames)
      ? meta.authHeaderNames
      : [];
    for (var i = 0; i < existingNames.length; i++) {
      var normalizedName = normalizeHeaderName(existingNames[i]);
      if (normalizedName && authHeaderNames.indexOf(normalizedName) < 0) {
        authHeaderNames.push(normalizedName);
      }
    }
    meta.recordedBusinessHeaders = sanitizeUntrustedHeaders(
      untrustedHeaders,
      operationClass,
      authHeaderNames
    );
    meta.authHeaderNames = authHeaderNames;
    meta.detectedAuthType = authHint.detectedAuthType !== 'none'
      ? authHint.detectedAuthType
      : (meta.detectedAuthType || 'none');
    meta.operationClass = operationClass;
    return sanitizedTool;
  }

  function sanitizeToolsForStorage(toolsObj) {
    var sanitizedTools = {};
    var names = Object.keys(toolsObj || {});
    for (var i = 0; i < names.length; i++) {
      var sanitized = sanitizeToolForStorage(toolsObj[names[i]]);
      if (sanitized) sanitizedTools[names[i]] = sanitized;
    }
    return sanitizedTools;
  }

  global.AiRuntimeAuth = {
    classifyOperation: classifyOperation,
    isSensitiveHeaderName: isSensitiveHeaderName,
    sanitizeUntrustedHeaders: sanitizeUntrustedHeaders,
    describeAuthHeaders: describeAuthHeaders,
    mergeAndValidateHeaders: mergeAndValidateHeaders,
    sanitizeToolForStorage: sanitizeToolForStorage,
    sanitizeToolsForStorage: sanitizeToolsForStorage
  };
})(globalThis);
