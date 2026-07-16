'use strict';
(function pageHookBootstrap(initialMockRules, recordMsgType, mockRulesMsgType, ruleConsumedMsgType, envReplayHitMsgType, envReplayResultMsgType, envReplayConsumedMsgType) {

      if (window.__AI_REQ_ANALYZER_HOOKED__) return;
      window.__AI_REQ_ANALYZER_HOOKED__ = true;

      var hookEnabled = true;
      window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (!data || data.source !== 'AI_REQ_ANALYZER_ISOLATED') return;
        if (data.type === 'AI_REQ_ANALYZER_HOOK_SET_ENABLED') {
          hookEnabled = data.enabled !== false;
        }
      });

      var mockRules = initialMockRules || {};
      var envReplaySelections = {};
      var envReplayProdOrigin = '';
      var envReplayInflight = {};
      var envReplayPendingResolvers = {};

      function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
      }

      function tryParseJson(str) {
        if (!str) return null;
        if (typeof str !== 'string') return str;
        try {
          return JSON.parse(str);
        } catch (e) {
          return str;
        }
      }

      function getMockKey(url) {
        try {
          return new URL(url, location.href).pathname;
        } catch (e) {
          return url;
        }
      }

      function findMockRule(url) {
        if (!hookEnabled) return null;
        var rule = findDebugRule(url);
        return hasResponseBodyMock(rule) ? rule.response.body : null;
      }

      function normalizeEnvReplayQueryLocal(queryStr) {
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
        } catch (e) { return str; }
        pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
        return pairs.map(function (p) { return p[0] + '=' + p[1]; }).join('&');
      }

      function findEnvReplayHit(method, url) {
        if (!hookEnabled) return null;
        if (!envReplayProdOrigin) return null;
        if (String(method || '').toUpperCase() !== 'GET') return null;
        var parsed;
        try { parsed = new URL(url, location.href); } catch (e) { return null; }
        var pathname = parsed.pathname;
        var query = parsed.search ? parsed.search.substring(1) : '';
        var keys = Object.keys(envReplaySelections);
        for (var i = 0; i < keys.length; i++) {
          var sel = envReplaySelections[keys[i]];
          if (!sel || !sel.enabled || String(sel.method).toUpperCase() !== 'GET') continue;
          if (sel.pathname !== pathname) continue;
          if (sel.matchQuery) {
            var parts = keys[i].split('|');
            var selNq = parts.length >= 3 ? parts.slice(2).join('|') : '';
            if (normalizeEnvReplayQueryLocal(query) !== selNq) continue;
          }
          return { key: keys[i], selection: sel, pathname: pathname, query: query, prodOrigin: envReplayProdOrigin };
        }
        return null;
      }

      function requestEnvReplayFetch(hit, reqHeaders) {
        if (!hit) return Promise.resolve({ ok: false, errorCode: 'PROD_ORIGIN_NOT_CONFIGURED' });
        var prodUrl = String(hit.prodOrigin).replace(/\/$/, '') + hit.pathname + (hit.query ? '?' + hit.query : '');
        // inflight 去重：同 prodUrl 进行中复用
        if (envReplayInflight[prodUrl]) {
          return envReplayInflight[prodUrl];
        }
        var reqId = generateId();
        var promise = new Promise(function (resolve) {
          envReplayPendingResolvers[reqId] = resolve;
          // 超时兜底（8s + 500ms 余量），若 content script 未回传则回退
          setTimeout(function () {
            if (envReplayPendingResolvers[reqId]) {
              delete envReplayPendingResolvers[reqId];
              if (envReplayInflight[prodUrl] && envReplayInflight[prodUrl].__reqId === reqId) {
                delete envReplayInflight[prodUrl];
              }
              resolve({ ok: false, errorCode: 'PROD_FETCH_TIMEOUT' });
            }
          }, 8500);
        });
        envReplayInflight[prodUrl] = promise;
        envReplayInflight[prodUrl].__reqId = reqId;
        try {
          window.postMessage({
            type: envReplayHitMsgType,
            reqId: reqId,
            prodOrigin: hit.prodOrigin,
            pathname: hit.pathname,
            query: hit.query,
            method: 'GET',
            reqHeaders: reqHeaders || null
          }, '*');
        } catch (e) {
          delete envReplayInflight[prodUrl];
          delete envReplayPendingResolvers[reqId];
          return Promise.resolve({ ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR', error: e.message });
        }
        return promise;
      }

      function filterUnsafeEnvReplayHeaders(headers) {
        var result = {};
        if (!headers || typeof headers !== 'object') return result;
        Object.keys(headers).forEach(function (k) {
          if (typeof isUnsafeResponseRewriteHeader === 'function' && isUnsafeResponseRewriteHeader(k)) return;
          result[k] = headers[k];
        });
        return result;
      }

      function consumeEnvReplayIfNext(hit) {
        if (!hit || !hit.selection) return;
        if (hit.selection.mode === 'next') {
          try {
            window.postMessage({ type: envReplayConsumedMsgType, key: hit.key }, '*');
          } catch (e) {}
        }
      }

      function shouldIgnore(url) {
        return url && String(url).indexOf('api.moonshot.cn') !== -1;
      }

      function postRecord(record) {
        if (!hookEnabled) return;
        if (shouldIgnore(record.url)) return;
        window.postMessage({ type: recordMsgType, record: record }, '*');
      }

      function collectHeaders(headers) {
        var result = {};
        try {
          if (!headers) return result;
          if (headers instanceof Headers) {
            headers.forEach(function (v, k) { result[k] = v; });
          } else if (Array.isArray(headers)) {
            headers.forEach(function (item) {
              if (item && item.length >= 2) result[item[0]] = item[1];
            });
          } else if (typeof headers === 'object') {
            Object.keys(headers).forEach(function (key) { result[key] = headers[key]; });
          }
        } catch (e) {}
        return result;
      }

      function isDebugRule(rule) {
        return !!(rule && typeof rule === 'object' && (rule.__aiReqRule === true || rule.match || rule.request || rule.response));
      }

      function normalizeHeaders(headers) {
        var result = {};
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return result;
        Object.keys(headers).forEach(function (key) {
          if (headers[key] !== undefined && headers[key] !== null && key !== '') result[key] = String(headers[key]);
        });
        return result;
      }

      function normalizeRemoveList(list) {
        if (!list) return [];
        if (typeof list === 'string') {
          return list.split(/[\n,]+/).map(function (item) { return item.trim(); }).filter(Boolean);
        }
        if (!Array.isArray(list)) return [];
        return list.map(function (item) { return String(item).trim(); }).filter(Boolean);
      }

      function normalizeResponsePatch(raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (!raw.jsonPath || typeof raw.jsonPath !== 'string') return null;
        return {
          id: raw.id || ('patch_' + Date.now().toString(36)),
          enabled: raw.enabled !== false,
          jsonPath: raw.jsonPath,
          value: raw.value,
          valueType: raw.valueType || 'string',
          sourceId: raw.sourceId || '',
          createdAt: raw.createdAt || Date.now()
        };
      }

      function normalizeResponsePatches(list) {
        if (!Array.isArray(list)) return [];
        var out = [];
        for (var pi = 0; pi < list.length; pi++) {
          var p = normalizeResponsePatch(list[pi]);
          if (p) out.push(p);
        }
        return out;
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

      function setValueAtJsonPath(obj, path, value) {
        var segments = parseJsonPathSegments(path);
        if (!segments || !segments.length) return { ok: false, reason: 'INVALID_PATH' };
        var cur = obj;
        for (var si = 0; si < segments.length - 1; si++) {
          if (cur == null || typeof cur !== 'object') return { ok: false, reason: 'PATH_NOT_FOUND' };
          var seg = segments[si];
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

      function normalizeRule(raw, key, method) {
        if (!isDebugRule(raw)) {
          return {
            __aiReqRule: true,
            enabled: true,
            once: false,
            match: { pathname: key || '', method: method || '' },
            request: { url: '', headersSet: {}, headersRemove: [] },
            response: {
              status: 200,
              statusText: 'OK',
              headersSet: { 'Content-Type': 'application/json' },
              headersRemove: [],
              bodyEnabled: true,
              body: raw,
              patches: []
            }
          };
        }
        var response = raw.response || {};
        var request = raw.request || {};
        var match = raw.match || {};
        return {
          __aiReqRule: true,
          enabled: raw.enabled !== false,
          once: raw.once === true,
          match: { pathname: match.pathname || key || '', method: (match.method || method || '').toUpperCase() },
          request: {
            url: request.url || '',
            headersSet: normalizeHeaders(request.headersSet),
            headersRemove: normalizeRemoveList(request.headersRemove)
          },
          response: {
            status: parseInt(response.status, 10) || 200,
            statusText: response.statusText || 'OK',
            headersSet: normalizeHeaders(response.headersSet || { 'Content-Type': 'application/json' }),
            headersRemove: normalizeRemoveList(response.headersRemove),
            bodyEnabled: response.bodyEnabled === true,
            body: response.body,
            patches: normalizeResponsePatches(response.patches)
          }
        };
      }

      function hasResponsePatches(rule) {
        return !!(rule && rule.response && Array.isArray(rule.response.patches) && rule.response.patches.length);
      }

      function getEnabledResponsePatches(rule) {
        if (!hasResponsePatches(rule)) return [];
        return rule.response.patches.filter(function (p) { return p && p.enabled !== false; });
      }

      function applyResponsePatchesToObject(baseBody, patches) {
        var warnings = [];
        if (baseBody === null || typeof baseBody === 'undefined' || typeof baseBody !== 'object') {
          return { body: baseBody, warnings: ['NON_JSON_BASE'] };
        }
        var body;
        try {
          body = JSON.parse(JSON.stringify(baseBody));
        } catch (eClone) {
          return { body: baseBody, warnings: ['CLONE_FAILED'] };
        }
        if (!patches || !patches.length) return { body: body, warnings: warnings };
        for (var pj = 0; pj < patches.length; pj++) {
          var patch = patches[pj];
          if (!patch || patch.enabled === false) continue;
          var result = setValueAtJsonPath(body, patch.jsonPath, patch.value);
          if (!result.ok) warnings.push('PATH_NOT_FOUND:' + patch.jsonPath);
        }
        return { body: body, warnings: warnings };
      }

      function buildMockedResponseBody(rule, realBody) {
        var base = (rule && rule.response && rule.response.bodyEnabled === true)
          ? rule.response.body
          : realBody;
        var patches = getEnabledResponsePatches(rule);
        if (!patches.length) return { body: base, warnings: [] };
        return applyResponsePatchesToObject(base, patches);
      }

      function findDebugRule(url, method) {
        if (!hookEnabled) return null;
        var key = getMockKey(url);
        var raw = mockRules[key];
        if (!raw) return null;
        var rule = normalizeRule(raw, key, method);
        if (!rule.enabled) return null;
        if (rule.match.method && method && rule.match.method !== String(method).toUpperCase()) return null;
        rule._key = key;
        return rule;
      }

      function hasResponseBodyMock(rule) {
        return !!(rule && rule.response && rule.response.bodyEnabled === true);
      }

      function hasResponseHeaderRewrite(rule) {
        return !!(rule && rule.response && (Object.keys(rule.response.headersSet || {}).length || (rule.response.headersRemove || []).length));
      }

      function removeHeaderCaseInsensitive(headers, name) {
        var lower = String(name).toLowerCase();
        Object.keys(headers || {}).forEach(function (key) {
          if (String(key).toLowerCase() === lower) delete headers[key];
        });
      }

      function isUnsafeRequestRewriteHeader(name) {
        var lower = String(name || '').toLowerCase();
        return lower === 'host' ||
          lower === 'cookie' ||
          lower === 'cookie2' ||
          lower === 'origin' ||
          lower === 'referer' ||
          lower === 'connection' ||
          lower === 'content-length' ||
          lower === 'accept-encoding' ||
          lower.indexOf('sec-') === 0 ||
          lower.indexOf('proxy-') === 0 ||
          lower === 'upgrade' ||
          lower === 'keep-alive' ||
          lower === 'te' ||
          lower === 'trailer' ||
          lower === 'transfer-encoding';
      }

      function isUnsafeResponseRewriteHeader(name) {
        var lower = String(name || '').toLowerCase();
        return lower === 'content-encoding' ||
          lower === 'content-length' ||
          lower === 'transfer-encoding' ||
          lower === 'connection' ||
          lower === 'set-cookie' ||
          lower === 'set-cookie2' ||
          lower === 'keep-alive' ||
          lower.indexOf('proxy-') === 0 ||
          lower === 'trailer' ||
          lower === 'upgrade';
      }

      function applyHeaderRewrite(headers, headersSet, headersRemove) {
        var result = Object.assign({}, headers || {});
        (headersRemove || []).forEach(function (name) { removeHeaderCaseInsensitive(result, name); });
        Object.keys(headersSet || {}).forEach(function (name) {
          if (isUnsafeRequestRewriteHeader(name)) return;
          result[name] = String(headersSet[name]);
        });
        return result;
      }

      function buildResponseHeaders(rule, baseHeaders) {
        var headers = applyHeaderRewrite(baseHeaders || {}, rule && rule.response ? rule.response.headersSet : {}, rule && rule.response ? rule.response.headersRemove : []);
        Object.keys(headers || {}).forEach(function (name) {
          if (isUnsafeResponseRewriteHeader(name)) delete headers[name];
        });
        if (!Object.keys(headers).length) headers['Content-Type'] = 'application/json';
        return headers;
      }

      function consumeOnceRule(rule) {
        if (!rule || !rule.once || !rule._key) return;
        delete mockRules[rule._key];
        window.postMessage({ type: ruleConsumedMsgType, key: rule._key }, '*');
      }

      function readXhrResponseHeaders(xhr) {
        var respHeaders = {};
        try {
          var headerStr = xhr.getAllResponseHeaders();
          var headerLines = headerStr.trim().split(/[\r\n]+/);
          headerLines.forEach(function (line) {
            var parts = line.split(': ');
            var name = parts.shift();
            if (name) respHeaders[name] = parts.join(': ');
          });
        } catch (e) {}
        return respHeaders;
      }

      function applyXhrResponsePatchesIfNeeded(xhr, rule, reqInfo) {
        if (!xhr || xhr._aiPatchApplied) return false;
        if (xhr.readyState !== 4) return false;
        if (!rule || !hasResponsePatches(rule) || hasResponseBodyMock(rule)) return false;
        var respBody = null;
        try {
          respBody = xhr.responseText;
        } catch (e) {}
        var parsedBody = tryParseJson(respBody);
        if (!parsedBody || typeof parsedBody !== 'object') return false;
        var builtBody = buildMockedResponseBody(rule, parsedBody);
        try {
          var patchedJson = JSON.stringify(builtBody.body);
          defineMockXhrResponse(xhr, patchedJson, builtBody.body, reqInfo.url, {
            status: xhr.status,
            statusText: xhr.statusText || 'OK',
            headers: readXhrResponseHeaders(xhr)
          });
          xhr._aiPatchApplied = true;
          xhr._aiPatchWarnings = builtBody.warnings || [];
          return true;
        } catch (ePatch) {
          return false;
        }
      }

      function wrapXhrReadyStateHandler(xhr, rule, reqInfo, handler) {
        return function (ev) {
          applyXhrResponsePatchesIfNeeded(xhr, rule, reqInfo);
          if (typeof handler === 'function') return handler.call(xhr, ev);
        };
      }

      function installXhrPatchHooks(xhr, rule, reqInfo) {
        if (!rule || !hasResponsePatches(rule) || hasResponseBodyMock(rule)) return;
        if (xhr._aiPatchHooksReady) return;
        xhr._aiPatchHooksReady = true;
        var userHandler = xhr.onreadystatechange;
        xhr.onreadystatechange = wrapXhrReadyStateHandler(xhr, rule, reqInfo, userHandler);
      }

      function defineMockXhrResponse(xhr, mockJson, mockData, url, responseMeta) {
        responseMeta = responseMeta || {};
        var headers = responseMeta.headers || { 'Content-Type': 'application/json' };
        var headersText = Object.keys(headers).map(function (key) { return key + ': ' + headers[key]; }).join('\r\n') + '\r\n';
        var responseValue = xhr.responseType === 'json' ? mockData : mockJson;
        try { Object.defineProperty(xhr, 'responseText', { value: mockJson, configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'response', { value: responseValue, configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'status', { value: responseMeta.status || 200, configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'statusText', { value: responseMeta.statusText || 'OK', configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'responseURL', { value: url, configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'getAllResponseHeaders', { value: function () { return headersText; }, configurable: true }); } catch (e) {}
        try { Object.defineProperty(xhr, 'getResponseHeader', { value: function (name) {
          var lower = String(name).toLowerCase();
          var value = null;
          Object.keys(headers).forEach(function (key) {
            if (String(key).toLowerCase() === lower) value = headers[key];
          });
          return value;
        }, configurable: true }); } catch (e) {}
      }

      function dispatchMockXhrSuccess(xhr) {
        setTimeout(function () {
          try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {}
          try { xhr.dispatchEvent(new ProgressEvent('load')); } catch (e2) {}
          try { xhr.dispatchEvent(new ProgressEvent('loadend')); } catch (e3) {}
        }, 0);
      }

      window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        var data = event.data || {};
        if (data.type === mockRulesMsgType) {
          mockRules = data.rules || {};
          envReplaySelections = data.envReplaySelections || {};
          envReplayProdOrigin = data.envReplayProdOrigin || '';
        } else if (data.type === envReplayResultMsgType && data.reqId) {
          var resolver = envReplayPendingResolvers[data.reqId];
          if (resolver) {
            delete envReplayPendingResolvers[data.reqId];
            try { resolver(data.result || { ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR' }); } catch (e) {}
          }
          // 清理 inflight（按 prodUrl key）
          var ik = Object.keys(envReplayInflight);
          for (var ii = 0; ii < ik.length; ii++) {
            if (envReplayInflight[ik[ii]] && envReplayInflight[ik[ii]].__reqId === data.reqId) {
              delete envReplayInflight[ik[ii]];
            }
          }
        }
      });

      var OrigXHR = window.XMLHttpRequest;
      if (OrigXHR) {
        var origOpen = OrigXHR.prototype.open;
        var origSend = OrigXHR.prototype.send;
        var origSetRequestHeader = OrigXHR.prototype.setRequestHeader;
        var origXhrAddEventListener = OrigXHR.prototype.addEventListener;

        OrigXHR.prototype.addEventListener = function (type, listener, options) {
          if (
            type === 'readystatechange' &&
            this._aiReqInfo &&
            !hasResponseBodyMock(this._aiReqInfo.debugRule)
          ) {
            var self = this;
            var reqInfo = this._aiReqInfo;
            var rule = reqInfo.debugRule || findDebugRule(reqInfo.originalUrl || reqInfo.url, reqInfo.method);
            if (rule && hasResponsePatches(rule)) {
              var wrapped = wrapXhrReadyStateHandler(self, rule, reqInfo, listener);
              return origXhrAddEventListener.call(this, type, wrapped, options);
            }
          }
          return origXhrAddEventListener.apply(this, arguments);
        };

        OrigXHR.prototype.open = function (method, url) {
          var rule = findDebugRule(url, method);
          var finalUrl = rule && rule.request && rule.request.url ? rule.request.url : url;
          this._aiReqInfo = {
            id: generateId(),
            method: method,
            url: finalUrl,
            originalUrl: url,
            requestHeaders: {},
            requestBody: null,
            startTime: Date.now(),
            debugRule: rule || null
          };
          if (rule && rule.request && rule.request.url) {
            arguments[1] = rule.request.url;
          }
          return origOpen.apply(this, arguments);
        };

        OrigXHR.prototype.setRequestHeader = function (name, value) {
          if (this._aiReqInfo) {
            var rule = this._aiReqInfo.debugRule;
            var removeList = rule && rule.request ? rule.request.headersRemove || [] : [];
            for (var i = 0; i < removeList.length; i++) {
              if (String(removeList[i]).toLowerCase() === String(name).toLowerCase()) return;
            }
            this._aiReqInfo.requestHeaders[name] = value;
          }
          return origSetRequestHeader.apply(this, arguments);
        };

        OrigXHR.prototype.send = function (body) {
          var self = this;
          if (this._aiReqInfo) {
            this._aiReqInfo.requestBody = body;
            var reqInfo = this._aiReqInfo;
            var rule = reqInfo.debugRule || findDebugRule(reqInfo.originalUrl || reqInfo.url, reqInfo.method);
            if (rule && rule.request && rule.request.headersSet) {
              Object.keys(rule.request.headersSet).forEach(function (name) {
                try {
                  origSetRequestHeader.call(self, name, rule.request.headersSet[name]);
                  reqInfo.requestHeaders[name] = rule.request.headersSet[name];
                } catch (e) {}
              });
            }
            var mockMatch = hasResponseBodyMock(rule) ? buildMockedResponseBody(rule, rule.response.body).body : null;
            if (hasResponseBodyMock(rule)) {
              var mockJson = JSON.stringify(mockMatch);
              var responseHeaders = buildResponseHeaders(rule, { 'Content-Type': 'application/json' });
              defineMockXhrResponse(self, mockJson, mockMatch, reqInfo.url, {
                status: rule.response.status,
                statusText: rule.response.statusText,
                headers: responseHeaders
              });
              postRecord({
                id: reqInfo.id,
                timestamp: reqInfo.startTime,
                method: reqInfo.method,
                url: reqInfo.url,
                originalUrl: reqInfo.originalUrl,
                requestHeaders: reqInfo.requestHeaders,
                requestBody: tryParseJson(reqInfo.requestBody),
                responseStatus: rule.response.status,
                responseHeaders: responseHeaders,
                responseBody: mockMatch,
                duration: 0,
                aiAnalysis: null,
                isMocked: true,
                mockData: mockMatch,
                debugRule: rule
              });
              consumeOnceRule(rule);
              dispatchMockXhrSuccess(self);
              return;
            }

            function installRealXhrRecorder() {
              if (self._aiRealRecorderInstalled) return;
              self._aiRealRecorderInstalled = true;
              self.addEventListener('readystatechange', function () {
                if (self.readyState !== 4 || self._aiRecorded) return;
                self._aiRecorded = true;
                var respHeaders = readXhrResponseHeaders(self);
                applyXhrResponsePatchesIfNeeded(self, rule, reqInfo);
                var parsedBody = null;
                try {
                  parsedBody = tryParseJson(self.responseText);
                } catch (eParse) {}
                postRecord({
                  id: reqInfo.id,
                  timestamp: reqInfo.startTime,
                  method: reqInfo.method,
                  url: reqInfo.url,
                  originalUrl: reqInfo.originalUrl,
                  requestHeaders: reqInfo.requestHeaders,
                  requestBody: tryParseJson(reqInfo.requestBody),
                  responseStatus: self.status,
                  responseHeaders: respHeaders,
                  responseBody: parsedBody,
                  duration: Date.now() - reqInfo.startTime,
                  aiAnalysis: null,
                  isMocked: !!(rule && (hasResponseBodyMock(rule) || hasResponsePatches(rule))),
                  mockData: (rule && (hasResponseBodyMock(rule) || hasResponsePatches(rule))) ? parsedBody : null,
                  debugRule: rule,
                  envReplayError: reqInfo.envReplayError || undefined,
                  patchWarnings: self._aiPatchWarnings || []
                });
                consumeOnceRule(rule);
              });
            }

            var envHit = findEnvReplayHit(reqInfo.method, reqInfo.originalUrl || reqInfo.url);
            if (envHit) {
              reqInfo.envReplay = envHit;
              self._aiRecorded = false;
              requestEnvReplayFetch(envHit, reqInfo.requestHeaders).then(function (result) {
                if (result && result.ok) {
                  var filteredHeaders = filterUnsafeEnvReplayHeaders(result.headers || {});
                  if (!filteredHeaders['Content-Type']) filteredHeaders['Content-Type'] = 'application/json';
                  var mockJson = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
                  var mockData = typeof result.body === 'string' ? tryParseJson(result.body) : result.body;
                  defineMockXhrResponse(self, mockJson, mockData, reqInfo.url, {
                    status: result.status || 200,
                    statusText: result.statusText || 'OK',
                    headers: filteredHeaders
                  });
                  if (!self._aiRecorded) {
                    self._aiRecorded = true;
                    postRecord({
                      id: reqInfo.id,
                      timestamp: reqInfo.startTime,
                      method: reqInfo.method,
                      url: reqInfo.url,
                      originalUrl: reqInfo.originalUrl,
                      requestHeaders: reqInfo.requestHeaders,
                      requestBody: tryParseJson(reqInfo.requestBody),
                      responseStatus: result.status || 200,
                      responseHeaders: filteredHeaders,
                      responseBody: mockData,
                      duration: Date.now() - reqInfo.startTime,
                      aiAnalysis: null,
                      isMocked: true,
                      mockData: mockData,
                      envReplayHit: true,
                      envReplaySource: reqInfo.envReplay.prodOrigin,
                      envReplayWarnings: result.warnings || []
                    });
                  }
                  consumeEnvReplayIfNext(reqInfo.envReplay);
                  dispatchMockXhrSuccess(self);
                  return;
                }
                reqInfo.envReplayError = result && result.errorCode ? result.errorCode : 'PROD_FETCH_NETWORK_ERROR';
                installXhrPatchHooks(self, rule, reqInfo);
                installRealXhrRecorder();
                try {
                  origSend.call(self, body);
                } catch (sendErr) {
                  if (!self._aiRecorded) {
                    self._aiRecorded = true;
                    postRecord({
                      id: reqInfo.id,
                      timestamp: reqInfo.startTime,
                      method: reqInfo.method,
                      url: reqInfo.url,
                      originalUrl: reqInfo.originalUrl,
                      requestHeaders: reqInfo.requestHeaders,
                      requestBody: tryParseJson(reqInfo.requestBody),
                      responseStatus: 0,
                      responseHeaders: {},
                      responseBody: sendErr && sendErr.message ? sendErr.message : String(sendErr),
                      duration: Date.now() - reqInfo.startTime,
                      aiAnalysis: null,
                      isMocked: false,
                      mockData: null,
                      envReplayError: reqInfo.envReplayError
                    });
                  }
                }
              });
              return;
            }

            installXhrPatchHooks(self, rule, reqInfo);
            self._aiRecorded = false;
            installRealXhrRecorder();
          }
          return origSend.apply(this, arguments);
        };
      }

      var origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function (input, init) {
          var url, method, originalUrl;
          try {
            url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
            method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
          } catch (e) {
            url = String(input);
            method = (init && init.method) || 'GET';
          }
          originalUrl = url;

          var reqHeaders = {};
          try {
            reqHeaders = collectHeaders(init && init.headers ? init.headers : (input instanceof Request ? input.headers : null));
          } catch (e) {}
          var reqBody = init && init.body ? init.body : null;
          var rule = findDebugRule(url, method);
          var finalInput = input;
          var finalInit = init ? Object.assign({}, init) : {};
          if (rule && rule.request) {
            reqHeaders = applyHeaderRewrite(reqHeaders, rule.request.headersSet, rule.request.headersRemove);
            finalInit.headers = reqHeaders;
            if (rule.request.url) {
              url = rule.request.url;
              finalInput = url;
            }
          }
          var mockMatch = hasResponseBodyMock(rule) ? buildMockedResponseBody(rule, rule.response.body).body : null;
          if (hasResponseBodyMock(rule)) {
            var reqId = generateId();
            var startTime = Date.now();
            var mockHeaders = buildResponseHeaders(rule, { 'Content-Type': 'application/json' });
            postRecord({
              id: reqId,
              timestamp: startTime,
              method: String(method).toUpperCase(),
              url: url,
              originalUrl: originalUrl,
              requestHeaders: reqHeaders,
              requestBody: tryParseJson(reqBody),
              responseStatus: rule.response.status,
              responseHeaders: mockHeaders,
              responseBody: mockMatch,
              duration: 0,
              aiAnalysis: null,
              isMocked: true,
              mockData: mockMatch,
              debugRule: rule
            });
            consumeOnceRule(rule);
            return Promise.resolve(new Response(JSON.stringify(mockMatch), {
              status: rule.response.status,
              statusText: rule.response.statusText,
              headers: mockHeaders
            }));
          }

          var envFetchHit = findEnvReplayHit(method, originalUrl);
          if (envFetchHit) {
            var envReqId = generateId();
            var envStart = Date.now();
            var realFetchPromise = origFetch.call(this, finalInput, finalInit);
            var prodFetchPromise = requestEnvReplayFetch(envFetchHit, reqHeaders);
            return Promise.all([realFetchPromise, prodFetchPromise]).then(function (results) {
              var realRes = results[0];
              var prodRes = results[1];
              if (prodRes && prodRes.ok) {
                var filteredH = filterUnsafeEnvReplayHeaders(prodRes.headers || {});
                if (!filteredH['Content-Type']) filteredH['Content-Type'] = 'application/json';
                var envMockBody = typeof prodRes.body === 'string' ? prodRes.body : JSON.stringify(prodRes.body);
                var envMockData = typeof prodRes.body === 'string' ? tryParseJson(prodRes.body) : prodRes.body;
                var envMockResponse = new Response(envMockBody, {
                  status: prodRes.status || 200,
                  statusText: prodRes.statusText || 'OK',
                  headers: filteredH
                });
                postRecord({
                  id: envReqId,
                  timestamp: envStart,
                  method: String(method).toUpperCase(),
                  url: url,
                  originalUrl: originalUrl,
                  requestHeaders: reqHeaders,
                  requestBody: tryParseJson(reqBody),
                  responseStatus: prodRes.status || 200,
                  responseHeaders: filteredH,
                  responseBody: envMockData,
                  duration: Date.now() - envStart,
                  aiAnalysis: null,
                  isMocked: true,
                  mockData: envMockData,
                  envReplayHit: true,
                  envReplaySource: envFetchHit.prodOrigin,
                  envReplayWarnings: prodRes.warnings || []
                });
                consumeEnvReplayIfNext(envFetchHit);
                return envMockResponse;
              }
              // 失败回退真实响应
              return realRes.clone().text().then(function (realText) {
                var realParsed = tryParseJson(realText);
                postRecord({
                  id: envReqId,
                  timestamp: envStart,
                  method: String(method).toUpperCase(),
                  url: url,
                  originalUrl: originalUrl,
                  requestHeaders: reqHeaders,
                  requestBody: tryParseJson(reqBody),
                  responseStatus: realRes.status,
                  responseHeaders: collectHeaders(realRes.headers),
                  responseBody: realParsed,
                  duration: Date.now() - envStart,
                  aiAnalysis: null,
                  isMocked: false,
                  mockData: null,
                  envReplayError: prodRes && prodRes.errorCode ? prodRes.errorCode : 'PROD_FETCH_NETWORK_ERROR'
                });
                return realRes;
              }).catch(function () {
                postRecord({
                  id: envReqId,
                  timestamp: envStart,
                  method: String(method).toUpperCase(),
                  url: url,
                  originalUrl: originalUrl,
                  requestHeaders: reqHeaders,
                  requestBody: tryParseJson(reqBody),
                  responseStatus: realRes.status,
                  responseHeaders: collectHeaders(realRes.headers),
                  responseBody: null,
                  duration: Date.now() - envStart,
                  aiAnalysis: null,
                  isMocked: false,
                  mockData: null,
                  envReplayError: prodRes && prodRes.errorCode ? prodRes.errorCode : 'PROD_FETCH_NETWORK_ERROR'
                });
                return realRes;
              });
            }).catch(function (err) {
              postRecord({
                id: envReqId,
                timestamp: envStart,
                method: String(method).toUpperCase(),
                url: url,
                originalUrl: originalUrl,
                requestHeaders: reqHeaders,
                requestBody: tryParseJson(reqBody),
                responseStatus: 0,
                responseHeaders: {},
                responseBody: err && err.message ? err.message : String(err),
                duration: Date.now() - envStart,
                aiAnalysis: null,
                isMocked: false,
                mockData: null,
                envReplayError: 'PROD_FETCH_NETWORK_ERROR'
              });
              throw err;
            });
          }

          var reqId2 = generateId();
          var startTime2 = Date.now();
          return origFetch.call(this, finalInput, finalInit).then(function (response) {
            if (shouldIgnore(url)) return response;
            var returnedResponse = response;
            if (hasResponseHeaderRewrite(rule)) {
              returnedResponse = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: buildResponseHeaders(rule, collectHeaders(response.headers))
              });
            }
            return returnedResponse.clone().text().then(function (text) {
              var parsedBody = tryParseJson(text);
              var finalResponse = returnedResponse;
              if (rule && hasResponsePatches(rule) && parsedBody && typeof parsedBody === 'object') {
                var builtFetch = buildMockedResponseBody(rule, parsedBody);
                parsedBody = builtFetch.body;
                try {
                  finalResponse = new Response(JSON.stringify(parsedBody), {
                    status: returnedResponse.status,
                    statusText: returnedResponse.statusText,
                    headers: buildResponseHeaders(rule, collectHeaders(returnedResponse.headers))
                  });
                } catch (eResp) {}
              }
              postRecord({
                id: reqId2,
                timestamp: startTime2,
                method: String(method).toUpperCase(),
                url: url,
                originalUrl: originalUrl,
                requestHeaders: reqHeaders,
                requestBody: tryParseJson(reqBody),
                responseStatus: returnedResponse.status,
                responseHeaders: collectHeaders(returnedResponse.headers),
                responseBody: parsedBody,
                duration: Date.now() - startTime2,
                aiAnalysis: null,
                isMocked: !!(rule && hasResponsePatches(rule)),
                mockData: (rule && hasResponsePatches(rule)) ? parsedBody : null,
                debugRule: rule
              });
              consumeOnceRule(rule);
              return finalResponse;
            }).catch(function () {
              postRecord({
                id: reqId2,
                timestamp: startTime2,
                method: String(method).toUpperCase(),
                url: url,
                originalUrl: originalUrl,
                requestHeaders: reqHeaders,
                requestBody: tryParseJson(reqBody),
                responseStatus: returnedResponse.status,
                responseHeaders: collectHeaders(returnedResponse.headers),
                responseBody: null,
                duration: Date.now() - startTime2,
                aiAnalysis: null,
                isMocked: false,
                mockData: null,
                debugRule: rule
              });
              consumeOnceRule(rule);
              return returnedResponse;
            });
          }).catch(function (err) {
            postRecord({
              id: reqId2,
              timestamp: startTime2,
              method: String(method).toUpperCase(),
              url: url,
              originalUrl: originalUrl,
              requestHeaders: reqHeaders,
              requestBody: tryParseJson(reqBody),
              responseStatus: 0,
              responseHeaders: {},
              responseBody: err && err.message ? err.message : String(err),
              duration: Date.now() - startTime2,
              aiAnalysis: null,
              isMocked: false,
              mockData: null,
              debugRule: rule
            });
            consumeOnceRule(rule);
            throw err;
          });
        };
      }
})({}, 'AI_REQ_ANALYZER_PAGE_RECORD', 'AI_REQ_ANALYZER_MOCK_RULES', 'AI_REQ_ANALYZER_RULE_CONSUMED', 'AI_REQ_ANALYZER_ENV_REPLAY_HIT', 'AI_REQ_ANALYZER_ENV_REPLAY_RESULT', 'AI_REQ_ANALYZER_ENV_REPLAY_CONSUMED');
