function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isStaticResource(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) return true;
  var staticExt = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|mp4|mp3|wav|avi|map|webp)(\?|#|$)/i;
  return staticExt.test(url);
}

function stripSensitiveHeaders(headers) {
  var sensitive = ['cookie', 'authorization', 'set-cookie', 'proxy-authorization', 'www-authenticate', 'proxy-authenticate'];
  var result = {};
  for (var key in headers) {
    if (sensitive.indexOf(key.toLowerCase()) === -1) {
      result[key] = headers[key];
    }
  }
  return result;
}

function inferJsonType(value) {
  if (value === null || typeof value === 'undefined') {
    return { type: 'string' };
  }
  if (typeof value === 'number') {
    return { type: 'number' };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }
  if (typeof value === 'string') {
    if (value === 'true' || value === 'false') {
      return { type: 'boolean' };
    }
    if (/^https?:\/\/.+/i.test(value)) {
      return { type: 'string', format: 'uri' };
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { type: 'string', format: 'email' };
    }
    if (/^\d{13}$/.test(value) && Number(value) > 1e12) {
      return { type: 'integer', format: 'unix-timestamp' };
    }
    return { type: 'string' };
  }
  if (Array.isArray(value)) {
    if (value.length > 0) {
      return { type: 'array', items: inferJsonType(value[0]) };
    }
    return { type: 'array', items: {} };
  }
  if (typeof value === 'object') {
    var props = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      props[keys[i]] = inferJsonType(value[keys[i]]);
    }
    return { type: 'object', properties: props };
  }
  return { type: 'string' };
}

function assessRiskLevel(method, pathname) {
  var m = (method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return 'low';
  if (m === 'DELETE') return 'high';
  var lower = (pathname || '').toLowerCase();
  var highKeywords = ['delete', 'remove', 'cancel', 'pay', 'transfer', 'withdraw'];
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
    for (var i = 0; i < highKeywords.length; i++) {
      if (lower.indexOf(highKeywords[i]) !== -1) return 'high';
    }
    return 'medium';
  }
  return 'medium';
}

function detectAuthType(headers) {
  if (!headers || typeof headers !== 'object') return 'none';
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = headers[k];
    if (/^authorization$/i.test(k) && typeof v === 'string' && v.indexOf('Bearer') === 0) {
      return 'bearer';
    }
  }
  for (var j = 0; j < keys.length; j++) {
    var kj = keys[j];
    if (/^cookie$/i.test(kj) || /^set-cookie$/i.test(kj)) {
      return 'cookie';
    }
  }
  for (var x = 0; x < keys.length; x++) {
    var kx = keys[x];
    if (/^x-/i.test(kx)) {
      return 'custom';
    }
  }
  return 'none';
}

function extractQueryParams(url) {
  var result = {};
  if (!url || typeof url !== 'string') return result;
  try {
    var parsed = new URL(url);
    parsed.searchParams.forEach(function (val, key) {
      result[key] = val;
    });
  } catch (e) {
    var qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      var qs = url.substring(qIdx + 1);
      var hashIdx = qs.indexOf('#');
      if (hashIdx !== -1) qs = qs.substring(0, hashIdx);
      var pairs = qs.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i].split('=');
        if (pair.length >= 1) {
          result[decodeURIComponent(pair[0])] = pair.length >= 2 ? decodeURIComponent(pair[1]) : '';
        }
      }
    }
  }
  return result;
}

function normalizePathnameFromRecordUrl(recUrl) {
  if (!recUrl || typeof recUrl !== 'string') return '/';
  try {
    var u = new URL(recUrl);
    var p = u.pathname || '/';
    if (p.length > 1 && p.charAt(p.length - 1) === '/') {
      p = p.slice(0, -1);
    }
    return p || '/';
  } catch (e0) {
    var s = recUrl;
    var qi = s.indexOf('?');
    if (qi !== -1) s = s.substring(0, qi);
    var hi = s.indexOf('#');
    if (hi !== -1) s = s.substring(0, hi);
    if (s.length > 1 && s.charAt(s.length - 1) === '/') {
      s = s.slice(0, -1);
    }
    return s || '/';
  }
}

function uuidLikeSegment(seg) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(seg);
}

function segmentPatternToken(seg) {
  if (seg === undefined || seg === null || seg === '') return '';
  if (/^\d+$/.test(seg)) return '__NUM__';
  if (uuidLikeSegment(seg)) return '__UUID__';
  if (/^[0-9a-fA-F]{8,}$/.test(seg)) return '__HEX__';
  return seg;
}

function patternKeyFromNormalizedPath(normPath) {
  var segs = normPath.split('/').filter(Boolean);
  var parts = [];
  for (var i = 0; i < segs.length; i++) {
    parts.push(segmentPatternToken(segs[i]));
  }
  return parts.join('/');
}

function buildRecordPathPatternKey(method, recUrlOrPath) {
  if (typeof AiSiteAffinity !== 'undefined' && AiSiteAffinity.buildPathPatternKey) {
    return AiSiteAffinity.buildPathPatternKey(method, recUrlOrPath);
  }
  var norm = normalizePathnameFromRecordUrl(recUrlOrPath);
  return String(method || 'GET').toUpperCase() + '\t' + patternKeyFromNormalizedPath(norm);
}

function mergeRecordedApiOrigins(existing, incoming) {
  var out = Array.isArray(existing) ? existing.slice() : [];
  var list = Array.isArray(incoming) ? incoming : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && out.indexOf(list[i]) < 0) out.push(list[i]);
  }
  return out;
}

function collectRecordedApiOriginsFromRecords(records) {
  var out = [];
  for (var i = 0; i < records.length; i++) {
    var recUrl = records[i].originalUrl || records[i].url || '';
    try {
      var origin = new URL(recUrl).origin;
      if (origin && out.indexOf(origin) < 0) out.push(origin);
    } catch (_e) {}
  }
  return out;
}

function deriveSiteRootFromUrl(urlValue, fallback) {
  try {
    var host = new URL(urlValue).hostname;
    if (typeof AiSiteAffinity !== 'undefined' && host) {
      return AiSiteAffinity.deriveSiteRoot(host) || fallback || '';
    }
  } catch (_e) {}
  return fallback || '';
}

function buildMcpRecordClusters(filteredRecords) {
  var buckets = {};
  for (var i = 0; i < filteredRecords.length; i++) {
    var rec = filteredRecords[i];
    var recUrl = rec.originalUrl || rec.url || '';
    var method = (rec.method || 'GET').toUpperCase();
    var norm = normalizePathnameFromRecordUrl(recUrl);
    var pk = buildRecordPathPatternKey(method, recUrl);
    if (!buckets[pk]) buckets[pk] = [];
    buckets[pk].push(rec);
  }
  var result = [];
  for (var key in buckets) {
    if (!buckets.hasOwnProperty(key)) continue;
    var recs = buckets[key];
    var method0 = (recs[0].method || 'GET').toUpperCase();
    var paths = [];
    for (var j = 0; j < recs.length; j++) {
      paths.push(normalizePathnameFromRecordUrl(recs[j].originalUrl || recs[j].url || ''));
    }
    paths.sort();
    var repPath = paths[0];
    var segs = repPath.split('/').filter(Boolean);
    var tokenParts = [];
    for (var t = 0; t < segs.length; t++) {
      tokenParts.push(segmentPatternToken(segs[t]));
    }
    var pathPatternKey = buildRecordPathPatternKey(method0, repPath);
    var pathParamSlots = [];
    var usedNames = {};
    for (var si = 0; si < tokenParts.length; si++) {
      var tok = tokenParts[si];
      if (tok === '__NUM__' || tok === '__UUID__' || tok === '__HEX__') {
        var prevLit = si > 0 && tokenParts[si - 1].indexOf('__') !== 0 ? tokenParts[si - 1] : '';
        var base = prevLit ? prevLit.replace(/[^a-zA-Z0-9_]/g, '') + '_id' : 'id';
        var pname = base;
        var z = 0;
        while (usedNames[pname]) {
          z++;
          pname = base + '_' + z;
        }
        usedNames[pname] = true;
        pathParamSlots.push({ index: si, name: pname });
      }
    }
    var pathnameTemplate = repPath;
    if (pathParamSlots.length > 0) {
      pathnameTemplate = '';
      for (var ti = 0; ti < segs.length; ti++) {
        var slotNm = null;
        for (var pm = 0; pm < pathParamSlots.length; pm++) {
          if (pathParamSlots[pm].index === ti) {
            slotNm = pathParamSlots[pm].name;
            break;
          }
        }
        pathnameTemplate += '/' + (slotNm ? '{' + slotNm + '}' : segs[ti]);
      }
      if (!pathnameTemplate) pathnameTemplate = '/';
    }
    var pathParamKeys = pathParamSlots.map(function (s) { return s.name; });
    result.push({
      method: method0,
      records: recs,
      pathnameRep: repPath,
      pathnameTemplate: pathnameTemplate,
      pathParamSlots: pathParamSlots,
      pathParamKeys: pathParamKeys,
      pathPatternKey: pathPatternKey
    });
  }
  return result;
}

function pathnameTemplateToSnakeBase(pt) {
  var inner = (pt || '').replace(/^\/+|\/+$/g, '');
  if (!inner) return 'root';
  var s = inner.replace(/\{([^}]+)\}/g, '$1').replace(/\//g, '_');
  return s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function deriveFullMcpToolName(method, pathnameTemplate) {
  return (method || 'GET').toLowerCase() + '_' + pathnameTemplateToSnakeBase(pathnameTemplate);
}

function simpleHashCanonical(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

function deriveCompactMcpToolName(method, pathnameTemplate) {
  var rawSegs = (pathnameTemplate || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  var tail = rawSegs.length ? rawSegs[rawSegs.length - 1] : 'tool';
  if (tail.charAt(0) === '{') {
    tail = rawSegs.length >= 2 ? rawSegs[rawSegs.length - 2] : 'seg';
  }
  tail = tail.replace(/\{|\}/g, '');
  var tailSnake = pathnameTemplateToSnakeBase('/' + tail);
  if (tailSnake.length > 28) tailSnake = tailSnake.slice(0, 28);
  var hx = simpleHashCanonical(String(method).toUpperCase() + '\n' + pathnameTemplate);
  return (method || 'GET').toLowerCase() + '_' + tailSnake + '_' + hx;
}

function allocateMcpToolNameInBatch(baseName, claimedNames) {
  claimedNames = claimedNames || {};
  var n = baseName;
  var u = 0;
  while ((typeof state !== 'undefined' && state.mcpTools && state.mcpTools[n]) || claimedNames[n]) {
    u++;
    n = baseName + '_' + u;
  }
  claimedNames[n] = true;
  return n;
}

function uniquifyPathSlotsAgainstProps(group, propKeysObj) {
  var template = group.pathnameTemplate;
  var slots = [];
  var ii;
  for (ii = 0; ii < group.pathParamSlots.length; ii++) {
    slots.push({ index: group.pathParamSlots[ii].index, name: group.pathParamSlots[ii].name });
  }
  var used = {};
  var pk;
  for (pk in propKeysObj) {
    if (propKeysObj.hasOwnProperty(pk)) used[pk] = true;
  }
  var outKeys = [];
  for (ii = 0; ii < slots.length; ii++) {
    var nm = slots[ii].name;
    var origBraced = '{' + nm + '}';
    if (!used[nm]) {
      used[nm] = true;
      outKeys.push(nm);
      continue;
    }
    var renamed = 'path_' + nm;
    var zz = 0;
    while (used[renamed]) {
      zz++;
      renamed = 'path_' + nm + '_' + zz;
    }
    template = template.split(origBraced).join('{' + renamed + '}');
    slots[ii] = { index: slots[ii].index, name: renamed };
    used[renamed] = true;
    outKeys.push(renamed);
  }
  return {
    pathnameTemplate: template,
    pathParamSlots: slots,
    pathParamKeys: outKeys
  };
}

function mergeFieldsForMcpCluster(group, templateTool, enhanced) {
  var reservedKeys = {};
  var rp = templateTool.inputSchema.properties || {};
  var rk = Object.keys(rp);
  var ri;
  for (ri = 0; ri < rk.length; ri++) reservedKeys[rk[ri]] = true;

  var uniqGroup = group;
  if (group.pathParamSlots && group.pathParamSlots.length) {
    var uq = uniquifyPathSlotsAgainstProps(group, reservedKeys);
    uniqGroup = {
      method: group.method,
      records: group.records,
      pathnameRep: group.pathnameRep,
      pathnameTemplate: uq.pathnameTemplate,
      pathParamSlots: uq.pathParamSlots,
      pathParamKeys: uq.pathParamKeys,
      pathPatternKey: group.pathPatternKey
    };
    for (ri = 0; ri < uq.pathParamKeys.length; ri++) reservedKeys[uq.pathParamKeys[ri]] = true;
  }

  var fieldPresence = {};
  var fieldValues = {};
  function touchField(fname) {
    if (!fieldPresence.hasOwnProperty(fname)) {
      fieldPresence[fname] = 0;
      fieldValues[fname] = [];
    }
  }

  var propKeysInit = Object.keys(templateTool.inputSchema.properties || {});
  for (var p = 0; p < propKeysInit.length; p++) {
    fieldPresence[propKeysInit[p]] = 0;
    fieldValues[propKeysInit[p]] = [];
  }

  var r;
  for (r = 0; r < uniqGroup.records.length; r++) {
    var body = uniqGroup.records[r].requestBody;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      var bKeys = Object.keys(body);
      for (var bk = 0; bk < bKeys.length; bk++) {
        touchField(bKeys[bk]);
        fieldPresence[bKeys[bk]]++;
        fieldValues[bKeys[bk]].push(body[bKeys[bk]]);
      }
    } else if (Array.isArray(body)) {
      touchField('body');
      fieldPresence['body']++;
      fieldValues['body'].push(body);
    } else if (typeof body === 'string' && body.trim()) {
      touchField('body');
      fieldPresence['body']++;
      fieldValues['body'].push(body);
    }

    var qParams = extractQueryParams(uniqGroup.records[r].originalUrl || uniqGroup.records[r].url || '');
    var qpKeys = Object.keys(qParams);
    for (var qp = 0; qp < qpKeys.length; qp++) {
      touchField(qpKeys[qp]);
      fieldPresence[qpKeys[qp]]++;
      fieldValues[qpKeys[qp]].push(qParams[qpKeys[qp]]);
    }
  }

  if (uniqGroup.pathParamSlots && uniqGroup.pathParamSlots.length) {
    var psi;
    for (psi = 0; psi < uniqGroup.pathParamSlots.length; psi++) {
      var slot = uniqGroup.pathParamSlots[psi];
      touchField(slot.name);
      for (var pr = 0; pr < uniqGroup.records.length; pr++) {
        var segVal = '';
        try {
          var segArr = normalizePathnameFromRecordUrl(uniqGroup.records[pr].originalUrl || uniqGroup.records[pr].url || '').split('/').filter(Boolean);
          segVal = segArr[slot.index] || '';
        } catch (eSeg) {}
        fieldPresence[slot.name]++;
        fieldValues[slot.name].push(segVal);
      }
    }
  }

  var coveredSegIdx = {};
  if (uniqGroup.pathParamSlots) {
    for (var cx = 0; cx < uniqGroup.pathParamSlots.length; cx++) {
      coveredSegIdx[uniqGroup.pathParamSlots[cx].index] = true;
    }
  }

  if (enhanced) {
    var pathInfos = inferPathParams(uniqGroup.pathnameRep, uniqGroup.records);
    for (var pi = 0; pi < pathInfos.length; pi++) {
      if (coveredSegIdx[pathInfos[pi].position]) continue;
      var pn = 'path_seg_' + pathInfos[pi].position + '_' + (pathInfos[pi].name || 'p');
      touchField(pn);
      for (var pr2 = 0; pr2 < uniqGroup.records.length; pr2++) {
        var segVal2 = '';
        try {
          var segArr2 = normalizePathnameFromRecordUrl(uniqGroup.records[pr2].originalUrl || uniqGroup.records[pr2].url || '').split('/').filter(Boolean);
          segVal2 = segArr2[pathInfos[pi].position] || '';
        } catch (e2a) {}
        fieldPresence[pn]++;
        fieldValues[pn].push(segVal2);
      }
    }
  }

  var requiredFields = [];
  var pkAll = Object.keys(fieldPresence);
  for (var pi2 = 0; pi2 < pkAll.length; pi2++) {
    if (fieldPresence[pkAll[pi2]] === uniqGroup.records.length) {
      requiredFields.push(pkAll[pi2]);
    }
  }

  var mergedProps = {};
  var mpk = Object.keys(fieldPresence);
  for (var mi = 0; mi < mpk.length; mi++) {
    var fName = mpk[mi];
    var vals = fieldValues[fName];
    if (vals.length > 0) {
      var vi0;
      for (vi0 = 0; vi0 < vals.length; vi0++) {
        if (vals[vi0] !== null && vals[vi0] !== undefined) break;
      }
      var seedVal = vi0 < vals.length ? vals[vi0] : '';
      var agg = inferJsonType(seedVal);
      for (var vj = 0; vj < vals.length; vj++) {
        if (vals[vj] === null || vals[vj] === undefined) continue;
        agg = unifyJsonSchemas(agg, inferJsonType(vals[vj]));
      }
      mergedProps[fName] = agg;
      var uniqueVals = [];
      var seen = {};
      for (var vi = 0; vi < vals.length; vi++) {
        if (vals[vi] === null || vals[vi] === undefined) continue;
        var vs = typeof vals[vi] === 'object' ? JSON.stringify(vals[vi]) : String(vals[vi]);
        if (!seen[vs]) {
          seen[vs] = true;
          uniqueVals.push(vals[vi]);
        }
      }
      if (uniqueVals.length > 1 && uniqueVals.length <= 10 && mergedProps[fName].type === 'string' && !mergedProps[fName].oneOf) {
        mergedProps[fName].enum = uniqueVals.map(function (v) { return typeof v === 'string' ? v : String(v); });
      }
    } else {
      mergedProps[fName] = { type: 'string' };
    }
  }

  return { mergedProps: mergedProps, requiredFields: requiredFields, uniqGroup: uniqGroup };
}

function finalizeGroupedMcpTool(templateTool, mergeOut, claimedNames, enhancedFlag) {
  var uniqGroup = mergeOut.uniqGroup;
  templateTool.inputSchema.properties = mergeOut.mergedProps;
  templateTool.inputSchema.required = mergeOut.requiredFields;

  var latestTs = 0;
  for (var lt = 0; lt < uniqGroup.records.length; lt++) {
    var ts = uniqGroup.records[lt].timestamp || 0;
    if (ts > latestTs) latestTs = ts;
  }

  templateTool._meta.observedCount = uniqGroup.records.length;
  templateTool._meta.lastObserved = latestTs;
  templateTool._meta.pathname = uniqGroup.pathnameTemplate;
  templateTool._meta.pathPatternKey = uniqGroup.pathPatternKey;
  templateTool._meta.pathnameSample = uniqGroup.pathnameRep;
  templateTool._meta.recordedApiOrigins = mergeRecordedApiOrigins(
    templateTool._meta.recordedApiOrigins,
    collectRecordedApiOriginsFromRecords(uniqGroup.records)
  );
  if (!templateTool._meta.siteRoot) {
    for (var sr = 0; sr < uniqGroup.records.length; sr++) {
      var srUrl = uniqGroup.records[sr].originalUrl || uniqGroup.records[sr].url || '';
      templateTool._meta.siteRoot = deriveSiteRootFromUrl(srUrl, '');
      if (templateTool._meta.siteRoot) break;
    }
  }
  templateTool._meta.riskLevel = assessRiskLevel(uniqGroup.method, uniqGroup.pathnameRep);
  if (uniqGroup.pathParamKeys && uniqGroup.pathParamKeys.length) {
    templateTool._meta.pathParamKeys = uniqGroup.pathParamKeys.slice();
  } else {
    delete templateTool._meta.pathParamKeys;
  }

  if (enhancedFlag) templateTool._meta.enhancedSchema = true;
  else delete templateTool._meta.enhancedSchema;

  var naming = (typeof state !== 'undefined' && state.config && state.config.mcpToolNaming) || 'full';
  var baseName = naming === 'compact'
    ? deriveCompactMcpToolName(uniqGroup.method, uniqGroup.pathnameTemplate)
    : deriveFullMcpToolName(uniqGroup.method, uniqGroup.pathnameTemplate);
  templateTool.name = allocateMcpToolNameInBatch(baseName, claimedNames);

  return templateTool;
}

function metaPathCompatibleForMerge(ma, mb) {
  var pa = (ma.pathPatternKey || '').trim();
  var pb = (mb.pathPatternKey || '').trim();
  if (pa && pb && pa === pb) return true;
  var maPk = ma.pathParamKeys;
  var mbPk = mb.pathParamKeys;
  var maHasPath = maPk && maPk.length;
  var mbHasPath = mbPk && mbPk.length;
  if (maHasPath && mbHasPath && (ma.pathname || '') === (mb.pathname || '') && (ma.method || '').toUpperCase() === (mb.method || '').toUpperCase()) {
    return true;
  }
  if (!maHasPath && !mbHasPath && (ma.method || '').toUpperCase() === (mb.method || '').toUpperCase() && (ma.pathname || '') === (mb.pathname || '')) {
    return true;
  }
  return false;
}

function inferPathParams(pathname, sampleRecords) {
  if (!pathname || !sampleRecords || !sampleRecords.length) return [];
  var segments = pathname.split('/').filter(Boolean);
  var paramList = [];
  for (var s = 0; s < segments.length; s++) {
    var seg = segments[s];
    if (/^\d+$/.test(seg)) {
      paramList.push({ name: 'id', position: s });
      continue;
    }
    var isHexId = /^[0-9a-fA-F]{8,}$/.test(seg);
    if (isHexId) {
      paramList.push({ name: 'id', position: s });
      continue;
    }
    var isVarSegment = false;
    for (var r = 1; r < sampleRecords.length; r++) {
      try {
        var otherPath = new URL(sampleRecords[r].url || sampleRecords[r].originalUrl || '').pathname;
        var otherSegs = otherPath.split('/').filter(Boolean);
        if (otherSegs[s] && otherSegs[s] !== seg) {
          isVarSegment = true;
          break;
        }
      } catch (e) {}
    }
    if (isVarSegment) {
      var pName = seg.replace(/[0-9]+/g, '').replace(/-+$/g, '') || 'param';
      paramList.push({ name: pName, position: s });
    }
  }
  return paramList;
}

function mcpToolsMetaConflictKey(tool) {
  if (!tool || typeof tool !== 'object') return '';
  var m = tool._meta || {};
  var ppk = String(m.pathPatternKey || '').trim();
  if (ppk) return 'ppk:' + ppk;
  return 'lit:' + String(m.method || 'GET').toUpperCase() + '\t' + String(m.pathname || '');
}

function findExistingMcpToolNameByConflictKey(newTool, mcpMap) {
  var target = mcpToolsMetaConflictKey(newTool);
  var nm;
  for (nm in mcpMap) {
    if (!Object.prototype.hasOwnProperty.call(mcpMap, nm)) continue;
    var ex = mcpMap[nm];
    if (!ex || typeof ex !== 'object') continue;
    if (mcpToolsMetaConflictKey(ex) === target) return nm;
  }
  return null;
}

function shouldSkipApplyingGeneratedMcpTool(t, mcpMap) {
  if (!t || !t.name) return true;
  if (findExistingMcpToolNameByConflictKey(t, mcpMap)) return true;
  if (Object.prototype.hasOwnProperty.call(mcpMap, t.name)) return true;
  return false;
}

function sanitizeMcpToolForStorage(tool) {
  return AiRuntimeAuth.sanitizeToolForStorage(tool);
}

function sanitizeMcpToolsForStorage(toolsObj) {
  return AiRuntimeAuth.sanitizeToolsForStorage(toolsObj);
}

function mergeGeneratedMcpToolsIntoState(toolsArray) {
  var mcpMap = state.mcpTools || (state.mcpTools = {});
  var added = 0;
  var skipped = 0;
  var i;
  if (!toolsArray || !toolsArray.length) return { added: 0, skipped: 0 };
  for (i = 0; i < toolsArray.length; i++) {
    var t = sanitizeMcpToolForStorage(toolsArray[i]);
    if (shouldSkipApplyingGeneratedMcpTool(t, mcpMap)) {
      skipped++;
      continue;
    }
    mcpMap[t.name] = t;
    added++;
  }
  return { added: added, skipped: skipped };
}

function removeDuplicateMcpToolsByConflictKeyForHostname(hostname) {
  var mtools = loadToolsObjectForHostname(hostname);
  if (!mtools || typeof mtools !== 'object') return 0;
  var groups = Object.create(null);
  var nm;
  for (nm in mtools) {
    if (!Object.prototype.hasOwnProperty.call(mtools, nm)) continue;
    var tk = mcpToolsMetaConflictKey(mtools[nm]);
    if (!groups[tk]) groups[tk] = [];
    groups[tk].push(nm);
  }
  var removed = 0;
  var gk;
  for (gk in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, gk)) continue;
    var names = groups[gk].slice().sort();
    if (names.length < 2) continue;
    var zi;
    for (zi = 1; zi < names.length; zi++) {
      var kill = names[zi];
      delete mtools[kill];
      if (state.selectedMcpToolNames && state.selectedMcpToolNames[kill]) {
        delete state.selectedMcpToolNames[kill];
      }
      removed++;
    }
  }
  if (removed) persistToolsObjectForHostname(hostname, mtools);
  return removed;
}

function removeDuplicateMcpToolsByConflictKey() {
  return removeDuplicateMcpToolsByConflictKeyForHostname(location.hostname);
}

function generateMcpToolFromRecord(req) {
  var reqUrl = req.originalUrl || req.url || '';
  var method = (req.method || 'GET').toUpperCase();
  var parsed;
  try {
    parsed = new URL(reqUrl);
  } catch (e) {
    parsed = { pathname: reqUrl, search: '', origin: '' };
  }
  var pathname = normalizePathnameFromRecordUrl(reqUrl);

  var naming = (typeof state !== 'undefined' && state.config && state.config.mcpToolNaming) || 'full';
  var baseNm = naming === 'compact'
    ? deriveCompactMcpToolName(method, pathname)
    : deriveFullMcpToolName(method, pathname);
  var toolName = allocateMcpToolNameInBatch(baseNm, {});

  var description;
  if (req.aiAnalysis && typeof req.aiAnalysis === 'string') {
    var firstLine = req.aiAnalysis.split('\n')[0].trim();
    description = firstLine || (method + ' ' + pathname);
  } else {
    description = method + ' ' + pathname;
  }

  var properties = {};
  var required = [];

  if (req.requestBody && typeof req.requestBody === 'object' && !Array.isArray(req.requestBody)) {
    var bodyKeys = Object.keys(req.requestBody);
    for (var b = 0; b < bodyKeys.length; b++) {
      properties[bodyKeys[b]] = inferJsonType(req.requestBody[bodyKeys[b]]);
      required.push(bodyKeys[b]);
    }
  }

  var queryParams = extractQueryParams(reqUrl);
  var qKeys = Object.keys(queryParams);
  for (var q = 0; q < qKeys.length; q++) {
    properties[qKeys[q]] = { type: 'string' };
    required.push(qKeys[q]);
  }

  var isReadOnly = (method === 'GET' || method === 'HEAD');
  var riskLevel = assessRiskLevel(method, pathname);
  var operationClass = AiRuntimeAuth.classifyOperation({
    method: method,
    operationClass: isReadOnly ? 'read' : 'write_sensitive',
    isReadOnly: isReadOnly,
    pathname: pathname
  });
  var authHint = AiRuntimeAuth.describeAuthHeaders(req.requestHeaders || {});
  var recordedBusinessHeaders = AiRuntimeAuth.sanitizeUntrustedHeaders(
    req.requestHeaders || {},
    operationClass,
    authHint.authHeaderNames
  );
  var contentType = '';
  if (recordedBusinessHeaders) {
    var ctKeys = Object.keys(recordedBusinessHeaders);
    for (var c = 0; c < ctKeys.length; c++) {
      if (/^content-type$/i.test(ctKeys[c])) {
        contentType = recordedBusinessHeaders[ctKeys[c]];
        break;
      }
    }
  }

  var apiOrigin = (parsed && parsed.origin) || '';
  var siteRoot = deriveSiteRootFromUrl(reqUrl, '');

  return {
    name: toolName,
    description: description,
    inputSchema: {
      type: 'object',
      properties: properties,
      required: required
    },
    _meta: {
      origin: apiOrigin,
      pathname: pathname,
      method: method,
      recordedBusinessHeaders: recordedBusinessHeaders,
      authHeaderNames: authHint.authHeaderNames,
      sampleResponseBody: req.responseBody || null,
      detectedAuthType: authHint.detectedAuthType,
      contentType: contentType,
      observedCount: 1,
      lastObserved: req.timestamp || Date.now(),
      operationClass: operationClass,
      isReadOnly: isReadOnly,
      riskLevel: riskLevel,
      recordedApiOrigins: apiOrigin ? [apiOrigin] : [],
      siteRoot: siteRoot
    },
    enabled: true
  };
}

function generateMcpToolsFromRecords(records) {
  if (!records || !Array.isArray(records)) return [];
  var filtered = records.filter(function (rec) {
    var u = rec.originalUrl || rec.url || '';
    if (isStaticResource(u)) return false;
    if (u.indexOf('api.moonshot.cn') !== -1) return false;
    return true;
  });

  var clusters = buildMcpRecordClusters(filtered);
  var tools = [];
  var claimedNames = {};
  var gc;
  for (gc = 0; gc < clusters.length; gc++) {
    var cluster = clusters[gc];
    if (!cluster.records.length) continue;
    var templateTool = generateMcpToolFromRecord(cluster.records[0]);
    var mergeOut = mergeFieldsForMcpCluster(cluster, templateTool, false);
    finalizeGroupedMcpTool(templateTool, mergeOut, claimedNames, false);
    tools.push(templateTool);
  }

  return tools;
}

function schemasShallowEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return false;
  }
}

function unifyJsonSchemas(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (schemasShallowEqual(existing, incoming)) return existing;
  if (incoming.type === existing.type && existing.type !== 'array' && existing.type !== 'object') {
    return existing;
  }
  var schemas = [];
  function pushUnique(s) {
    for (var u = 0; u < schemas.length; u++) {
      if (schemasShallowEqual(schemas[u], s)) return;
    }
    schemas.push(s);
  }
  if (existing.oneOf && Array.isArray(existing.oneOf)) {
    for (var oi = 0; oi < existing.oneOf.length; oi++) pushUnique(existing.oneOf[oi]);
  } else {
    pushUnique(existing);
  }
  if (incoming.oneOf && Array.isArray(incoming.oneOf)) {
    for (var oj = 0; oj < incoming.oneOf.length; oj++) pushUnique(incoming.oneOf[oj]);
  } else {
    pushUnique(incoming);
  }
  if (schemas.length === 1) return schemas[0];
  return { oneOf: schemas };
}

function generateMcpToolsFromRecordsEnhanced(records) {
  if (!records || !Array.isArray(records)) return [];
  var filtered = records.filter(function (rec) {
    var u = rec.originalUrl || rec.url || '';
    if (isStaticResource(u)) return false;
    if (u.indexOf('api.moonshot.cn') !== -1) return false;
    return true;
  });

  var clusters = buildMcpRecordClusters(filtered);
  var tools = [];
  var claimedNames = {};
  var gc;
  for (gc = 0; gc < clusters.length; gc++) {
    var cluster = clusters[gc];
    if (!cluster.records.length) continue;
    var templateTool = generateMcpToolFromRecord(cluster.records[0]);
    var mergeOut = mergeFieldsForMcpCluster(cluster, templateTool, true);
    finalizeGroupedMcpTool(templateTool, mergeOut, claimedNames, true);
    tools.push(templateTool);
  }

  return tools;
}

function mergeMcpToolDefinitions(toolObjs) {
  if (!toolObjs || toolObjs.length < 2) {
    throw new Error('至少需要 2 个工具合并');
  }
  var refs = [];
  for (var ri = 0; ri < toolObjs.length; ri++) {
    if (!toolObjs[ri]) throw new Error('工具为空');
    refs.push(toolObjs[ri]);
  }
  var m0 = refs[0]._meta || {};
  var method = (m0.method || '').toUpperCase();
  var pathname = m0.pathname || '';
  for (var c = 1; c < refs.length; c++) {
    var mc = refs[c]._meta || {};
    if (!metaPathCompatibleForMerge(m0, mc)) {
      throw new Error('仅能合并同一接口模板（method + pathPattern）的工具');
    }
  }

  var mergedProps = {};
  var intersectRequired = null;
  for (var r = 0; r < refs.length; r++) {
    var tool = refs[r];
    var props = (tool.inputSchema && tool.inputSchema.properties) || {};
    var reqList = (tool.inputSchema && tool.inputSchema.required) || [];
    if (intersectRequired === null) {
      intersectRequired = {};
      for (var j = 0; j < reqList.length; j++) intersectRequired[reqList[j]] = true;
    } else {
      var nextI = {};
      for (var j2 = 0; j2 < reqList.length; j2++) {
        if (intersectRequired[reqList[j2]]) nextI[reqList[j2]] = true;
      }
      intersectRequired = nextI;
    }
    var pk = Object.keys(props);
    for (var pkI = 0; pkI < pk.length; pkI++) {
      var k = pk[pkI];
      if (!mergedProps[k]) mergedProps[k] = props[k];
      else mergedProps[k] = unifyJsonSchemas(mergedProps[k], props[k]);
    }
  }

  var snakeBase = pathnameTemplateToSnakeBase(pathname);
  var baseName = method.toLowerCase() + '_' + snakeBase + '_merged';
  var newName = baseName;
  var suffix = 0;
  while (state.mcpTools[newName]) {
    suffix++;
    newName = baseName + '_' + suffix;
  }

  var descriptions = [];
  for (var d = 0; d < refs.length; d++) {
    if (refs[d].description) descriptions.push(String(refs[d].description));
  }
  var desc = descriptions.length ? descriptions[0] + '\uFF08\u5408\u5E76' + descriptions.length + '\u4E2A\u5B9A\u4E49\uFF09' : method + ' ' + pathname + ' merged';

  var operationClass = AiRuntimeAuth.classifyOperation({
    method: method,
    operationClass: m0.operationClass,
    isReadOnly: m0.isReadOnly === true,
    pathname: pathname
  });
  var untrustedHeaders = Object.assign(
    {},
    m0.sampleRequestHeaders || {},
    m0.rawRequestHeaders || {},
    m0.recordedBusinessHeaders || {}
  );
  var authHint = AiRuntimeAuth.describeAuthHeaders(untrustedHeaders);
  var authHeaderNames = authHint.authHeaderNames.slice();
  var existingAuthHeaderNames = Array.isArray(m0.authHeaderNames)
    ? m0.authHeaderNames
    : [];
  for (var ah = 0; ah < existingAuthHeaderNames.length; ah++) {
    var normalizedAuthName = String(existingAuthHeaderNames[ah] || '').toLowerCase();
    if (normalizedAuthName && authHeaderNames.indexOf(normalizedAuthName) < 0) {
      authHeaderNames.push(normalizedAuthName);
    }
  }
  var recordedBusinessHeaders = AiRuntimeAuth.sanitizeUntrustedHeaders(
    untrustedHeaders,
    operationClass,
    authHeaderNames
  );
  var mergedOrigins = [];
  var mergedSiteRoot = '';
  for (var mo = 0; mo < refs.length; mo++) {
    var refMeta = refs[mo]._meta || {};
    mergedOrigins = mergeRecordedApiOrigins(mergedOrigins, refMeta.recordedApiOrigins);
    if (!mergedSiteRoot && refMeta.siteRoot) mergedSiteRoot = refMeta.siteRoot;
  }
  if (!mergedSiteRoot && m0.origin) {
    mergedSiteRoot = deriveSiteRootFromUrl(m0.origin, '');
  }
  var merged = {
    name: newName,
    description: desc,
    inputSchema: {
      type: 'object',
      properties: mergedProps,
      required: intersectRequired ? Object.keys(intersectRequired) : []
    },
    _meta: {
      origin: m0.origin || '',
      pathname: pathname,
      pathParamKeys: (m0.pathParamKeys && m0.pathParamKeys.length) ? m0.pathParamKeys.slice() : undefined,
      method: method,
      recordedBusinessHeaders: recordedBusinessHeaders,
      authHeaderNames: authHeaderNames,
      sampleResponseBody: m0.sampleResponseBody !== undefined ? m0.sampleResponseBody : null,
      detectedAuthType: authHint.detectedAuthType !== 'none'
        ? authHint.detectedAuthType
        : (m0.detectedAuthType || 'none'),
      contentType: m0.contentType || '',
      observedCount: refs.length,
      lastObserved: Date.now(),
      operationClass: operationClass,
      isReadOnly: m0.isReadOnly,
      riskLevel: m0.riskLevel || 'medium',
      mergedFrom: refs.map(function (x) { return x.name || ''; }),
      pathPatternKey: m0.pathPatternKey,
      pathnameSample: m0.pathnameSample,
      recordedApiOrigins: mergedOrigins,
      siteRoot: mergedSiteRoot
    },
    enabled: true
  };

  return merged;
}

function stripSensitiveHeadersInToolMeta(tool) {
  return AiRuntimeAuth.sanitizeToolForStorage(tool);
}

function buildMcpToolsExportPayload(toolSubset) {
  var toolsObj = AiRuntimeAuth.sanitizeToolsForStorage(toolSubset || {});
  return {
    format: 'ai-req-analyzer-mcp-tools',
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceHostname: typeof location !== 'undefined' ? location.hostname : '',
    tools: toolsObj
  };
}

function validateImportedMcpPayload(obj) {
  if (!obj || typeof obj !== 'object') return '无效文件';
  if (obj.format !== 'ai-req-analyzer-mcp-tools') return 'format 不匹配';
  if (!obj.tools || typeof obj.tools !== 'object' || Array.isArray(obj.tools)) return 'tools 无效';
  var keys = Object.keys(obj.tools);
  if (keys.length === 0) return '无任何工具';
  var ki;
  for (ki = 0; ki < keys.length; ki++) {
    var t = obj.tools[keys[ki]];
    if (!t || typeof t !== 'object') return '工具条目损坏';
    if (!t.inputSchema || t.inputSchema.type !== 'object') return '缺少 inputSchema';
    if (!t.name || typeof t.name !== 'string') return '工具缺少 name';
  }
  return '';
}

function applyMcpToolsImport(parsed, mergeReplace, conflictMode) {
  var errMsg = validateImportedMcpPayload(parsed);
  if (errMsg) return { ok: false, error: errMsg };
  var incoming = parsed.tools;
  conflictMode = conflictMode || 'skip';

  if (mergeReplace === 'replace') {
    state.mcpTools = {};
    for (var rk in incoming) {
      if (!incoming.hasOwnProperty(rk)) continue;
      var toRepl = sanitizeMcpToolForStorage(incoming[rk]);
      if (!toRepl) continue;
      state.mcpTools[toRepl.name] = toRepl;
    }
    return { ok: true, imported: Object.keys(state.mcpTools).length };
  }

  var count = 0;
  for (var nk in incoming) {
    if (!incoming.hasOwnProperty(nk)) continue;
    var tool = sanitizeMcpToolForStorage(incoming[nk]);
    if (!tool) continue;
    var nm = tool.name;
    if (state.mcpTools[nm]) {
      if (conflictMode === 'overwrite') {
        state.mcpTools[nm] = tool;
        count++;
      } else if (conflictMode === 'rename') {
        var baseNm = nm + '_imported';
        var uniq = baseNm;
        var z = 0;
        while (state.mcpTools[uniq]) {
          z++;
          uniq = baseNm + '_' + z;
        }
        var copyTool = sanitizeMcpToolForStorage(tool);
        copyTool.name = uniq;
        state.mcpTools[uniq] = copyTool;
        count++;
      }
    } else {
      state.mcpTools[nm] = tool;
      count++;
    }
  }
  return { ok: true, imported: count };
}

function pickGeneratorForRequests() {
  return state.mcpUseEnhancedGeneration ? generateMcpToolsFromRecordsEnhanced : generateMcpToolsFromRecords;
}

function collectFlowVerifiedRecords(flow) {
  var verifiedIds = (flow && flow.verifiedRequestIds) || [];
  var records = [];
  for (var i = 0; i < verifiedIds.length; i++) {
    var req = typeof findRequestById === 'function' ? findRequestById(verifiedIds[i]) : null;
    if (!req) continue;
    var cls = (flow.classifications && flow.classifications[verifiedIds[i]]) || 'unknown';
    if (cls === 'noise') continue;
    records.push(req);
  }
  return records;
}

function findFlowStepForRequest(flow, reqId) {
  var steps = (flow && flow.steps) || [];
  for (var i = 0; i < steps.length; i++) {
    if ((steps[i].requestIds || []).indexOf(reqId) !== -1) return steps[i];
  }
  return null;
}

function findFlowRequestIdsForTool(flow, tool) {
  var method = tool && tool._meta ? (tool._meta.method || '').toUpperCase() : '';
  var pathname = tool && tool._meta ? (tool._meta.pathname || '') : '';
  var pathPatternKey = tool && tool._meta ? (tool._meta.pathPatternKey || '') : '';
  var ids = (flow && flow.verifiedRequestIds) || [];
  var matched = [];
  for (var i = 0; i < ids.length; i++) {
    var req = typeof findRequestById === 'function' ? findRequestById(ids[i]) : null;
    if (!req) continue;
    var reqMethod = (req.method || 'GET').toUpperCase();
    var reqPath = normalizePathnameFromRecordUrl(req.originalUrl || req.url || '');
    if (reqMethod !== method) continue;
    if (reqPath === pathname) {
      matched.push(ids[i]);
      continue;
    }
    if (pathPatternKey) {
      var reqPatternKey = buildRecordPathPatternKey(reqMethod, reqPath);
      if (reqPatternKey === pathPatternKey) matched.push(ids[i]);
    }
  }
  return matched;
}

function stripFlowTagFromDescription(tool) {
  if (!tool) return;
  var d = tool.description || '';
  if (d.indexOf('[流程:') !== 0) return;
  var end = d.indexOf('] ');
  if (end >= 0) tool.description = d.substring(end + 2);
  else tool.description = d.replace(/^\[流程:[^\]]*\]\s*/, '');
}

function applyFlowTagToToolDescription(tool, flowName) {
  if (!tool || !flowName) return;
  stripFlowTagFromDescription(tool);
  var flowTag = '[流程: ' + flowName + '] ';
  tool.description = flowTag + (tool.description || '');
}

function annotateFlowMetaOnTool(tool, flow) {
  if (!tool || !flow) return tool;
  if (!tool._meta) tool._meta = {};
  var matchedIds = findFlowRequestIdsForTool(flow, tool);
  var steps = [];
  for (var i = 0; i < matchedIds.length; i++) {
    var step = findFlowStepForRequest(flow, matchedIds[i]);
    if (!step) continue;
    steps.push({
      stepId: step.id,
      stepIndex: step.index,
      stepTitle: step.title,
      requestId: matchedIds[i],
      classification: (flow.classifications && flow.classifications[matchedIds[i]]) || 'unknown'
    });
  }
  tool._meta.flow = {
    flowId: flow.id,
    flowName: flow.name,
    hostname: flow.hostname || location.hostname,
    verifiedRequestIds: matchedIds,
    steps: steps
  };
  tool._meta.verifiedByFlow = true;
  tool._meta.aiVisible = true;
  if (flow.name) {
    applyFlowTagToToolDescription(tool, flow.name);
  }
  tool._meta.usability = tool._meta.usability || {
    verified: true,
    tested: false,
    lastTestAt: null,
    lastError: ''
  };
  return tool;
}

function generateMcpToolsFromFlow(flow) {
  if (!flow) return { added: 0, skipped: 0, linked: 0 };
  var records = collectFlowVerifiedRecords(flow);
  if (records.length === 0) return { added: 0, skipped: 0, linked: 0 };
  var generator = typeof pickGeneratorForRequests === 'function' ? pickGeneratorForRequests() : generateMcpToolsFromRecords;
  var tools = generator(records);
  for (var i = 0; i < tools.length; i++) {
    annotateFlowMetaOnTool(tools[i], flow);
  }
  var mcpMap = state.mcpTools || (state.mcpTools = {});
  var stats = mergeGeneratedMcpToolsIntoState(tools);
  if (!flow.mcpToolNames) flow.mcpToolNames = [];
  var linked = 0;
  for (var j = 0; j < tools.length; j++) {
    var t = tools[j];
    var resolvedName = findExistingMcpToolNameByConflictKey(t, mcpMap) || (mcpMap[t.name] ? t.name : null);
    if (!resolvedName || !mcpMap[resolvedName]) continue;
    annotateFlowMetaOnTool(mcpMap[resolvedName], flow);
    if (flow.mcpToolNames.indexOf(resolvedName) === -1) {
      flow.mcpToolNames.push(resolvedName);
      linked++;
    }
  }
  if (tools.length > 0) {
    saveMcpTools();
    saveFlows();
    try { chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' }); } catch (e) {}
  }
  stats.linked = linked;
  return stats;
}

var MCP_TOOLS_KEY_PREFIX = 'ai_req_mcp_tools_';

function loadToolsObjectForHostname(hostname) {
  var key = MCP_TOOLS_KEY_PREFIX + hostname;
  try {
    var saved = storageGet(key, null);
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return {};
}

function persistToolsObjectForHostname(hostname, toolsObj) {
  var key = MCP_TOOLS_KEY_PREFIX + hostname;
  var sanitizedTools = sanitizeMcpToolsForStorage(toolsObj);
  storageSet(key, JSON.stringify(sanitizedTools));
  if (hostname === location.hostname) {
    state.mcpTools = sanitizedTools;
  }
}

function deleteMcpToolFromHost(hostname, toolName) {
  var toolsObj = loadToolsObjectForHostname(hostname);
  if (!toolsObj || !Object.prototype.hasOwnProperty.call(toolsObj, toolName)) return false;
  delete toolsObj[toolName];
  if (state.selectedMcpToolNames && state.selectedMcpToolNames[toolName]) {
    delete state.selectedMcpToolNames[toolName];
  }
  persistToolsObjectForHostname(hostname, toolsObj);
  return true;
}

function setMcpToolEnabledOnHost(hostname, toolName, enabled) {
  var toolsObj = loadToolsObjectForHostname(hostname);
  if (!toolsObj[toolName]) return false;
  toolsObj[toolName].enabled = enabled;
  persistToolsObjectForHostname(hostname, toolsObj);
  return true;
}

function updateMcpToolUsability(toolName, patch, hostname) {
  var targetHost = hostname || location.hostname;
  var toolsObj = loadToolsObjectForHostname(targetHost);
  if (!toolsObj[toolName] && targetHost === location.hostname && state.mcpTools && state.mcpTools[toolName]) {
    toolsObj = state.mcpTools;
  }
  if (!toolsObj[toolName]) return false;
  var tool = toolsObj[toolName];
  if (!tool._meta) tool._meta = {};
  var current = tool._meta.usability || {};
  tool._meta.usability = Object.assign({}, current, patch || {});
  persistToolsObjectForHostname(targetHost, toolsObj);
  return true;
}

function saveMcpTools() {
  var key = MCP_TOOLS_KEY_PREFIX + location.hostname;
  state.mcpTools = sanitizeMcpToolsForStorage(state.mcpTools);
  storageSet(key, JSON.stringify(state.mcpTools));
}

function loadMcpTools() {
  try {
    var key = MCP_TOOLS_KEY_PREFIX + location.hostname;
    var saved = storageGet(key, null);
    if (saved) {
      state.mcpTools = JSON.parse(saved);
    }
  } catch (e) {}
}

function deleteMcpTool(toolName) {
  deleteMcpToolFromHost(location.hostname, toolName);
}

function buildMcpProxyFetchHeaders(
  method,
  url,
  rawHeaders,
  authBundle,
  operationClass
) {
  var parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_urlError) {
    return { ok: false, errorCode: 'AUTH_SOURCE_UNSAFE' };
  }
  var bundle = authBundle && typeof authBundle === 'object'
    ? authBundle
    : {};
  if (
    (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
    !bundle.origin ||
    parsedUrl.origin !== bundle.origin
  ) {
    return { ok: false, errorCode: 'AUTH_SOURCE_UNSAFE' };
  }
  var claimedClass = operationClass === 'read'
    ? 'read'
    : 'write_sensitive';
  var actualClass = AiRuntimeAuth.classifyOperation({
    method: String(method || 'GET').toUpperCase(),
    pathname: parsedUrl.pathname,
    operationClass: claimedClass,
    isReadOnly: claimedClass === 'read'
  });
  if (actualClass !== claimedClass) {
    return { ok: false, errorCode: 'AUTH_SOURCE_UNSAFE' };
  }
  return AiRuntimeAuth.mergeAndValidateHeaders(
    rawHeaders || {},
    actualClass,
    bundle
  );
}

function handleMcpProxyRequest(payload, sendResponse) {
  var url = payload.url;
  var method = (payload.method || 'GET').toUpperCase();
  var headers = payload.headers || {};
  var body = payload.body;
  var timeout = payload.timeout || 30000;
  var callId = payload.callId;
  var headerResolution = buildMcpProxyFetchHeaders(
    method,
    url,
    headers,
    payload.authBundle,
    payload.operationClass
  );
  if (!headerResolution.ok) {
    sendResponse({
      ok: false,
      callId: callId,
      status: 0,
      headers: {},
      body: null,
      errorCode: headerResolution.errorCode || 'AUTH_SOURCE_UNSAFE',
      error: headerResolution.errorCode || 'AUTH_SOURCE_UNSAFE',
      proxyMode: 'tab'
    });
    return;
  }

  var controller;
  try {
    controller = new AbortController();
  } catch (e) {
    sendResponse({
      ok: false,
      callId: callId,
      status: 0,
      headers: {},
      body: null,
      error: '请求初始化失败',
      proxyMode: 'tab'
    });
    return;
  }

  var timeoutId = setTimeout(function () {
    try { controller.abort(); } catch (e) {}
  }, timeout);

  var fetchOpts = {
    method: method,
    headers: headerResolution.headers,
    signal: controller.signal,
    credentials: 'include',
    redirect: 'manual'
  };

  if (method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null) {
    fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  fetch(url, fetchOpts).then(function (response) {
    clearTimeout(timeoutId);
    var respHeaders = {};
    try {
      response.headers.forEach(function (v, k) { respHeaders[k] = v; });
    } catch (e) {}

    var contentType = '';
    try {
      contentType = (response.headers.get('content-type') || '').toLowerCase();
    } catch (e) {}

    if (contentType.indexOf('application/json') !== -1) {
      return response.json().then(function (parsedBody) {
        sendResponse({
          ok: true,
          callId: callId,
          status: response.status,
          headers: respHeaders,
          body: parsedBody,
          error: null,
          proxyMode: 'tab'
        });
      });
    } else {
      return response.text().then(function (textBody) {
        var parsedBody = tryParseJson(textBody);
        sendResponse({
          ok: true,
          callId: callId,
          status: response.status,
          headers: respHeaders,
          body: parsedBody,
          error: null,
          proxyMode: 'tab'
        });
      });
    }
  }).catch(function (err) {
    clearTimeout(timeoutId);
    var errMsg = '请求失败';
    if (err && err.name === 'AbortError') {
      errMsg = '请求超时';
    } else if (err && err.message) {
      errMsg = '请求失败: ' + String(err.message).substring(0, 240);
    }
    sendResponse({
      ok: false,
      callId: callId,
      status: 0,
      headers: {},
      body: null,
      error: errMsg,
      proxyMode: 'tab'
    });
  });
}
