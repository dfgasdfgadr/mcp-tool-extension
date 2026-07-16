'use strict';

var FLOW_CONTEXT_LIST_TOOL = 'list_recorded_flows';
var FLOW_CONTEXT_DETAIL_TOOL = 'get_recorded_flow_context';
var BRAINSTORM_MCP_TOOL = 'brainstorm_mcp_tool';
var FLOW_CONTEXT_FLOWS_PREFIX = 'ai_req_flows_';
var FLOW_CONTEXT_TOOLS_PREFIX = 'ai_req_mcp_tools_';
var SITE_IDENTITY_PREFIX = 'ai_req_site_identity_';
var SITE_IDENTITY_ORIGIN_PREFIX = 'ai_req_site_identity_origin_';
var FLOW_CONTEXT_CONFIG_KEY = 'ai_req_analyzer_config';
var FLOW_CONTEXT_GUIDANCE =
  '步骤仅用于理解业务语境，不要求按顺序执行。请根据用户目标选择最相关的工具。' +
  '不要仅因为参考步骤出现写操作就自动调用写工具，必须以用户当前明确目标为准。';

function isFlowContextSystemTool(toolName) {
  return toolName === FLOW_CONTEXT_LIST_TOOL ||
    toolName === FLOW_CONTEXT_DETAIL_TOOL ||
    toolName === BRAINSTORM_MCP_TOOL;
}

function parseExtensionConfigFromItems(items) {
  var cfg = {
    enableFlowContextListTool: true,
    enableFlowContextDetailTool: true,
    enableBrainstormMcpTool: true
  };
  try {
    var raw = items && items[FLOW_CONTEXT_CONFIG_KEY];
    if (!raw) return cfg;
    var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') {
      if (parsed.enableFlowContextListTool === false) cfg.enableFlowContextListTool = false;
      if (parsed.enableFlowContextDetailTool === false) cfg.enableFlowContextDetailTool = false;
      if (parsed.enableBrainstormMcpTool === false) cfg.enableBrainstormMcpTool = false;
    }
  } catch (e) {}
  return cfg;
}

function buildFlowContextSystemToolDefinitions(config) {
  var defs = {};
  if (config.enableFlowContextListTool !== false) {
    defs[FLOW_CONTEXT_LIST_TOOL] = {
      name: FLOW_CONTEXT_LIST_TOOL,
      description:
        '列出当前已录制的业务流程及其关联 MCP 工具数量。' +
        '当用户未明确流程名，或需要查看有哪些流程可用时调用。',
      inputSchema: { type: 'object', properties: {} },
      enabled: true,
      _meta: { flowContextSystem: true, kind: 'list_flows' }
    };
  }
  if (config.enableFlowContextDetailTool !== false) {
    defs[FLOW_CONTEXT_DETAIL_TOOL] = {
      name: FLOW_CONTEXT_DETAIL_TOOL,
      description:
        '根据录制流程名称或 ID 查询该流程相关的 MCP 工具集、参考步骤和使用建议。' +
        '当用户说“使用/按照/基于 XXX 流程”或提到某个已录制业务流程时，应先调用本工具获取上下文。' +
        '返回的步骤仅用于理解业务语境，不要求按顺序执行。',
      inputSchema: {
        type: 'object',
        properties: {
          flowName: { type: 'string', description: '录制流程名称' },
          flowId: { type: 'string', description: '录制流程 ID，优先于 flowName' }
        }
      },
      enabled: true,
      _meta: { flowContextSystem: true, kind: 'flow_context' }
    };
  }
  if (config.enableBrainstormMcpTool !== false) {
    defs[BRAINSTORM_MCP_TOOL] = {
      name: BRAINSTORM_MCP_TOOL,
      description:
        '根据自然语言需求生成 MCP 工具草案（JSON）。' +
        '首次调用传 intent，返回 draftJson 与命名/校验规则；用户明确确认后，再次调用并传 confirmCreate=true、targetHost、完整 draftJson 或 drafts[] 以创建工具。' +
        '未获用户确认前不要传 confirmCreate=true。',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: '自然语言需求，草案阶段必填' },
          targetHost: { type: 'string', description: '目标站点 hostname，创建阶段必填' },
          preferredRiskLevel: {
            type: 'string',
            description: '风险等级偏好：low、medium 或 high'
          },
          confirmCreate: { type: 'boolean', description: 'true 时在用户确认后创建工具' },
          draftJson: {
            type: 'object',
            description: '完整 MCP 草案对象；创建单个工具时必填'
          },
          drafts: {
            type: 'array',
            description: '完整 MCP 草案数组；创建多个工具时使用，按部分成功策略处理',
            items: { type: 'object' }
          }
        }
      },
      enabled: true,
      _meta: { flowContextSystem: true, kind: 'brainstorm_mcp_tool' }
    };
  }
  return defs;
}

function appendFlowContextSystemTools(toolsObj, config) {
  var defs = buildFlowContextSystemToolDefinitions(config || {});
  var keys = Object.keys(defs);
  for (var i = 0; i < keys.length; i++) {
    toolsObj[keys[i]] = defs[keys[i]];
  }
  return toolsObj;
}

function parseStoredJsonObject(raw) {
  if (!raw) return null;
  try {
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch (e) {}
  return null;
}

function buildRecordedFlowDataset(items) {
  var flowsByHost = {};
  var toolsByHost = {};
  var allFlows = [];
  var storageKeys = Object.keys(items || {});
  var ki;
  for (ki = 0; ki < storageKeys.length; ki++) {
    var key = storageKeys[ki];
    if (key.indexOf(FLOW_CONTEXT_FLOWS_PREFIX) === 0) {
      var flowHost = key.substring(FLOW_CONTEXT_FLOWS_PREFIX.length);
      var flowsObj = parseStoredJsonObject(items[key]);
      if (!flowsObj || typeof flowsObj !== 'object') continue;
      flowsByHost[flowHost] = flowsObj;
      var fk = Object.keys(flowsObj);
      for (var fi = 0; fi < fk.length; fi++) {
        var f = flowsObj[fk[fi]];
        if (!f || !f.id) continue;
        allFlows.push({ hostname: flowHost, flow: f });
      }
      continue;
    }
    if (key.indexOf(FLOW_CONTEXT_TOOLS_PREFIX) === 0) {
      var toolHost = key.substring(FLOW_CONTEXT_TOOLS_PREFIX.length);
      var toolsObj = parseStoredJsonObject(items[key]);
      if (toolsObj && typeof toolsObj === 'object') {
        toolsByHost[toolHost] = toolsObj;
      }
    }
  }
  return {
    flowsByHost: flowsByHost,
    toolsByHost: toolsByHost,
    allFlows: allFlows
  };
}

function normalizeFlowNameText(name) {
  return String(name || '').trim().toLowerCase();
}

function inferFlowKind(flow) {
  if (!flow) return 'manual';
  if (flow.kind === 'manual' || flow.kind === 'recorded') return flow.kind;
  if ((flow.steps && flow.steps.length) || (flow.verifiedRequestIds && flow.verifiedRequestIds.length)) {
    return 'recorded';
  }
  return 'manual';
}

function lookupToolDefAcrossHosts(toolName, toolsByHost, meta) {
  var th = meta && meta.toolHost;
  if (th && toolsByHost && toolsByHost[th] && toolsByHost[th][toolName]) {
    return { def: toolsByHost[th][toolName], toolHost: th };
  }
  if (meta && meta.flow && meta.flow.toolHost && toolsByHost && toolsByHost[meta.flow.toolHost]) {
    var viaMeta = toolsByHost[meta.flow.toolHost][toolName];
    if (viaMeta) return { def: viaMeta, toolHost: meta.flow.toolHost };
  }
  if (!toolsByHost) return { def: null, toolHost: th || null };
  var host;
  for (host in toolsByHost) {
    if (!Object.prototype.hasOwnProperty.call(toolsByHost, host)) continue;
    if (toolsByHost[host][toolName]) {
      return { def: toolsByHost[host][toolName], toolHost: host };
    }
  }
  return { def: null, toolHost: th || null };
}

function countFlowTools(flow, toolsObj, toolsByHost) {
  var names = (flow && flow.mcpToolNames) || [];
  var isCross = flow && flow.hostname === '*';
  if (isCross && toolsByHost) {
    var n = 0;
    for (var i = 0; i < names.length; i++) {
      if (lookupToolDefAcrossHosts(names[i], toolsByHost, null).def) n++;
    }
    return n;
  }
  var n2 = 0;
  for (var j = 0; j < names.length; j++) {
    if (toolsObj && toolsObj[names[j]]) n2++;
  }
  return n2;
}

function handleListRecordedFlows(dataset) {
  var list = (dataset && dataset.allFlows) || [];
  list.sort(function (a, b) {
    var ta = (a.flow.endedAt || a.flow.startedAt || 0);
    var tb = (b.flow.endedAt || b.flow.startedAt || 0);
    return tb - ta;
  });
  var flows = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var flow = entry.flow;
    var isCross = entry.hostname === '*';
    var toolsObj = isCross ? null : ((dataset.toolsByHost && dataset.toolsByHost[entry.hostname]) || {});
    var kind = inferFlowKind(flow);
    var summary = kind === 'manual'
      ? (isCross ? '跨站点手动工具分组' : '手动工具分组')
      : ((flow.name || flow.id) + ' 相关流程');
    flows.push({
      id: flow.id,
      name: flow.name || flow.id,
      hostname: entry.hostname,
      kind: kind,
      toolCount: ((flow.mcpToolNames || []).length),
      linkedToolCount: countFlowTools(flow, toolsObj, dataset.toolsByHost),
      stepCount: (flow.steps || []).length,
      updatedAt: flow.endedAt || flow.startedAt || 0,
      summary: summary
    });
  }
  if (flows.length === 0) {
    return {
      ok: true,
      flows: [],
      message: '暂无已录制流程。请先在扩展 Flow 页录制并生成 MCP 工具。'
    };
  }
  return { ok: true, flows: flows };
}

function findFlowsByQuery(dataset, flowId, flowName) {
  var idTrim = String(flowId || '').trim();
  if (idTrim) {
    var exact = [];
    var list = dataset.allFlows || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].flow.id === idTrim) exact.push(list[i]);
    }
    return { mode: 'id', matches: exact };
  }
  var nameTrim = String(flowName || '').trim();
  if (!nameTrim) {
    return { mode: 'none', matches: [] };
  }
  var norm = normalizeFlowNameText(nameTrim);
  var exactName = [];
  var partial = [];
  for (var j = 0; j < (dataset.allFlows || []).length; j++) {
    var item = dataset.allFlows[j];
    var fn = normalizeFlowNameText(item.flow.name || '');
    if (fn === norm) exactName.push(item);
    else if (fn.indexOf(norm) >= 0 || norm.indexOf(fn) >= 0) partial.push(item);
  }
  if (exactName.length) return { mode: 'exact', matches: exactName };
  return { mode: 'partial', matches: partial };
}

function extractStepRefsFromToolMeta(meta) {
  var refs = [];
  var steps = (meta && meta.flow && meta.flow.steps) || [];
  for (var i = 0; i < steps.length; i++) {
    var idx = steps[i].stepIndex;
    if (typeof idx === 'number' && refs.indexOf(idx) < 0) refs.push(idx);
  }
  refs.sort(function (a, b) { return a - b; });
  return refs;
}

function buildFlowToolEntry(toolName, toolDef, toolHost) {
  if (!toolDef) {
    return {
      name: toolName,
      status: 'missing',
      warning: '该工具已被删除或未同步。'
    };
  }
  var meta = toolDef._meta || {};
  var required = (toolDef.inputSchema && toolDef.inputSchema.required) || [];
  var status = 'available';
  var warning = '';
  if (toolDef.enabled === false) {
    status = 'disabled';
    warning = '该工具当前未暴露给 MCP 客户端。';
  }
  var entry = {
    name: toolName,
    description: toolDef.description || '',
    method: (meta.method || 'GET').toUpperCase(),
    path: meta.pathname || '',
    riskLevel: meta.riskLevel || 'low',
    enabled: toolDef.enabled !== false,
    required: required.slice(),
    stepRefs: extractStepRefsFromToolMeta(meta),
    status: status
  };
  var th = toolHost || (meta.flow && meta.flow.toolHost) || null;
  if (th) entry.toolHost = th;
  if (warning) entry.warning = warning;
  return entry;
}

function buildReferenceSteps(flow, toolsObj, allToolsByHost) {
  var steps = (flow && flow.steps) || [];
  var toolNames = (flow && flow.mcpToolNames) || [];
  var isCross = flow && flow.hostname === '*';
  var out = [];
  for (var si = 0; si < steps.length; si++) {
    var step = steps[si];
    var stepToolNames = [];
    for (var ti = 0; ti < toolNames.length; ti++) {
      var tn = toolNames[ti];
      var toolDef = null;
      if (isCross && allToolsByHost) {
        toolDef = lookupToolDefAcrossHosts(tn, allToolsByHost, null).def;
      } else {
        toolDef = toolsObj[tn];
      }
      if (!toolDef) continue;
      var refs = extractStepRefsFromToolMeta(toolDef._meta || {});
      if (refs.indexOf(step.index) >= 0 && stepToolNames.indexOf(tn) < 0) {
        stepToolNames.push(tn);
      }
    }
    out.push({
      index: step.index,
      title: step.title || ('步骤 ' + step.index),
      toolNames: stepToolNames
    });
  }
  return out;
}

function assembleFlowContext(entry, toolsObj, allToolsByHost) {
  var flow = entry.flow;
  var kind = inferFlowKind(flow);
  var isCross = entry.hostname === '*' || (flow && flow.hostname === '*');
  var toolNames = (flow.mcpToolNames || []).slice();
  var tools = [];
  var warnings = [];
  for (var i = 0; i < toolNames.length; i++) {
    var tn = toolNames[i];
    var toolDef = null;
    var toolHost = null;
    if (isCross && allToolsByHost) {
      var hit = lookupToolDefAcrossHosts(tn, allToolsByHost, null);
      toolDef = hit.def;
      toolHost = hit.toolHost;
      if (toolDef && toolDef._meta && toolDef._meta.flow && toolDef._meta.flow.toolHost) {
        toolHost = toolDef._meta.flow.toolHost;
      }
    } else {
      toolDef = toolsObj && toolsObj[tn];
      toolHost = entry.hostname;
    }
    tools.push(buildFlowToolEntry(tn, toolDef, toolHost));
  }
  if (toolNames.length === 0) {
    warnings.push('该流程尚未生成 MCP 工具，AI 只能参考步骤，不能直接调用相关接口。');
  }
  var guidance = FLOW_CONTEXT_GUIDANCE + ' 工具列表按推荐调用顺序排列，请优先按序使用。';
  if (kind === 'manual') {
    guidance += isCross ? ' 此流程为跨站点手动工具分组，无录制步骤。' : ' 此流程为手动工具分组，无录制步骤。';
  }
  var summary = kind === 'manual'
    ? (isCross ? '跨站点手动工具分组' : '手动工具分组')
    : ((flow.name || '未命名流程') + ' 相关流程');
  return {
    schemaVersion: 1,
    id: flow.id,
    name: flow.name || flow.id,
    hostname: entry.hostname,
    kind: kind,
    summary: summary,
    tools: tools,
    referenceSteps: kind === 'manual' ? [] : buildReferenceSteps(flow, toolsObj, allToolsByHost),
    guidance: guidance,
    warnings: warnings.length ? warnings : undefined
  };
}

function handleGetRecordedFlowContext(dataset, toolArguments) {
  var args = toolArguments || {};
  var query = findFlowsByQuery(dataset, args.flowId, args.flowName);
  if (query.mode === 'none') {
    return {
      ok: false,
      errorCode: 'INVALID_FLOW_CONTEXT_ARGS',
      message: '请提供 flowName 或 flowId。'
    };
  }
  if (!query.matches.length) {
    return {
      ok: false,
      errorCode: 'FLOW_NOT_FOUND',
      message: '未找到匹配的录制流程。'
    };
  }
  if (query.matches.length > 1) {
    var candidates = [];
    for (var ci = 0; ci < query.matches.length; ci++) {
      candidates.push({
        id: query.matches[ci].flow.id,
        name: query.matches[ci].flow.name || query.matches[ci].flow.id,
        hostname: query.matches[ci].hostname
      });
    }
    return {
      ok: false,
      errorCode: 'AMBIGUOUS_FLOW_NAME',
      message: '找到多个名称相近的流程，请指定 flowId。',
      candidates: candidates
    };
  }
  var hit = query.matches[0];
  var isCross = hit.hostname === '*';
  var hostTools = isCross ? null : ((dataset.toolsByHost && dataset.toolsByHost[hit.hostname]) || {});
  return {
    ok: true,
    flow: assembleFlowContext(hit, hostTools, isCross ? dataset.toolsByHost : null)
  };
}

var BRAINSTORM_TOOL_NAME_RE = /^[a-zA-Z0-9_]+$/;
var BRAINSTORM_RISK_LEVELS = { low: true, medium: true, high: true };

function getFlowContextSystemToolNames(config) {
  return Object.keys(buildFlowContextSystemToolDefinitions(config || {}));
}

function buildBrainstormError(errorCode, message) {
  return { ok: false, errorCode: errorCode, message: message };
}

function isValidBrainstormToolName(name) {
  return typeof name === 'string' && name.length > 0 && BRAINSTORM_TOOL_NAME_RE.test(name);
}

function validateBrainstormDraftJson(draftJson) {
  if (!draftJson || typeof draftJson !== 'object' || Array.isArray(draftJson)) {
    return buildBrainstormError('DRAFT_REQUIRED', 'draftJson 必须是对象。');
  }
  if (!isValidBrainstormToolName(draftJson.name)) {
    return buildBrainstormError('INVALID_TOOL_NAME', '工具名只能包含字母、数字和下划线，且不能为空。');
  }
  var schema = draftJson.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    return buildBrainstormError('INVALID_INPUT_SCHEMA', 'inputSchema.type 必须是 object。');
  }
  var risk = draftJson.riskLevel || 'low';
  if (!BRAINSTORM_RISK_LEVELS[risk]) {
    return buildBrainstormError('INVALID_RISK_LEVEL', 'riskLevel 只能是 low、medium 或 high。');
  }
  return { ok: true, draft: draftJson, riskLevel: risk };
}

function normalizeBrainstormDrafts(toolArguments) {
  var args = toolArguments || {};
  if (Array.isArray(args.drafts)) {
    if (args.drafts.length === 0) {
      return buildBrainstormError('DRAFT_REQUIRED', 'drafts 至少需要包含一个草案。');
    }
    return { ok: true, drafts: args.drafts, batch: true };
  }
  if (!args.draftJson) {
    return buildBrainstormError('DRAFT_REQUIRED', '创建阶段必须提供完整 draftJson 或 drafts。');
  }
  return { ok: true, drafts: [args.draftJson], batch: false };
}

function buildBrainstormMcpDraftProtocol(toolArguments) {
  var args = toolArguments || {};
  var intent = args.intent;
  if (!intent || typeof intent !== 'string' || !intent.trim()) {
    return buildBrainstormError('INTENT_REQUIRED', '草案阶段必须提供 intent。');
  }
  var preferredRisk = args.preferredRiskLevel || 'low';
  if (!BRAINSTORM_RISK_LEVELS[preferredRisk]) {
    preferredRisk = 'low';
  }
  return {
    ok: true,
    mode: 'draft',
    intent: intent.trim(),
    targetHostHint: args.targetHost ? String(args.targetHost) : '',
    draftJson: {
      name: '',
      description: '',
      inputSchema: { type: 'object', properties: {}, required: [] },
      riskLevel: preferredRisk,
      implementationNotes: '',
      questions: []
    },
    drafts: [],
    namingRules: [
      'name 只能包含 a-z、A-Z、0-9 和下划线',
      '建议用动词开头，例如 get_product_list'
    ],
    schemaRules: [
      'inputSchema.type 必须是 object',
      'properties 只描述用户需要填写的参数',
      'required 只包含真正必填字段'
    ],
    riskRules: [
      '只读查询默认 low',
      '修改、提交、删除类操作至少 medium',
      '支付、审批、批量删除等高影响操作为 high'
    ],
    validationRules: [
      '创建前必须获得用户明确确认',
      '创建前必须提供 targetHost',
      '创建前必须检查同名冲突',
      '批量创建可传 drafts[]；有效项会创建，失败项会逐条返回错误'
    ],
    nextStep:
      '请根据 intent 填充 draftJson 或 drafts[]，展示给用户确认；用户确认后再以 confirmCreate=true 调用本工具。'
  };
}

function parseHostToolsFromItems(items, targetHost) {
  var key = FLOW_CONTEXT_TOOLS_PREFIX + targetHost;
  var raw = items && items[key];
  if (!raw) return {};
  try {
    var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function normalizeSiteIdentityOrigin(apiOrigin) {
  try {
    var parsed = new URL(apiOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.hostname || parsed.origin === 'null') return '';
    return parsed.origin;
  } catch (e) {
    return '';
  }
}

function siteIdentityStorageKey(apiOrigin) {
  var normalizedOrigin = normalizeSiteIdentityOrigin(apiOrigin);
  return normalizedOrigin
    ? SITE_IDENTITY_ORIGIN_PREFIX + encodeURIComponent(normalizedOrigin)
    : '';
}

function legacySiteIdentityStorageKey(apiOrigin) {
  try {
    var normalizedOrigin = normalizeSiteIdentityOrigin(apiOrigin);
    return normalizedOrigin
      ? SITE_IDENTITY_PREFIX + new URL(normalizedOrigin).hostname
      : '';
  } catch (e) {
    return '';
  }
}

function normalizeAuthHeaderNames(names) {
  var normalized = [];
  if (!Array.isArray(names)) return normalized;
  for (var i = 0; i < names.length; i++) {
    if (typeof names[i] !== 'string') continue;
    var name = names[i].trim().toLowerCase();
    if (name && normalized.indexOf(name) < 0) normalized.push(name);
  }
  return normalized;
}

function recordedApiOriginsForToolMeta(identity, toolMeta) {
  var fromIdentity = (identity.recordedApiOrigins || []).slice();
  if (fromIdentity.length) return fromIdentity;
  var fromTool = toolMeta && Array.isArray(toolMeta.recordedApiOrigins)
    ? toolMeta.recordedApiOrigins.filter(function (origin) {
      return typeof origin === 'string';
    }).slice()
    : [];
  if (fromTool.length) return fromTool;
  return identity.apiOrigin ? [identity.apiOrigin] : [];
}

function sanitizeSiteIdentityRecord(record, apiOrigin) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  var normalizedOrigin = normalizeSiteIdentityOrigin(apiOrigin);
  if (!normalizedOrigin) return null;
  var url = new URL(normalizedOrigin);
  var apiHostname = url.hostname;
  var recordedApiOrigins = Array.isArray(record.recordedApiOrigins)
    ? record.recordedApiOrigins.filter(function (origin) {
      return typeof origin === 'string';
    }).slice()
    : [];
  if (!recordedApiOrigins.length && normalizedOrigin) {
    recordedApiOrigins = [normalizedOrigin];
  }
  var siteRoot = typeof record.siteRoot === 'string' ? record.siteRoot : '';
  if (!siteRoot && apiHostname && typeof AiSiteAffinity !== 'undefined') {
    siteRoot = AiSiteAffinity.deriveSiteRoot(apiHostname) || '';
  }
  return {
    apiOrigin: normalizedOrigin,
    apiHostname: apiHostname,
    detectedAuthType: typeof record.detectedAuthType === 'string'
      ? record.detectedAuthType
      : 'none',
    authHeaderNames: normalizeAuthHeaderNames(record.authHeaderNames),
    sessionEpoch: Number(record.sessionEpoch || 0),
    updatedAt: Number(record.updatedAt || 0),
    pageOrigins: Array.isArray(record.pageOrigins)
      ? record.pageOrigins.filter(function (origin) {
        return typeof origin === 'string';
      }).slice()
      : [],
    recordedApiOrigins: recordedApiOrigins,
    siteRoot: siteRoot,
    lastPageOrigin: typeof record.lastPageOrigin === 'string'
      ? record.lastPageOrigin
      : ''
  };
}

function detectAuthTypeFromHeaders(headers) {
  return AiRuntimeAuth.describeAuthHeaders(headers || {}).detectedAuthType;
}

function parseSiteIdentityFromItems(items, apiOrigin) {
  if (!items || !normalizeSiteIdentityOrigin(apiOrigin)) return null;
  var current = parseStoredJsonObject(items[siteIdentityStorageKey(apiOrigin)]);
  var sanitizedCurrent = sanitizeSiteIdentityRecord(current, apiOrigin);
  if (sanitizedCurrent) return sanitizedCurrent;
  var legacyKey = legacySiteIdentityStorageKey(apiOrigin);
  if (!legacyKey) return null;
  var legacy = parseStoredJsonObject(items[legacyKey]);
  return sanitizeSiteIdentityRecord(legacy, apiOrigin);
}

function mergeSiteIdentityRecord(existing, apiOrigin, pageOrigin, requestHeaders) {
  var normalizedOrigin = normalizeSiteIdentityOrigin(apiOrigin);
  var prev = sanitizeSiteIdentityRecord(existing, normalizedOrigin) || {};
  var pageOrigins = Array.isArray(prev.pageOrigins) ? prev.pageOrigins.slice() : [];
  if (pageOrigin && pageOrigins.indexOf(pageOrigin) < 0) pageOrigins.push(pageOrigin);
  var authHint = AiRuntimeAuth.describeAuthHeaders(requestHeaders || {});
  var observedNames = normalizeAuthHeaderNames(authHint.authHeaderNames);
  var hasObservedAuth = authHint.detectedAuthType !== 'none' &&
    observedNames.length > 0;
  var authHeaderNames = hasObservedAuth
    ? observedNames
    : normalizeAuthHeaderNames(prev.authHeaderNames);
  var detectedAuthType = authHint.detectedAuthType !== 'none'
    ? authHint.detectedAuthType
    : (prev.detectedAuthType || 'none');
  var recordedApiOrigins = Array.isArray(prev.recordedApiOrigins)
    ? prev.recordedApiOrigins.slice()
    : [];
  if (normalizedOrigin && recordedApiOrigins.indexOf(normalizedOrigin) < 0) {
    recordedApiOrigins.push(normalizedOrigin);
  }
  var apiHostname = normalizedOrigin ? new URL(normalizedOrigin).hostname : '';
  var siteRoot = (typeof AiSiteAffinity !== 'undefined' && apiHostname)
    ? (AiSiteAffinity.deriveSiteRoot(apiHostname) || prev.siteRoot || '')
    : (prev.siteRoot || '');
  return {
    apiOrigin: normalizedOrigin,
    apiHostname: apiHostname,
    detectedAuthType: detectedAuthType,
    authHeaderNames: authHeaderNames,
    sessionEpoch: Number(prev.sessionEpoch || 0),
    updatedAt: Date.now(),
    pageOrigins: pageOrigins,
    recordedApiOrigins: recordedApiOrigins,
    siteRoot: siteRoot,
    lastPageOrigin: pageOrigin || prev.lastPageOrigin || ''
  };
}

function bindSiteIdentityToToolMeta(meta, items, apiOrigin) {
  if (!meta || !apiOrigin) return meta;
  var identity = parseSiteIdentityFromItems(items, apiOrigin);
  if (!identity) return meta;
  // Auth requirement is tool-local. Site identity may remember bearer/custom
  // from other requests on the same origin and must not upgrade anonymous tools.
  meta.detectedAuthType = meta.detectedAuthType || 'none';
  meta.authHeaderNames = normalizeAuthHeaderNames(meta.authHeaderNames);
  meta.sitePageOrigins = identity.pageOrigins.slice();
  meta.recordedApiOrigins = recordedApiOriginsForToolMeta(identity, meta);
  meta.siteRoot = identity.siteRoot ||
    (typeof AiSiteAffinity !== 'undefined'
      ? AiSiteAffinity.deriveSiteRoot(identity.apiHostname || '')
      : '');
  meta.sessionEpoch = Number(identity.sessionEpoch || 0);
  return meta;
}

function applyLiveSiteIdentityToToolMeta(toolMeta, items, apiOrigin) {
  if (!toolMeta || !apiOrigin) return toolMeta;
  var identity = parseSiteIdentityFromItems(items, apiOrigin);
  if (!identity) return toolMeta;
  var merged = Object.assign({}, toolMeta);
  // Keep the tool's own auth hints; only merge non-sensitive site topology.
  merged.detectedAuthType = toolMeta.detectedAuthType || 'none';
  merged.authHeaderNames = normalizeAuthHeaderNames(toolMeta.authHeaderNames);
  merged.sitePageOrigins = identity.pageOrigins.slice();
  merged.recordedApiOrigins = recordedApiOriginsForToolMeta(identity, toolMeta);
  merged.siteRoot = identity.siteRoot ||
    (typeof AiSiteAffinity !== 'undefined'
      ? AiSiteAffinity.deriveSiteRoot(identity.apiHostname || '')
      : '');
  merged.sessionEpoch = Number(identity.sessionEpoch || 0);
  return merged;
}

function shouldPersistSiteIdentity(apiOrigin, requestHeaders) {
  if (!normalizeSiteIdentityOrigin(apiOrigin) ||
      !requestHeaders ||
      typeof requestHeaders !== 'object') return false;
  if (detectAuthTypeFromHeaders(requestHeaders) !== 'none') return true;
  var keys = Object.keys(requestHeaders);
  for (var i = 0; i < keys.length; i++) {
    if (/^content-type$/i.test(keys[i])) {
      var ct = String(requestHeaders[keys[i]] || '').toLowerCase();
      if (ct.indexOf('application/json') >= 0) return true;
    }
  }
  return false;
}

function getStorageLastErrorMessage() {
  var lastError = chrome.runtime && chrome.runtime.lastError;
  return lastError && lastError.message ? lastError.message : '';
}

function overwriteLegacySiteIdentity(legacyKey, record, cleanupError, callback) {
  var fallbackPayload = {};
  fallbackPayload[legacyKey] = JSON.stringify(record);
  chrome.storage.local.set(fallbackPayload, function () {
    var fallbackError = getStorageLastErrorMessage();
    var error = cleanupError;
    if (fallbackError) error += '; fallback overwrite failed: ' + fallbackError;
    callback(error);
  });
}

function cleanupLegacySiteIdentity(legacyKey, record, callback) {
  var storage = chrome.storage.local;
  if (!storage || typeof storage.remove !== 'function') {
    overwriteLegacySiteIdentity(
      legacyKey,
      record,
      'storage.local.remove unavailable',
      callback
    );
    return;
  }
  storage.remove(legacyKey, function () {
    var removeError = getStorageLastErrorMessage();
    if (!removeError) {
      callback('');
      return;
    }
    overwriteLegacySiteIdentity(
      legacyKey,
      record,
      'legacy identity remove failed: ' + removeError,
      callback
    );
  });
}

function persistSiteIdentityUpdate(apiOrigin, pageOrigin, requestHeaders, callback) {
  var normalizedOrigin = normalizeSiteIdentityOrigin(apiOrigin);
  if (!normalizedOrigin) {
    if (typeof callback === 'function') {
      callback({
        ok: false,
        errorCode: 'INVALID_API_ORIGIN',
        error: 'apiOrigin must use http or https'
      });
    }
    return;
  }
  if (!shouldPersistSiteIdentity(normalizedOrigin, requestHeaders)) {
    if (typeof callback === 'function') callback({ ok: false, skipped: true });
    return;
  }
  var storageKey = siteIdentityStorageKey(normalizedOrigin);
  var legacyKey = legacySiteIdentityStorageKey(normalizedOrigin);
  chrome.storage.local.get([storageKey, legacyKey], function (items) {
    var readError = getStorageLastErrorMessage();
    if (readError) {
      if (typeof callback === 'function') {
        callback({
          ok: false,
          apiOrigin: normalizedOrigin,
          errorCode: 'SITE_IDENTITY_READ_FAILED',
          error: readError
        });
      }
      return;
    }
    var existing = parseSiteIdentityFromItems(items, normalizedOrigin);
    var record = mergeSiteIdentityRecord(
      existing,
      normalizedOrigin,
      pageOrigin,
      requestHeaders
    );
    var payload = {};
    payload[storageKey] = JSON.stringify(record);
    chrome.storage.local.set(payload, function () {
      var writeError = getStorageLastErrorMessage();
      if (writeError) {
        if (typeof callback === 'function') {
          callback({
            ok: false,
            apiOrigin: normalizedOrigin,
            apiHostname: record.apiHostname,
            updatedAt: record.updatedAt,
            error: writeError
          });
        }
        return;
      }
      var hadLegacyIdentity = Object.prototype.hasOwnProperty.call(
        items || {},
        legacyKey
      );
      if (!hadLegacyIdentity) {
        if (typeof callback === 'function') {
          callback({
            ok: true,
            apiOrigin: normalizedOrigin,
            apiHostname: record.apiHostname,
            updatedAt: record.updatedAt,
            error: null
          });
        }
        return;
      }
      cleanupLegacySiteIdentity(legacyKey, record, function (cleanupError) {
        if (typeof callback !== 'function') return;
        callback({
          ok: !cleanupError,
          apiOrigin: normalizedOrigin,
          apiHostname: record.apiHostname,
          updatedAt: record.updatedAt,
          error: cleanupError || null
        });
      });
    });
  });
}

function buildBrainstormMcpToolRecord(draft, targetHost, riskLevel, items) {
  var httpMeta = draft.httpMeta && typeof draft.httpMeta === 'object' ? draft.httpMeta : {};
  var method = draft.method || httpMeta.method || '';
  var pathname = draft.pathname || httpMeta.pathname || '';
  var origin = draft.origin || httpMeta.origin || ('https://' + targetHost);
  var isReadOnly = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD';
  var operationClass = AiRuntimeAuth.classifyOperation({
    method: method,
    operationClass: isReadOnly ? 'read' : 'write_sensitive',
    isReadOnly: isReadOnly,
    pathname: pathname
  });
  var untrustedHeaders = Object.assign(
    {},
    httpMeta.rawRequestHeaders || {},
    draft.rawRequestHeaders || {},
    httpMeta.sampleRequestHeaders || {},
    draft.sampleRequestHeaders || {},
    httpMeta.recordedBusinessHeaders || {},
    draft.recordedBusinessHeaders || {}
  );
  var authHint = AiRuntimeAuth.describeAuthHeaders(untrustedHeaders);
  var recordedBusinessHeaders = AiRuntimeAuth.sanitizeUntrustedHeaders(
    untrustedHeaders,
    operationClass,
    authHint.authHeaderNames
  );
  var meta = {
    source: 'system_brainstorm',
    riskLevel: riskLevel,
    createdAt: Date.now(),
    hostname: targetHost,
    systemCreated: true,
    implementationNotes: draft.implementationNotes || '',
    origin: origin,
    recordedBusinessHeaders: recordedBusinessHeaders,
    authHeaderNames: authHint.authHeaderNames,
    detectedAuthType: authHint.detectedAuthType,
    operationClass: operationClass,
    isReadOnly: isReadOnly
  };
  if (method) meta.method = method;
  if (pathname) meta.pathname = pathname;
  bindSiteIdentityToToolMeta(meta, items, origin);
  return {
    name: draft.name,
    description: draft.description || '',
    inputSchema: draft.inputSchema,
    enabled: true,
    _meta: meta
  };
}

function hasNonSensitiveSiteIdentityHints(identity) {
  if (!identity || typeof identity !== 'object') return false;
  return (
    (identity.detectedAuthType && identity.detectedAuthType !== 'none') ||
    (Array.isArray(identity.authHeaderNames) && identity.authHeaderNames.length > 0) ||
    (Array.isArray(identity.pageOrigins) && identity.pageOrigins.length > 0) ||
    !!identity.lastPageOrigin ||
    Number(identity.sessionEpoch || 0) > 0 ||
    Number(identity.updatedAt || 0) > 0
  );
}

function prepareBrainstormMcpToolCreate(toolArguments, items) {
  var args = toolArguments || {};
  var targetHost = args.targetHost;
  if (!targetHost || typeof targetHost !== 'string' || !targetHost.trim()) {
    return buildBrainstormError('TARGET_HOST_REQUIRED', '创建阶段必须提供 targetHost。');
  }
  targetHost = targetHost.trim();
  var normalized = normalizeBrainstormDrafts(args);
  if (!normalized.ok) return normalized;
  var toolsObj = parseHostToolsFromItems(items, targetHost);
  var createdToolNames = [];
  var failed = [];
  for (var di = 0; di < normalized.drafts.length; di++) {
    var validation = validateBrainstormDraftJson(normalized.drafts[di]);
    if (!validation.ok) {
      failed.push({
        index: di,
        name: normalized.drafts[di] && normalized.drafts[di].name ? String(normalized.drafts[di].name) : '',
        errorCode: validation.errorCode,
        message: validation.message
      });
      continue;
    }
    var draft = validation.draft;
    var riskLevel = validation.riskLevel;
    if (toolsObj[draft.name]) {
      failed.push({
        index: di,
        name: draft.name,
        errorCode: 'TOOL_NAME_CONFLICT',
        message: '目标站点已存在同名工具: ' + draft.name
      });
      continue;
    }
    if (isFlowContextSystemTool(draft.name)) {
      failed.push({
        index: di,
        name: draft.name,
        errorCode: 'TOOL_NAME_CONFLICT',
        message: '不能与系统工具同名: ' + draft.name
      });
      continue;
    }
    toolsObj[draft.name] = buildBrainstormMcpToolRecord(draft, targetHost, riskLevel, items);
    createdToolNames.push(draft.name);
  }
  if (!createdToolNames.length) {
    return {
      ok: false,
      errorCode: normalized.batch ? 'BATCH_CREATE_FAILED' : (failed[0] && failed[0].errorCode) || 'CREATE_TOOL_FAILED',
      message: normalized.batch ? '批量创建失败，没有工具被创建。' : ((failed[0] && failed[0].message) || '创建失败。'),
      createdToolNames: [],
      failed: failed
    };
  }
  toolsObj = AiRuntimeAuth.sanitizeToolsForStorage(toolsObj);
  var firstCreatedTool = toolsObj[createdToolNames[0]];
  var firstCreatedMeta = firstCreatedTool && firstCreatedTool._meta || {};
  var identityOrigin = firstCreatedMeta.origin || ('https://' + targetHost);
  var siteIdentity = parseSiteIdentityFromItems(items, identityOrigin);
  var siteIdentityWarning = '';
  if (!hasNonSensitiveSiteIdentityHints(siteIdentity)) {
    siteIdentityWarning =
      '未找到目标站点 ' + targetHost + ' 的已拦截请求身份；请先在浏览器访问该站点并触发 API 请求后再调用 MCP。';
  }
  return {
    ok: true,
    mode: normalized.batch ? 'batch_created' : 'created',
    storageKey: FLOW_CONTEXT_TOOLS_PREFIX + targetHost,
    toolsJson: JSON.stringify(toolsObj),
    createdToolName: createdToolNames[0],
    createdToolNames: createdToolNames,
    createdCount: createdToolNames.length,
    failed: failed,
    failedCount: failed.length,
    targetHost: targetHost,
    partial: normalized.batch && failed.length > 0,
    siteIdentityWarning: siteIdentityWarning || null
  };
}

function handleBrainstormMcpTool(toolArguments) {
  return buildBrainstormMcpDraftProtocol(toolArguments || {});
}

function executeFlowContextSystemTool(toolName, toolArguments, items) {
  try {
    var dataset = buildRecordedFlowDataset(items);
    if (toolName === FLOW_CONTEXT_LIST_TOOL) {
      return handleListRecordedFlows(dataset);
    }
    if (toolName === FLOW_CONTEXT_DETAIL_TOOL) {
      return handleGetRecordedFlowContext(dataset, toolArguments);
    }
    if (toolName === BRAINSTORM_MCP_TOOL) {
      return handleBrainstormMcpTool(toolArguments);
    }
    return {
      ok: false,
      errorCode: 'FLOW_CONTEXT_SYSTEM_ERROR',
      message: '未知系统工具: ' + toolName
    };
  } catch (e) {
    return {
      ok: false,
      errorCode: 'FLOW_CONTEXT_SYSTEM_ERROR',
      message: '无法读取录制流程上下文，请确认扩展和 MCP helper 已连接并重新同步。',
      detail: e && e.message ? e.message : String(e)
    };
  }
}
