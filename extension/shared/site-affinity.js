(function (root) {
  'use strict';

  function normalizePathname(pathnameOrUrl) {
    if (!pathnameOrUrl || typeof pathnameOrUrl !== 'string') return '/';
    try {
      var p = pathnameOrUrl.indexOf('://') >= 0
        ? new URL(pathnameOrUrl).pathname
        : pathnameOrUrl;
      if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
      return p || '/';
    } catch (_e) {
      return '/';
    }
  }

  function uuidLikeSegment(seg) {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(seg);
  }

  function segmentPatternToken(seg) {
    if (!seg) return '';
    if (/^\d+$/.test(seg)) return '__NUM__';
    if (uuidLikeSegment(seg)) return '__UUID__';
    if (/^[0-9a-fA-F]{8,}$/.test(seg)) return '__HEX__';
    return seg;
  }

  function buildPathPatternKey(method, pathnameOrUrl) {
    var m = String(method || 'GET').toUpperCase();
    var segs = normalizePathname(pathnameOrUrl).split('/').filter(Boolean);
    var parts = [];
    for (var i = 0; i < segs.length; i++) parts.push(segmentPatternToken(segs[i]));
    return m + '\t' + parts.join('/');
  }

  function isIpHostname(hostname) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
    if (hostname.indexOf(':') >= 0) return true; // bare IPv6-ish
    return false;
  }

  function deriveSiteRoot(hostname) {
    var host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || isIpHostname(host)) return '';
    var parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return '';
    // 最小可用 eTLD+1：默认末两段；常见复合后缀再取三段
    var multi = { 'com.cn': 1, 'net.cn': 1, 'org.cn': 1, 'co.uk': 1, 'com.au': 1 };
    var last2 = parts.slice(-2).join('.');
    if (multi[last2] && parts.length >= 3) return parts.slice(-3).join('.');
    return last2;
  }

  function hostnameOf(value) {
    try {
      if (/^https?:\/\//i.test(value)) return new URL(value).hostname.toLowerCase();
      return String(value || '').toLowerCase();
    } catch (_e) {
      var m = String(value || '').match(/^https?:\/\/([^\/:?#]+)/i);
      return m ? m[1].toLowerCase() : '';
    }
  }

  function collectRecordedHostnames(meta) {
    var source = meta && typeof meta === 'object' ? meta : {};
    var out = Object.create(null);
    function add(value) {
      var h = hostnameOf(value);
      if (h) out[h] = true;
    }
    add(source.toolHost);
    add(source.apiHostname);
    (source.sitePageOrigins || source.pageOrigins || []).forEach(add);
    (source.recordedApiOrigins || []).forEach(add);
    return Object.keys(out);
  }

  function normalizeHttpOrigin(value) {
    try {
      var u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (!u.hostname || u.origin === 'null') return '';
      return u.origin;
    } catch (_e) {
      var m = String(value || '').match(/^(https?):\/\/([^\/:?#]+)(?::(\d+))?/i);
      if (!m) return '';
      var origin = m[1].toLowerCase() + '://' + m[2].toLowerCase();
      if (m[3]) origin += ':' + m[3];
      return origin;
    }
  }

  function normalizeRecordedApiOrigin(input) {
    var source = input && typeof input === 'object' ? input : {};
    var recorded = (source.recordedApiOrigins || []).map(normalizeHttpOrigin).filter(Boolean);
    var uniq = [];
    recorded.forEach(function (o) {
      if (uniq.indexOf(o) < 0) uniq.push(o);
    });
    if (uniq.length === 1) return { ok: true, origin: uniq[0] };
    var host = hostnameOf(source.toolHost || source.apiHostname || '');
    if (host && uniq.length) {
      var matched = uniq.filter(function (o) {
        return hostnameOf(o) === host;
      });
      if (matched.length === 1) return { ok: true, origin: matched[0] };
      if (matched.length > 1) {
        return { ok: false, errorCode: 'AUTH_SOURCE_UNSAFE' };
      }
    }
    if (host && !isIpHostname(host) && host !== 'localhost') {
      return { ok: true, origin: 'https://' + host };
    }
    return { ok: false, errorCode: 'AUTH_SOURCE_UNSAFE' };
  }

  function sameSiteRoot(hostname, siteRoot) {
    var h = String(hostname || '').toLowerCase();
    var root = String(siteRoot || '').toLowerCase();
    if (!h || !root) return false;
    return h === root || h.slice(-(root.length + 1)) === '.' + root;
  }

  /**
   * Derive a trusted siteRoot from recorded hosts / toolHost.
   * meta.siteRoot is accepted only when it equals deriveSiteRoot of some
   * recorded hostname or of toolHost; otherwise recompute.
   */
  function resolveTrustedSiteRoot(meta) {
    var source = meta && typeof meta === 'object' ? meta : {};
    var recordedHosts = collectRecordedHostnames(source);
    var toolHost = hostnameOf(source.toolHost || source.apiHostname || '');
    var allowed = Object.create(null);
    var i;
    for (i = 0; i < recordedHosts.length; i++) {
      var fromHost = deriveSiteRoot(recordedHosts[i]);
      if (fromHost) allowed[fromHost] = true;
    }
    var toolRoot = deriveSiteRoot(toolHost);
    if (toolRoot) allowed[toolRoot] = true;

    var claimed = String(source.siteRoot || '').toLowerCase();
    if (claimed && allowed[claimed]) return claimed;

    if (toolRoot) return toolRoot;
    if (recordedHosts.length) return deriveSiteRoot(recordedHosts[0]) || '';
    return '';
  }

  function resolveProbeOriginForTab(input) {
    var source = input && typeof input === 'object' ? input : {};
    var level = source.level === 'L2' ? 'L2' : 'L1';
    var observed = Array.isArray(source.samePathApiOrigins)
      ? source.samePathApiOrigins.map(normalizeHttpOrigin).filter(Boolean)
      : [];
    var uniqObs = [];
    observed.forEach(function (o) {
      if (uniqObs.indexOf(o) < 0) uniqObs.push(o);
    });
    if (uniqObs.length === 1) return { ok: true, origin: uniqObs[0] };
    if (uniqObs.length > 1) {
      var recorded = (source.recordedApiOrigins || []).map(normalizeHttpOrigin).filter(Boolean);
      var inter = uniqObs.filter(function (o) { return recorded.indexOf(o) >= 0; });
      if (inter.length === 1) return { ok: true, origin: inter[0] };
      return { ok: false, errorCode: 'AUTH_ACCOUNT_AMBIGUOUS', reason: 'multi_api_origin' };
    }
    if (level === 'L2') {
      return { ok: false, errorCode: 'AUTH_TAB_REQUIRED', reason: 'l2_requires_observation' };
    }
    var recordedOrigin = normalizeRecordedApiOrigin(source);
    if (!recordedOrigin.ok) {
      return { ok: false, errorCode: recordedOrigin.errorCode || 'AUTH_SOURCE_UNSAFE' };
    }
    return { ok: true, origin: recordedOrigin.origin };
  }

  root.AiSiteAffinity = {
    normalizePathname: normalizePathname,
    buildPathPatternKey: buildPathPatternKey,
    deriveSiteRoot: deriveSiteRoot,
    collectRecordedHostnames: collectRecordedHostnames,
    normalizeRecordedApiOrigin: normalizeRecordedApiOrigin,
    normalizeHttpOrigin: normalizeHttpOrigin,
    sameSiteRoot: sameSiteRoot,
    resolveTrustedSiteRoot: resolveTrustedSiteRoot,
    hostnameOf: hostnameOf,
    resolveProbeOriginForTab: resolveProbeOriginForTab
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
