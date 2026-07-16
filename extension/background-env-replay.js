'use strict';

function tryParseJsonEnvReplay(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
}

// 查找正式环境 tab
function findProdTab(prodOrigin) {
  return new Promise(function (resolve) {
    var prodHost = '';
    try { prodHost = new URL(prodOrigin).hostname; } catch (e) {}
    if (!prodHost || !chrome.tabs) { resolve(null); return; }
    try {
      chrome.tabs.query({}, function (tabs) {
        if (chrome.runtime.lastError || !tabs) { resolve(null); return; }
        for (var i = 0; i < tabs.length; i++) {
          var t = tabs[i];
          if (!t || !t.url) continue;
          try {
            var u = new URL(t.url);
            if (u.hostname === prodHost && (u.protocol === 'http:' || u.protocol === 'https:')) {
              resolve(t); return;
            }
          } catch (e) {}
        }
        resolve(null);
      });
    } catch (e) { resolve(null); }
  });
}

// 在正式环境 tab 的 MAIN world 执行 fetch —— 这样请求是 same-origin，
// Referer/Origin/sec-fetch-site 全部由浏览器按正式环境页面自动设置，Cookie 自动携带
function fetchViaProdTab(tabId, url, headers, timeoutMs) {
  return new Promise(function (resolve) {
    var injectedFunc = function (args) {
      return new Promise(function (innerResolve) {
        var ctrl = null;
        try { ctrl = new AbortController(); } catch (e) {}
        var timer = setTimeout(function () {
          try { if (ctrl) ctrl.abort(); } catch (e) {}
        }, args.timeoutMs || 8000);
        var opts = { credentials: 'include', headers: args.headers || {} };
        if (ctrl) opts.signal = ctrl.signal;
        fetch(args.url, opts).then(function (res) {
          return res.text().then(function (txt) {
            clearTimeout(timer);
            var hdrs = {};
            try { res.headers.forEach(function (v, k) { hdrs[k] = v; }); } catch (e) {}
            innerResolve({
              ok: true,
              status: res.status,
              statusText: res.statusText,
              bodyText: txt,
              headers: hdrs
            });
          });
        }).catch(function (e) {
          clearTimeout(timer);
          innerResolve({
            ok: false,
            error: e && e.message ? e.message : String(e),
            aborted: e && e.name === 'AbortError'
          });
        });
      });
    };
    try {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: injectedFunc,
        args: [{ url: url, headers: headers, timeoutMs: timeoutMs || 8000 }],
        world: 'MAIN'
      }, function (results) {
        if (chrome.runtime.lastError || !results || !results.length) {
          resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || '注入失败' });
          return;
        }
        // executeScript 返回的是 Promise，结果在 results[0].result
        var r = results[0] && results[0].result;
        if (r && typeof r === 'object') {
          resolve(r);
        } else {
          resolve({ ok: false, error: '无返回结果' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
  });
}

function handleEnvReplayFetch(args) {
  var prodOrigin = args && args.prodOrigin;
  var pathname = args && args.pathname;
  var query = args && args.query;
  var method = args && args.method;
  var tokenStorageKey = (args && args.tokenStorageKey) || 'token';
  var manualToken = (args && args.manualToken) || '';
  if (!prodOrigin) {
    return Promise.resolve({ ok: false, errorCode: 'PROD_ORIGIN_NOT_CONFIGURED' });
  }
  if (String(method || '').toUpperCase() !== 'GET') {
    return Promise.resolve({ ok: false, errorCode: 'METHOD_NOT_ALLOWED' });
  }
  var base = String(prodOrigin).replace(/\/$/, '');
  var path = pathname || '/';
  var qs = query ? '?' + String(query).replace(/^\?/, '') : '';
  var url = base + path + qs;

  var reqHeaders = (args && args.reqHeaders && typeof args.reqHeaders === 'object') ? args.reqHeaders : null;
  var overrideHeaders = (args && args.overrideHeaders && typeof args.overrideHeaders === 'object') ? args.overrideHeaders : null;

  // 1) 查找正式环境 tab；2) 若需 token，从该 tab localStorage 读取（手动 token 优先）
  return findProdTab(prodOrigin).then(function (tab) {
    var tokenPromise;
    if (manualToken) {
      tokenPromise = Promise.resolve(manualToken);
    } else if (tab) {
      tokenPromise = new Promise(function (resolve) {
        try {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: function (key) {
              try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
            },
            args: [tokenStorageKey || 'token'],
            world: 'MAIN'
          }, function (results) {
            if (chrome.runtime.lastError || !results || !results.length) { resolve(''); return; }
            var v = results[0] && results[0].result;
            resolve(typeof v === 'string' ? v : '');
          });
        } catch (e) { resolve(''); }
      });
    } else {
      tokenPromise = Promise.resolve('');
    }

    return tokenPromise.then(function (token) {
      // 合并请求头：基础 → 测试请求头 → 设置页覆盖头 → Authorization
      var headers = { 'Accept': 'application/json, */*' };
      if (reqHeaders) {
        Object.keys(reqHeaders).forEach(function (k) {
          var lk = String(k).toLowerCase();
          if (lk === 'cookie' || lk === 'content-length' || lk === 'host' || lk === 'origin' || lk === 'referer' ||
              lk === 'sec-fetch-site' || lk === 'sec-fetch-mode' || lk === 'sec-fetch-dest') return;
          headers[k] = reqHeaders[k];
        });
      }
      if (overrideHeaders) {
        Object.keys(overrideHeaders).forEach(function (k) {
          var lk = String(k).toLowerCase();
          if (lk === 'cookie' || lk === 'content-length' || lk === 'host') return;
          headers[k] = overrideHeaders[k];
        });
      }
      if (token) {
        // 兼容用户已带 Bearer/bearer 前缀的粘贴（大小写均可）
        headers['Authorization'] = /^bearer\s+/i.test(token) ? token.replace(/^bearer\s+/i, 'Bearer ') : ('Bearer ' + token);
      }
      var reqInfo = {
        url: url,
        method: 'GET',
        headers: Object.assign({}, headers),
        credentials: 'include',
        body: null,
        viaTab: !!tab
      };

      if (!tab) {
        // 没有正式环境 tab：无法在页面上下文发请求，回退到 service worker fetch（大概率被同源校验拒绝）
        reqInfo.fallbackReason = 'NO_PROD_TAB';
        return fetchViaServiceWorker(url, headers, reqInfo, token);
      }

      // 在正式环境 tab 的 MAIN world 执行 fetch —— same-origin，Referer/Origin 自动正确
      return fetchViaProdTab(tab.id, url, headers, 8000).then(function (r) {
        if (!r.ok) {
          if (r.aborted) return { ok: false, errorCode: 'PROD_FETCH_TIMEOUT', reqInfo: reqInfo };
          return { ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR', error: r.error, reqInfo: reqInfo };
        }
        var len = r.bodyText ? r.bodyText.length : 0;
        if (len > 2 * 1024 * 1024) {
          return { ok: false, errorCode: 'PROD_RESPONSE_TOO_LARGE', status: r.status, reqInfo: reqInfo };
        }
        var warnings = [];
        if (len > 512 * 1024) warnings.push('LARGE_BODY_WARN');
        if (!token) warnings.push('NO_TOKEN_ATTACHED');
        return {
          ok: true,
          status: r.status,
          statusText: r.statusText,
          body: tryParseJsonEnvReplay(r.bodyText),
          rawBody: r.bodyText,
          headers: r.headers || {},
          warnings: warnings,
          reqInfo: reqInfo
        };
      });
    });
  });
}

// 回退路径：没有正式环境 tab 时用 service worker 直接 fetch
function fetchViaServiceWorker(url, headers, reqInfo, token) {
  var controller;
  try { controller = new AbortController(); } catch (e) { controller = null; }
  var timer = null;
  var fetchOpts = { credentials: 'include', headers: headers };
  if (controller) {
    fetchOpts.signal = controller.signal;
    timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, 8000);
  }
  return fetch(url, fetchOpts).then(function (res) {
    return res.text().then(function (bodyText) {
      if (timer) clearTimeout(timer);
      var len = bodyText ? bodyText.length : 0;
      if (len > 2 * 1024 * 1024) {
        return { ok: false, errorCode: 'PROD_RESPONSE_TOO_LARGE', status: res.status, reqInfo: reqInfo };
      }
      var warnings = [];
      if (len > 512 * 1024) warnings.push('LARGE_BODY_WARN');
      if (!token) warnings.push('NO_TOKEN_ATTACHED');
      warnings.push('FALLBACK_NO_PROD_TAB');
      var respHeaders = {};
      try { res.headers.forEach(function (v, k) { respHeaders[k] = v; }); } catch (e) {}
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText,
        body: tryParseJsonEnvReplay(bodyText),
        rawBody: bodyText,
        headers: respHeaders,
        warnings: warnings,
        reqInfo: reqInfo
      };
    });
  }).catch(function (e) {
    if (timer) clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      return { ok: false, errorCode: 'PROD_FETCH_TIMEOUT', reqInfo: reqInfo };
    }
    return { ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR', error: e && e.message ? e.message : String(e), reqInfo: reqInfo };
  });
}
