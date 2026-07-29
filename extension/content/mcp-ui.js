/** \u7AD9\u70B9\u4E13\u7528\u503C\uFF1A\u5217\u8868\u4E2D\u6392\u9664\u5F53\u524D\u6807\u7B7E\u9875 hostname \u6765\u6E90\u7684 merged \u5DE5\u5177 */
var MCP_SITE_FILTER_EXCLUDE_CURRENT = '__exclude_current__';
var MCP_LIST_UI_PREFS_KEY = 'ai_req_mcp_list_ui_prefs';
var mcpListUiPrefsLoaded = false;
var mcpListUiPrefsSaveTimer = null;

function loadMcpListUiPrefs() {
  if (mcpListUiPrefsLoaded) return;
  mcpListUiPrefsLoaded = true;
  try {
    var raw = storageGet(MCP_LIST_UI_PREFS_KEY, null);
    if (!raw) return;
    var prefs = JSON.parse(raw);
    if (!state.mcpListUi) {
      state.mcpListUi = {
        keyword: '',
        viewMode: prefs.viewMode === 'flat' ? 'flat' : 'flowTree',
        groupMode: 'none',
        filterEnabled: 'all',
        riskLevels: {},
        toolbarCollapsed: false,
        siteFilter: 'all',
        selectedToolName: null,
        selectedFlowId: null,
        collapsedFlowIds: prefs.collapsedFlowIds && typeof prefs.collapsedFlowIds === 'object'
          ? prefs.collapsedFlowIds
          : {},
        inspectorOpen: false,
        scrollToFlowId: null
      };
      return;
    }
    if (prefs.collapsedFlowIds && typeof prefs.collapsedFlowIds === 'object') {
      state.mcpListUi.collapsedFlowIds = prefs.collapsedFlowIds;
    }
    if (prefs.viewMode === 'flowTree' || prefs.viewMode === 'flat') {
      state.mcpListUi.viewMode = prefs.viewMode;
    }
  } catch (e) {}
}

function saveMcpListUiPrefs() {
  ensureMcpListUi();
  try {
    storageSet(MCP_LIST_UI_PREFS_KEY, JSON.stringify({
      schemaVersion: 1,
      collapsedFlowIds: state.mcpListUi.collapsedFlowIds || {},
      viewMode: state.mcpListUi.viewMode || 'flowTree'
    }));
  } catch (e) {}
}

function scheduleSaveMcpListUiPrefs() {
  if (mcpListUiPrefsSaveTimer) clearTimeout(mcpListUiPrefsSaveTimer);
  mcpListUiPrefsSaveTimer = setTimeout(saveMcpListUiPrefs, 300);
}

function showCreateManualFlowModal(onCreate) {
  var existing = document.querySelector('.ai-req-flow-create-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'ai-req-confirm-overlay ai-req-flow-create-overlay';
  var modal = document.createElement('div');
  modal.className = 'ai-req-confirm-modal ai-req-flow-create-modal';
  modal.innerHTML =
    '<div class="ai-req-confirm-title">\u65b0\u5efa\u6d41\u7a0b</div>' +
    '<div class="ai-req-flow-create-body">' +
    '<label class="ai-req-flow-create-label">\u540d\u79f0<input type="text" class="ai-req-flow-create-name" value="\u672a\u547d\u540d\u6d41\u7a0b"></label>' +
    '<label class="ai-req-flow-create-check"><input type="checkbox" class="ai-req-flow-create-cross">\u8de8\u7ad9\u70b9\u6d41\u7a0b</label>' +
    '<div class="ai-req-flow-create-hint">\u53ef\u6536\u7eb3\u4efb\u610f\u7ad9\u70b9\u7684\u5de5\u5177</div>' +
    '</div>' +
    '<div class="ai-req-confirm-actions">' +
    '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-create-cancel">\u53d6\u6d88</button>' +
    '<button type="button" class="ai-req-btn ai-req-btn-primary ai-req-flow-create-ok">\u521b\u5efa</button>' +
    '</div>';
  overlay.appendChild(modal);
  if (typeof mountConfirmOverlay === 'function') mountConfirmOverlay(overlay);
  else document.body.appendChild(overlay);
  var nameInput = modal.querySelector('.ai-req-flow-create-name');
  var crossCb = modal.querySelector('.ai-req-flow-create-cross');
  function closeModal() {
    overlay.remove();
  }
  modal.querySelector('.ai-req-flow-create-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal();
  });
  modal.addEventListener('click', function (e) { e.stopPropagation(); });
  modal.querySelector('.ai-req-flow-create-ok').addEventListener('click', function () {
    var name = nameInput ? String(nameInput.value || '').trim() : '';
    if (!name) name = '\u672a\u547d\u540d\u6d41\u7a0b';
    var host = crossCb && crossCb.checked ? '*' : location.hostname;
    closeModal();
    if (typeof onCreate === 'function') onCreate(name, host);
  });
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }
}

function ensureMcpListUi() {
  loadMcpListUiPrefs();
  if (!state.mcpListUi) {
    state.mcpListUi = {
      keyword: '',
      viewMode: 'flowTree',
      groupMode: 'none',
      filterEnabled: 'all',
      riskLevels: {},
      toolbarCollapsed: false,
      siteFilter: 'all',
      selectedToolName: null,
      selectedFlowId: null,
      collapsedFlowIds: {},
      inspectorOpen: false,
      scrollToFlowId: null
    };
  } else {
    if (!state.mcpListUi.siteFilter) state.mcpListUi.siteFilter = 'all';
    if (!state.mcpListUi.viewMode) state.mcpListUi.viewMode = 'flowTree';
    if (!state.mcpListUi.collapsedFlowIds) state.mcpListUi.collapsedFlowIds = {};
    if (typeof state.mcpListUi.selectedToolName === 'undefined') state.mcpListUi.selectedToolName = null;
    if (typeof state.mcpListUi.selectedFlowId === 'undefined') state.mcpListUi.selectedFlowId = null;
    if (typeof state.mcpListUi.inspectorOpen !== 'boolean') state.mcpListUi.inspectorOpen = false;
  }
}

function syncMcpInspectorVisibility(mcpContent) {
  if (!mcpContent) return;
  ensureMcpListUi();
  var split = mcpContent.querySelector('.ai-req-mcp-workbench-split');
  var inspector = mcpContent.querySelector('.ai-req-mcp-inspector');
  if (!split || !inspector) return;
  var ui = state.mcpListUi;
  var open = !!ui.inspectorOpen && (!!ui.selectedToolName || !!ui.selectedFlowId);
  var isWide = state.ui && state.ui.layoutMode === 'wide';
  split.setAttribute('data-inspector-open', open ? '1' : '0');
  inspector.style.display = open ? 'flex' : 'none';
  inspector.classList.toggle('ai-req-mcp-inspector-overlay', open && !isWide);
  split.classList.toggle('ai-req-mcp-split-has-inspector', open && isWide);
}

function updateMcpSelectionStrip(mcpContent) {
  if (!mcpContent) return;
  var strip = mcpContent.querySelector('.ai-req-mcp-selection-strip');
  if (!strip) return;
  var n = getSelectedMcpToolNamesOrdered().length;
  strip.style.display = n > 0 ? 'flex' : 'none';
  var spn = strip.querySelector('.ai-req-mcp-sel-count');
  if (spn) spn.textContent = '已选 ' + n;
}

function stringifyMcpPromptSchema(tool) {
  try {
    return JSON.stringify(tool.inputSchema || { type: 'object', properties: {} }, null, 2);
  } catch (e) {
    return '{"type":"object","properties":{}}';
  }
}

function buildMcpToolCopyPrompt(toolName) {
  var toolsMap = getMcpListToolsMap();
  var tool = toolsMap[toolName];
  if (!tool) return '';
  var meta = tool._meta || {};
  var isSystem = isFlowContextSystemToolName(toolName) || !!meta.flowContextSystem;
  var host = isSystem ? '(system)' : resolveMcpToolHostFromView(toolName);
  var route = isSystem ? '系统工具' : (((meta.method || 'GET').toUpperCase() + ' ' + (meta.pathname || '')).trim() || '-');
  return [
    '请优先使用 MCP 工具 `' + toolName + '` 来完成我的请求。',
    '',
    '工具说明：' + (tool.description || '无'),
    '来源站点：' + host,
    '调用入口：' + route,
    '风险等级：' + ((meta.riskLevel || 'low')),
    '',
    '参数 Schema：',
    stringifyMcpPromptSchema(tool),
    '',
    '请根据我的自然语言目标补齐参数；如果必要参数缺失，先向我确认，不要猜测高风险操作。'
  ].join('\n');
}

function copyTextToClipboard(text, onSuccess, onFailure) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(onFailure);
    return;
  }
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) onSuccess();
    else onFailure();
  } catch (e) {
    onFailure();
  }
}

function buildMcpToolInspectorHTML(toolName) {
  var toolsMap = getMcpListToolsMap();
  var tool = toolsMap[toolName];
  if (!tool) {
    return '<div class="ai-req-inspector-empty">工具不存在或已被删除</div>';
  }
  var meta = tool._meta || {};
  if (isFlowContextSystemToolName(toolName) || meta.flowContextSystem) {
    var sysHtml = '';
    sysHtml += '<div class="ai-req-mcp-inspector-section">';
    sysHtml += '<div class="ai-req-detail-label">类型</div>';
    sysHtml += '<div class="ai-req-detail-value">系统工具 · 流程上下文查询</div>';
    sysHtml += '</div>';
    sysHtml += '<div class="ai-req-mcp-inspector-section">';
    sysHtml += '<div class="ai-req-detail-label">描述</div>';
    sysHtml += '<div class="ai-req-detail-value">' + escapeHtml(tool.description || '（无）') + '</div>';
    sysHtml += '</div>';
    sysHtml += '<div class="ai-req-mcp-inspector-section">';
    sysHtml += '<div class="ai-req-detail-label">说明</div>';
    sysHtml += '<div class="ai-req-detail-value">系统工具由扩展固定提供，不可删除或禁用。可在设置页控制是否暴露给 Cursor。</div>';
    sysHtml += '</div>';
    sysHtml += '<div class="ai-req-mcp-inspector-actions">';
    sysHtml += '<button type="button" class="ai-req-btn ai-req-btn-primary ai-req-mcp-tool-copy-prompt-btn" data-tool-name="' + escapeHtml(toolName) + '">复制提示词</button>';
    sysHtml += '</div>';
    return sysHtml;
  }
  var host = resolveMcpToolHostFromView(toolName);
  var riskLevel = (tool._meta && tool._meta.riskLevel) || 'low';
  var enabled = tool.enabled !== false;
  var routeLine = ((meta.method || 'GET').toUpperCase() + ' ' + (meta.pathname || '')).trim();
  var html = '';
  html += '<div class="ai-req-mcp-inspector-meta">';
  html += '<span class="ai-req-mcp-risk ai-req-mcp-risk-' + escapeHtml(riskLevel) + '">' + escapeHtml(riskLevel) + '</span>';
  html += '<span class="ai-req-mcp-inspector-route">' + escapeHtml(routeLine) + '</span>';
  html += '<span class="ai-req-mcp-inspector-host">' + escapeHtml(host) + '</span>';
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">描述</div>';
  html += '<div class="ai-req-detail-value">' + escapeHtml(tool.description || '（无）') + '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">启用状态</div>';
  html += '<label class="ai-req-mcp-inspector-enabled-label"><input type="checkbox" class="ai-req-mcp-tool-enabled ai-req-mcp-inspector-enabled" data-tool-name="' + escapeHtml(toolName) + '"' + (enabled ? ' checked' : '') + '> 启用此工具</label>';
  html += '</div>';
  var usability = meta.usability || {};
  var flowMeta = meta.flow || null;
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">AI 可用性</div>';
  html += '<div class="ai-req-detail-value">';
  html += usability.tested ? '已测试' : (usability.verified ? '已验证，待测试' : '未验证');
  if (usability.lastStatus) html += ' · HTTP ' + escapeHtml(usability.lastStatus);
  if (usability.lastTestAt) html += ' · ' + escapeHtml(new Date(usability.lastTestAt).toLocaleString());
  if (usability.lastError) html += '<br><span class="ai-req-mcp-usability-error">' + escapeHtml(usability.lastError) + '</span>';
  html += '</div>';
  html += '</div>';
  if (flowMeta) {
    html += '<div class="ai-req-mcp-inspector-section">';
    html += '<div class="ai-req-detail-label">来源流程</div>';
    html += '<div class="ai-req-detail-value">' + escapeHtml(flowMeta.flowName || flowMeta.flowId || '') + ' · ' + ((flowMeta.steps || []).length) + ' 步验证</div>';
    html += '</div>';
  }
  var props = (tool.inputSchema && tool.inputSchema.properties) || {};
  var required = (tool.inputSchema && tool.inputSchema.required) || [];
  var propKeys = Object.keys(props);
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">参数 Schema（' + propKeys.length + '）</div>';
  if (propKeys.length === 0) {
    html += '<div class="ai-req-detail-value">无参数</div>';
  } else {
    html += '<div class="ai-req-mcp-schema-list">';
    for (var pi = 0; pi < propKeys.length; pi++) {
      var pName = propKeys[pi];
      var pDef = props[pName];
      var isReq = required.indexOf(pName) !== -1;
      html += '<div class="ai-req-mcp-schema-item">';
      html += '<span class="ai-req-mcp-schema-name">' + escapeHtml(pName) + '</span>';
      html += '<span class="ai-req-mcp-schema-type">' + escapeHtml(pDef.type || 'string') + '</span>';
      if (isReq) html += '<span class="ai-req-mcp-schema-req">required</span>';
      if (pDef.description) {
        html += '<div class="ai-req-mcp-schema-desc">' + escapeHtml(pDef.description) + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector-actions">';
  html += '<button type="button" class="ai-req-btn ai-req-btn-primary ai-req-mcp-tool-copy-prompt-btn" data-tool-name="' + escapeHtml(toolName) + '">复制提示词</button>';
  if (flowMeta) {
    html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-tool-unassign-btn" data-tool-name="' + escapeHtml(toolName) + '">移出流程</button>';
  }
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-tool-edit-btn" data-tool-name="' + escapeHtml(toolName) + '">编辑</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-tool-test-btn" data-tool-name="' + escapeHtml(toolName) + '">测试</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-danger ai-req-mcp-tool-delete-btn" data-tool-name="' + escapeHtml(toolName) + '">删除</button>';
  html += '</div>';
  return html;
}

function buildMcpFlowInspectorHTML(flowId) {
  var flow = getFlowById(flowId);
  if (!flow) return '<div class="ai-req-inspector-empty">流程不存在</div>';
  var kind = inferFlowKind(flow);
  var kindLabel = kind === 'manual' ? '手动' : '录制';
  var toolsMap = getMcpListToolsMap();
  var toolNames = typeof resolveFlowToolNames === 'function'
    ? resolveFlowToolNames(flow)
    : (flow.mcpToolNames || []);
  var linked = 0;
  var mi;
  for (mi = 0; mi < toolNames.length; mi++) {
    if (toolsMap[toolNames[mi]]) linked++;
  }
  var html = '';
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">类型</div>';
  html += '<div class="ai-req-detail-value">' + escapeHtml(kindLabel) + '流程</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">站点</div>';
  html += '<div class="ai-req-detail-value">' + escapeHtml(flow.hostname || '-') + '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector-section">';
  html += '<div class="ai-req-detail-label">工具</div>';
  html += '<div class="ai-req-detail-value">已关联 ' + toolNames.length + ' · 可见 ' + linked;
  if (toolNames.length > linked) {
    html += ' · 缺失 ' + (toolNames.length - linked);
  }
  html += '</div></div>';
  if (kind === 'manual') {
    html += '<div class="ai-req-mcp-inspector-section"><div class="ai-req-detail-value">手动分组，无录制步骤。</div></div>';
  } else {
    html += '<div class="ai-req-mcp-inspector-section"><div class="ai-req-detail-value">步骤 ' + ((flow.steps || []).length) + ' · 已验证 ' + ((flow.verifiedRequestIds || []).length) + '</div></div>';
  }
  html += '<div class="ai-req-mcp-inspector-actions">';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-flow-open-flow-btn" data-flow-id="' + escapeHtml(flowId) + '">在 FLOW 页打开</button>';
  if (toolNames.length > linked) {
    html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-flow-prune-btn" data-flow-id="' + escapeHtml(flowId) + '">清理缺失引用</button>';
  }
  html += '</div>';
  return html;
}

function renderMcpToolInspector(mcpContent, toolName) {
  if (!mcpContent) return;
  var body = mcpContent.querySelector('.ai-req-mcp-inspector-body');
  var titleEl = mcpContent.querySelector('.ai-req-mcp-inspector-title');
  if (!body) return;
  ensureMcpListUi();
  if (!toolName && state.mcpListUi.selectedFlowId) {
    if (titleEl) {
      var selFlow = getFlowById(state.mcpListUi.selectedFlowId);
      titleEl.textContent = selFlow ? (selFlow.name || selFlow.id) : '流程详情';
    }
    body.innerHTML = buildMcpFlowInspectorHTML(state.mcpListUi.selectedFlowId);
    return;
  }
  if (!toolName) {
    if (titleEl) titleEl.textContent = '工具详情';
    body.innerHTML = '<div class="ai-req-inspector-empty">选择一条工具或流程查看详情</div>';
    return;
  }
  if (titleEl) {
    titleEl.textContent = toolName;
    titleEl.title = toolName;
  }
  body.innerHTML = buildMcpToolInspectorHTML(toolName);
}

function getMcpListToolsMap() {
  var ds = state.mcpViewDataset;
  if (!ds) return {};
  if (ds.ok && ds.tools && typeof ds.tools === 'object') return ds.tools;
  if (ds.ok === false) return {};
  return state.mcpTools || {};
}

function resolveMcpToolHostFromView(toolName) {
  var ds = state.mcpViewDataset;
  if (ds && ds.hostByTool && ds.hostByTool[toolName]) return ds.hostByTool[toolName];
  return location.hostname;
}

function mcpSafeFilenameSegment(seg) {
  return String(seg || 'host').replace(/[^a-zA-Z0-9._-]+/g, '_').substring(0, 120);
}

function passesMcpListFilters(tool, ui) {
  if (ui.filterEnabled === 'on' && tool.enabled === false) return false;
  if (ui.filterEnabled === 'off' && tool.enabled !== false) return false;
  var rl = ((tool._meta || {}).riskLevel || 'low').toLowerCase();
  var rf = ui.riskLevels || {};
  var anyRisk = false;
  var rk;
  for (rk in rf) {
    if (rf.hasOwnProperty(rk) && rf[rk]) {
      anyRisk = true;
      break;
    }
  }
  if (anyRisk && !rf[rl]) return false;
  return true;
}

function mcpToolMatchesKeyword(tool, name, kwLower) {
  if (!kwLower) return true;
  var meta = tool._meta || {};
  var isSystem = isFlowContextSystemToolName(name) || !!meta.flowContextSystem;
  if (isSystem) {
    var systemHay = (
      name + '\n' +
      (tool.description || '') + '\n' +
      'system\nsys\n系统\n系统工具\nflow context\nflowcontext'
    ).toLowerCase();
    if (systemHay.indexOf(kwLower) !== -1) return true;
  }
  var hay = (name + '\n' + (tool.description || '') + '\n' + (meta.method || '') + ' ' + (meta.pathname || '')).toLowerCase();
  return hay.indexOf(kwLower) !== -1;
}

function isFlowContextSystemToolName(name) {
  return name === 'list_recorded_flows' ||
    name === 'get_recorded_flow_context' ||
    name === 'brainstorm_mcp_tool';
}

function getMcpToolGroupKey(name, tool, groupMode) {
  if (isFlowContextSystemToolName(name)) return '系统工具';
  var meta = tool._meta || {};
  if (groupMode === 'flow') {
    var fn = meta.flow && meta.flow.flowName;
    return fn ? fn : '其他';
  }
  if (groupMode === 'method') return (meta.method || 'GET').toUpperCase();
  if (groupMode === 'risk') return String((meta.riskLevel || 'low')).toLowerCase();
  if (groupMode === 'pathPrefix') {
    var p = meta.pathname || '';
    var seg = p.replace(/^\/+/, '').split('/')[0];
    return seg ? seg : '(root)';
  }
  return '';
}

function getFilteredSortedMcpToolNames() {
  ensureMcpListUi();
  var ui = state.mcpListUi;
  var kwLower = (ui.keyword || '').trim().toLowerCase();
  var toolsMap = getMcpListToolsMap();
  var all = Object.keys(toolsMap || {});
  var pass = [];
  var ii;
  for (ii = 0; ii < all.length; ii++) {
    var nm = all[ii];
    var tl = toolsMap[nm];
    if (!tl) continue;
    if (!passesMcpListFilters(tl, ui)) continue;
    if (!mcpToolMatchesKeyword(tl, nm, kwLower)) continue;
    pass.push(nm);
  }
  pass.sort();
  return pass;
}

function buildMcpToolRowHTML(name, tool, opts) {
  opts = opts || {};
  var hostByTool = opts.hostByTool || {};
  var showHostCol = opts.showHostCol !== false;
  var selectedName = opts.selectedToolName;
  var isChild = !!opts.isChild;
  var riskLevel = (tool._meta && tool._meta.riskLevel) || 'low';
  var enabled = tool.enabled !== false;
  var picked = state.selectedMcpToolNames[name] ? true : false;
  var meta = tool._meta || {};
  var isSystemTool = isFlowContextSystemToolName(name) || !!meta.flowContextSystem;
  var isSelected = selectedName === name;
  var flowId = meta.flow && meta.flow.flowId ? meta.flow.flowId : '';
  var rowClasses = 'ai-req-mcp-table-row' + (isSelected ? ' ai-req-mcp-row-selected' : '') + (showHostCol ? '' : ' ai-req-mcp-row-no-host') + (isChild ? ' ai-req-mcp-flow-child' : '');
  if (isChild && !isSystemTool) rowClasses += ' ai-req-mcp-tool-row';
  var html = '';
  html += '<div class="' + rowClasses + '" data-tool-name="' + escapeHtml(name) + '"' + (flowId ? ' data-flow-id="' + escapeHtml(flowId) + '"' : '') + '>';
  if (isChild && !isSystemTool) {
    html += '<span class="ai-req-mcp-drag-handle" draggable="true" title="拖拽移动或排序">\u22ee\u22ee</span>';
  }
  if (isSystemTool) {
    html += '<span class="ai-req-mcp-row-cb ai-req-mcp-row-cb-empty"></span>';
  } else {
    html += '<label class="ai-req-mcp-row-cb"><input type="checkbox" class="ai-req-mcp-tool-pick" data-tool-name="' + escapeHtml(name) + '"' + (picked ? ' checked' : '') + '></label>';
  }
  html += '<span class="ai-req-mcp-col-name" title="' + escapeHtml(name) + '">' + escapeHtml(name);
  if (isSystemTool) html += ' <span class="ai-req-mcp-sys-badge">系统</span>';
  html += '</span>';
  if (showHostCol) {
    html += '<span class="ai-req-mcp-col-host" title="来源站点">' + escapeHtml(hostByTool[name] || '-') + '</span>';
  }
  html += '<span class="ai-req-mcp-col-method">' + escapeHtml(isSystemTool ? 'SYS' : (meta.method || 'GET').toUpperCase()) + '</span>';
  html += '<span class="ai-req-mcp-col-path" title="' + escapeHtml(meta.pathname || '') + '">' + escapeHtml(isSystemTool ? 'flow context' : (meta.pathname || '-')) + '</span>';
  html += '<span class="ai-req-mcp-risk ai-req-mcp-risk-' + escapeHtml(riskLevel) + ' ai-req-mcp-col-risk">' + escapeHtml(isSystemTool ? '-' : riskLevel) + '</span>';
  if (isSystemTool) {
    html += '<span class="ai-req-mcp-col-enabled ai-req-mcp-sys-enabled">固定</span>';
  } else {
    html += '<label class="ai-req-mcp-toggle ai-req-mcp-col-enabled"><input type="checkbox" class="ai-req-mcp-tool-enabled" data-tool-name="' + escapeHtml(name) + '"' + (enabled ? ' checked' : '') + '></label>';
  }
  html += '</div>';
  return html;
}

function buildMcpFlowTreeHTML() {
  ensureMcpListUi();
  var ui = state.mcpListUi;
  var toolsMap = getMcpListToolsMap();
  var hostByTool = (state.mcpViewDataset && state.mcpViewDataset.hostByTool) || {};
  var sfUi = ui.siteFilter || 'all';
  var showHostCol = sfUi === 'all' || sfUi === MCP_SITE_FILTER_EXCLUDE_CURRENT;
  var filteredSet = buildFilteredToolNameSet(toolsMap, ui);
  var groups = buildFlowTreeGroups(toolsMap, getMergedFlowsMap(), {
    filteredToolSet: filteredSet,
    hostByTool: hostByTool
  });
  var html = '';
  if (Object.keys(toolsMap || {}).length === 0) {
    return '<div class="ai-req-mcp-empty">暂无 MCP 工具（当前筛选范围），可切换「全部站点」或换站点查看</div>';
  }
  var hasVisible = false;
  var gi;
  for (gi = 0; gi < groups.length; gi++) {
    if (groups[gi].tools.length > 0) hasVisible = true;
    else if (
      groups[gi].kind === 'manual' &&
      groups[gi].flow
    ) hasVisible = true;
    else if (
      groups[gi].kind !== 'system' &&
      groups[gi].kind !== 'other' &&
      groups[gi].missingRefs &&
      groups[gi].missingRefs.length > 0
    ) hasVisible = true;
  }
  if (!hasVisible) {
    return '<div class="ai-req-mcp-empty">无匹配项，调整筛选或关键词</div>';
  }
  var scrollId = ui.scrollToFlowId;
  if (scrollId) {
    delete ui.collapsedFlowIds[scrollId];
    ui.scrollToFlowId = null;
  }
  for (gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    var isSystem = group.kind === 'system';
    var isOther = group.kind === 'other';
    var isNamedFlow = group.flowId && !isSystem && !isOther;
    var collapsed = !!ui.collapsedFlowIds[group.key];
    if (group.tools.length === 0 && !isNamedFlow) continue;
    if (isNamedFlow && group.tools.length === 0 && !group.flow) continue;
    if (
      isNamedFlow &&
      group.tools.length === 0 &&
      group.kind !== 'manual' &&
      !(group.missingRefs && group.missingRefs.length)
    ) continue;
    var chevron = collapsed ? '\u25B6' : '\u25BC';
    var kindBadge = '';
    if (isNamedFlow) {
      var kindLabel = group.kind === 'manual' ? '手动' : '录制';
      if (group.flow && group.flow.hostname === '*') kindLabel = '手动·跨站';
      kindBadge = '<span class="ai-req-mcp-flow-kind-badge ai-req-mcp-flow-kind-' + escapeHtml(group.kind) + '">' + kindLabel + '</span>';
    }
    var countLabel = group.tools.length;
    var selectedFlow = ui.selectedFlowId === group.flowId;
    html += '<div class="ai-req-mcp-flow-group-header' + (selectedFlow ? ' ai-req-mcp-flow-group-selected' : '') + (showHostCol ? '' : ' ai-req-mcp-flow-group-no-host') + '" data-flow-group-key="' + escapeHtml(group.key) + '"' + (group.flowId ? ' data-flow-id="' + escapeHtml(group.flowId) + '"' : '') + '>';
    html += '<span class="ai-req-mcp-flow-chevron">' + chevron + '</span>';
    html += '<span class="ai-req-mcp-flow-group-title">' + escapeHtml(group.title);
    if (group.subtitle) html += ' <span class="ai-req-mcp-flow-group-sub">(' + escapeHtml(group.subtitle) + ')</span>';
    html += '</span>';
    html += '<span class="ai-req-mcp-flow-group-count">(' + countLabel + ')</span>';
    html += kindBadge;
    if (isNamedFlow) {
      html += '<span class="ai-req-mcp-flow-group-actions">';
      html += '<button type="button" class="ai-req-mcp-flow-rename-btn" data-flow-id="' + escapeHtml(group.flowId) + '" title="重命名">\u270E</button>';
      html += '<button type="button" class="ai-req-mcp-flow-delete-btn" data-flow-id="' + escapeHtml(group.flowId) + '" title="删除">\uD83D\uDDD1</button>';
      html += '</span>';
    }
    html += '</div>';
    if (!collapsed) {
      var ti;
      for (ti = 0; ti < group.tools.length; ti++) {
        var tname = group.tools[ti];
        var ttool = toolsMap[tname];
        if (!ttool) continue;
        html += buildMcpToolRowHTML(tname, ttool, {
          hostByTool: hostByTool,
          showHostCol: showHostCol,
          selectedToolName: ui.selectedToolName,
          isChild: true
        });
      }
    }
  }
  return html;
}

function buildMcpFlatToolListHTML() {
  ensureMcpListUi();
  var ui = state.mcpListUi;
  var html = '';
  var toolsMap = getMcpListToolsMap();
  var hostByTool = (state.mcpViewDataset && state.mcpViewDataset.hostByTool) || {};
  var sfUi = ui.siteFilter || 'all';
  var showHostCol = sfUi === 'all' || sfUi === MCP_SITE_FILTER_EXCLUDE_CURRENT;
  var toolNames = getFilteredSortedMcpToolNames();
  var gm2 = ui.groupMode || 'none';
  var lastGk = '\u0000';
  if (Object.keys(toolsMap || {}).length === 0) {
    return '<div class="ai-req-mcp-empty">暂无 MCP 工具（当前筛选范围），可切换「全部站点」或换站点查看</div>';
  }
  if (toolNames.length === 0) {
    return '<div class="ai-req-mcp-empty">无匹配项，调整筛选或关键词</div>';
  }
  var ti;
  for (ti = 0; ti < toolNames.length; ti++) {
    var name = toolNames[ti];
    var tool = toolsMap[name];
    if (gm2 !== 'none') {
      var gk = getMcpToolGroupKey(name, tool, gm2);
      if (gk !== lastGk) {
        lastGk = gk;
        html += '<div class="ai-req-mcp-group-header"><span class="ai-req-mcp-group-title">' + escapeHtml(gk) + '</span></div>';
      }
    }
    html += buildMcpToolRowHTML(name, tool, {
      hostByTool: hostByTool,
      showHostCol: showHostCol,
      selectedToolName: ui.selectedToolName,
      isChild: false
    });
  }
  return html;
}

function buildMcpToolListInnerHTML() {
  ensureMcpListUi();
  if (!state.mcpViewDataset) {
    return '<div class="ai-req-mcp-empty">正在加载工具列表...</div>';
  }
  if (!state.mcpViewDataset.ok) {
    return '<div class="ai-req-mcp-empty">无法加载工具数据，请关闭再打开 MCP 面板重试</div>';
  }
  if ((state.mcpListUi.viewMode || 'flowTree') === 'flowTree') {
    return buildMcpFlowTreeHTML();
  }
  return buildMcpFlatToolListHTML();
}

function refreshMcpToolListViewLocal(mcpContent) {
  if (!mcpContent) return;
  ensureMcpListUi();
  var listEl = mcpContent.querySelector('.ai-req-mcp-tool-list');
  if (!listEl) return;
  listEl.innerHTML = buildMcpToolListInnerHTML();
  var toolNamesAfter = getFilteredSortedMcpToolNames();
  if (state.mcpListUi.selectedToolName && toolNamesAfter.indexOf(state.mcpListUi.selectedToolName) === -1) {
    state.mcpListUi.selectedToolName = null;
    state.mcpListUi.inspectorOpen = false;
  }
  if (state.ui && state.ui.layoutMode === 'wide' && state.mcpListUi.selectedToolName) {
    state.mcpListUi.inspectorOpen = true;
  }
  renderMcpToolInspector(
    mcpContent,
    state.mcpListUi.inspectorOpen
      ? (state.mcpListUi.selectedToolName || null)
      : null
  );
  syncMcpInspectorVisibility(mcpContent);
  updateMcpSelectionStrip(mcpContent);
  refreshMcpMoveToFlowSelect(mcpContent);
  syncMcpViewModeToolbar(mcpContent);
  var tableHead = mcpContent.querySelector('.ai-req-mcp-table-head');
  if (tableHead) {
    var sfHead = state.mcpListUi.siteFilter || 'all';
    var showHostHead = sfHead === 'all' || sfHead === MCP_SITE_FILTER_EXCLUDE_CURRENT;
    tableHead.classList.toggle('ai-req-mcp-table-head-no-host', !showHostHead);
    var isFlowTree = (state.mcpListUi.viewMode || 'flowTree') === 'flowTree';
    var hasRows = isFlowTree
      ? Object.keys(getMcpListToolsMap() || {}).length > 0
      : toolNamesAfter.length > 0;
    tableHead.style.display = hasRows && !isFlowTree ? 'grid' : 'none';
  }
}

function refreshMcpMoveToFlowSelect(mcpContent) {
  if (!mcpContent) return;
  var sel = mcpContent.querySelector('.ai-req-mcp-move-to-flow-select');
  if (!sel) return;
  var flows = listAssignableFlows();
  var html = '<option value="">移动到流程...</option>';
  var i;
  for (i = 0; i < flows.length; i++) {
    html += '<option value="' + escapeHtml(flows[i].id) + '">' + escapeHtml(flows[i].name) + '</option>';
  }
  sel.innerHTML = html;
}

function syncMcpViewModeToolbar(mcpContent) {
  if (!mcpContent) return;
  var isFlowTree = (state.mcpListUi.viewMode || 'flowTree') === 'flowTree';
  var grpWrap = mcpContent.querySelector('.ai-req-mcp-group-select-wrap');
  if (grpWrap) grpWrap.style.display = isFlowTree ? 'none' : '';
  var viewSel = mcpContent.querySelector('.ai-req-mcp-view-mode');
  if (viewSel && viewSel.value !== (state.mcpListUi.viewMode || 'flowTree')) {
    viewSel.value = state.mcpListUi.viewMode || 'flowTree';
  }
}

function patchMcpToolListSection(mcpContent) {
  if (!mcpContent || state.mcpPanelTab !== 'list') return;
  var listEl = mcpContent.querySelector('.ai-req-mcp-tool-list');
  if (!listEl) return;

  ensureMcpListUi();
  var sfReq = state.mcpListUi.siteFilter || 'all';

  function loadToolsView() {
  chrome.runtime.sendMessage(
    {
      type: 'MCP_GET_TOOLS_VIEW',
      siteFilter: sfReq,
      currentTabHostname: typeof location !== 'undefined' ? location.hostname : ''
    },
    function (resp) {
    if (chrome.runtime.lastError) {
      console.warn('[AI_REQ_ANALYZER] MCP_GET_TOOLS_VIEW:', chrome.runtime.lastError.message);
      state.mcpViewDataset = { ok: false };
    } else {
      state.mcpViewDataset = resp && resp.ok ? resp : { ok: false };
    }

    if (state.mcpViewDataset && state.mcpViewDataset.flowsById) {
      ensureFlowState();
      var fbKeys = Object.keys(state.mcpViewDataset.flowsById);
      var fbi;
      for (fbi = 0; fbi < fbKeys.length; fbi++) {
        var frec = state.mcpViewDataset.flowsById[fbKeys[fbi]];
        if (frec && (!frec.hostname || frec.hostname === location.hostname)) {
          state.flows[frec.id] = frec;
        }
      }
    }

    var siteSel = mcpContent.querySelector('.ai-req-mcp-site-filter');
    var ds = state.mcpViewDataset;
    var hosts = (ds && ds.hosts) || [];

    if (siteSel && ds && ds.ok) {
      var curSf = state.mcpListUi.siteFilter || 'all';
      if (
        curSf !== 'all' &&
        curSf !== MCP_SITE_FILTER_EXCLUDE_CURRENT &&
        hosts.indexOf(curSf) === -1
      ) {
        state.mcpListUi.siteFilter = 'all';
        patchMcpToolListSection(mcpContent);
        return;
      }
      var mergedCnt = typeof ds.mergedToolCount === 'number' ? ds.mergedToolCount : 0;
      var exRemain =
        typeof ds.excludeCurrentRemainCount === 'number' ? ds.excludeCurrentRemainCount : mergedCnt;
      var htc = ds.hostToolCounts || {};
      var hec = ds.hostEnabledCounts || {};
      var tabHost = typeof location !== 'undefined' ? location.hostname : '';
      var mergedEnabledCnt = typeof ds.mergedEnabledCount === 'number' ? ds.mergedEnabledCount : 0;
      var helperCnt = typeof ds.helperToolCount === 'number' ? ds.helperToolCount : 0;
      var opts =
        '<option value="all"' +
        (curSf === 'all' ? ' selected' : '') +
        '>\u5168\u90E8\u7AD9\u70B9\uFF08' +
        mergedCnt +
        '\uFF0F\u542F\u7528 ' +
        mergedEnabledCnt +
        '\uFF09\u00B7\u540C\u6B65\u5230 Cursor ' +
        helperCnt +
        '</option>';
      opts +=
        '<option value="' +
        MCP_SITE_FILTER_EXCLUDE_CURRENT +
        '"' +
        (curSf === MCP_SITE_FILTER_EXCLUDE_CURRENT ? ' selected' : '') +
        '>\u6392\u9664\u5F53\u524D\u9875\uFF08' +
        exRemain +
        '\uFF09\u00B7\u9690\u85CF ' +
        escapeHtml(tabHost || '\uFF08\u672A\u77E5\uFF09') +
        '</option>';
      var hi;
      for (hi = 0; hi < hosts.length; hi++) {
        var h = hosts[hi];
        var hn = htc[h] != null ? htc[h] : 0;
        var hen = hec[h] != null ? hec[h] : 0;
        opts +=
          '<option value="' +
          escapeHtml(h) +
          '"' +
          (h === curSf ? ' selected' : '') +
          '>' +
          escapeHtml(h) +
          ' (' +
          hn +
          '/启用 ' +
          hen +
          ')</option>';
      }
      siteSel.innerHTML = opts;
      siteSel.value = curSf;
    }

    var exBtnSync = mcpContent.querySelector('.ai-req-mcp-exclude-current-btn');
    if (exBtnSync) {
      var onEx = (state.mcpListUi.siteFilter || 'all') === MCP_SITE_FILTER_EXCLUDE_CURRENT;
      exBtnSync.classList.toggle('ai-req-chip-on', onEx);
      exBtnSync.textContent = onEx ? '\u663E\u793A\u5168\u90E8\u7AD9\u70B9' : '\u6392\u9664\u5F53\u524D\u9875';
    }

    refreshMcpToolListViewLocal(mcpContent);

    var miniBar = mcpContent.querySelector('.ai-req-mcp-toolbar-mini');
    if (miniBar) {
      var fv = getFilteredSortedMcpToolNames().length;
      var ta = Object.keys(getMcpListToolsMap() || {}).length;
      var line = '\u663E\u793A ' + fv + ' / \u5171 ' + ta;
      if (ds && ds.ok && typeof ds.mergedToolCount === 'number') {
        var helperLine = typeof ds.helperToolCount === 'number' ? ds.helperToolCount : ds.mergedEnabledCount;
        line +=
          ' \u00B7 \u5168\u5E93\u5408\u5E76 ' +
          ds.mergedToolCount +
          ' \u00B7 storage\u542F\u7528 ' +
          ds.mergedEnabledCount +
          ' \u00B7 helper\u5B9E\u9645 ' +
          helperLine;
      }
      miniBar.textContent = line;
    }

    bindMcpToolListRowEvents(mcpContent);
  });
  }

  chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' }, function () {
    loadToolsView();
  });
}

function bindMcpToolListRowEvents(mcpContent) {
  if (!mcpContent || mcpContent._aiReqMcpRowsDelegated) return;
  mcpContent._aiReqMcpRowsDelegated = true;

  mcpContent.addEventListener('change', function (ev) {
    var target = ev.target;
    if (!target || !target.classList) return;
    if (target.classList.contains('ai-req-mcp-tool-enabled')) {
      var tName = target.getAttribute('data-tool-name');
      var host = resolveMcpToolHostFromView(tName);
      if (setMcpToolEnabledOnHost(host, tName, target.checked)) {
        chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
        if (state.mcpPanelTab === 'list') patchMcpToolListSection(mcpContent);
      }
      return;
    }
    if (target.classList.contains('ai-req-mcp-tool-pick')) {
      ev.stopPropagation();
      var pnm = target.getAttribute('data-tool-name');
      if (!state.selectedMcpToolNames) state.selectedMcpToolNames = {};
      if (target.checked) state.selectedMcpToolNames[pnm] = true;
      else delete state.selectedMcpToolNames[pnm];
      updateMcpSelectionStrip(mcpContent);
    }
  });

  mcpContent.addEventListener('click', function (ev) {
    var flowHdr = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-flow-group-header') : null;
    if (flowHdr && !ev.target.closest('.ai-req-mcp-flow-rename-btn') && !ev.target.closest('.ai-req-mcp-flow-delete-btn')) {
      ensureMcpListUi();
      var gkey = flowHdr.getAttribute('data-flow-group-key');
      var fid = flowHdr.getAttribute('data-flow-id');
      if (gkey) {
        if (state.mcpListUi.collapsedFlowIds[gkey]) delete state.mcpListUi.collapsedFlowIds[gkey];
        else state.mcpListUi.collapsedFlowIds[gkey] = true;
        scheduleSaveMcpListUiPrefs();
      }
      if (fid) {
        state.mcpListUi.selectedFlowId = fid;
        state.mcpListUi.selectedToolName = null;
        state.mcpListUi.inspectorOpen = true;
      }
      refreshMcpToolListViewLocal(mcpContent);
      return;
    }

    var renameBtn = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-flow-rename-btn') : null;
    if (renameBtn) {
      ev.stopPropagation();
      var rid = renameBtn.getAttribute('data-flow-id');
      var rflow = getFlowById(rid);
      if (!rflow) return;
      var newName = prompt('重命名流程', rflow.name || '');
      if (newName === null || !String(newName).trim()) return;
      renameFlow(rid, String(newName).trim());
      refreshMcpToolListViewLocal(mcpContent);
      showToast('已重命名流程', 2000, 'success');
      return;
    }

    var deleteFlowBtn = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-flow-delete-btn') : null;
    if (deleteFlowBtn) {
      ev.stopPropagation();
      var did = deleteFlowBtn.getAttribute('data-flow-id');
      var dflow = getFlowById(did);
      if (!dflow) return;
      var msg = inferFlowKind(dflow) === 'recorded'
        ? '删除流程「' + (dflow.name || did) + '」？录制步骤将一并删除，MCP 工具将保留并移入「其他」。'
        : '删除流程「' + (dflow.name || did) + '」？组内工具将移入「其他」。';
      confirmDangerAction({
        title: '删除流程',
        message: msg,
        confirmLabel: '删除流程'
      }).then(function (ok) {
        if (!ok) return;
        var delResult = deleteFlowById(did);
        if (!delResult.ok) {
          showToast(delResult.error === 'RECORDING_ACTIVE' ? '请先结束录制' : '删除失败', 3000, 'error');
          return;
        }
        if (state.mcpListUi.selectedFlowId === did) {
          state.mcpListUi.selectedFlowId = null;
          state.mcpListUi.inspectorOpen = false;
        }
        refreshMcpToolListViewLocal(mcpContent);
        showToast('已删除流程', 2500, 'success');
      });
      return;
    }

    var openFlowBtn = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-flow-open-flow-btn') : null;
    if (openFlowBtn) {
      var ofid = openFlowBtn.getAttribute('data-flow-id');
      if (ofid && typeof openFlowInWorkbench === 'function') openFlowInWorkbench(ofid);
      return;
    }

    var pruneBtn = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-flow-prune-btn') : null;
    if (pruneBtn) {
      var pid = pruneBtn.getAttribute('data-flow-id');
      var pr = pruneMissingToolRefs(pid);
      refreshMcpToolListViewLocal(mcpContent);
      showToast('已清理 ' + (pr.removed || 0) + ' 个缺失引用', 2000, 'success');
      return;
    }

    var row = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-table-row') : null;
    if (row && !ev.target.closest('input') && !ev.target.closest('button') && !ev.target.closest('label')) {
      var rowName = row.getAttribute('data-tool-name');
      if (rowName) {
        ensureMcpListUi();
        state.mcpListUi.selectedFlowId = null;
        if (state.mcpListUi.selectedToolName === rowName) {
          if (state.ui && state.ui.layoutMode !== 'wide') {
            state.mcpListUi.inspectorOpen = !state.mcpListUi.inspectorOpen;
          }
        } else {
          state.mcpListUi.selectedToolName = rowName;
          state.mcpListUi.inspectorOpen = true;
        }
        refreshMcpToolListViewLocal(mcpContent);
      }
      return;
    }

    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-tool-name]') : null;
    if (!btn) return;
    var toolName = btn.getAttribute('data-tool-name');
    if (btn.classList.contains('ai-req-mcp-tool-copy-prompt-btn')) {
      var promptText = buildMcpToolCopyPrompt(toolName);
      if (!promptText) {
        showToast('工具不存在，无法复制提示词', 2500, 'error');
        return;
      }
      copyTextToClipboard(promptText, function () {
        showToast('已复制工具提示词', 2000, 'success');
      }, function () {
        showToast('复制失败', 2500, 'error');
      });
      return;
    }
    if (btn.classList.contains('ai-req-mcp-tool-unassign-btn')) {
      unassignToolsFromFlow([toolName]);
      refreshMcpToolListViewLocal(mcpContent);
      showToast('已移出流程', 2000, 'success');
      return;
    }
    if (btn.classList.contains('ai-req-mcp-tool-edit-btn')) {
      openMcpToolEditor(toolName);
      return;
    }
    if (btn.classList.contains('ai-req-mcp-tool-test-btn')) {
      openMcpToolTester(toolName);
      return;
    }
    if (btn.classList.contains('ai-req-mcp-tool-delete-btn')) {
      confirmDangerAction({
        title: '删除 MCP 工具',
        message: '将永久删除工具「' + toolName + '」。Cursor 同步后该工具不再可用，且不可撤销。',
        confirmLabel: '删除工具'
      }).then(function (ok) {
        if (!ok) return;
        deleteMcpToolFromHost(resolveMcpToolHostFromView(toolName), toolName);
        chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
        if (state.mcpListUi && state.mcpListUi.selectedToolName === toolName) {
          state.mcpListUi.selectedToolName = null;
          state.mcpListUi.inspectorOpen = false;
        }
        delete state.selectedMcpToolNames[toolName];
        patchMcpToolListSection(mcpContent);
        showToast('已删除: ' + toolName, 2500, 'success');
      });
    }
  });
}

function refreshMainPanelContent() {
  var bodyEl = state.mainPanel.querySelector('.ai-req-mcp-body');
  if (!bodyEl) return;

  if (state.mcpPanelTab === 'list' || state.mcpPanelTab === 'logs' || state.mcpPanelTab === 'localExports') {
    var oldMcp = bodyEl.querySelector('.ai-req-mcp-content');
    if (oldMcp) oldMcp.remove();
    var mcpContent = document.createElement('div');
    mcpContent.className = 'ai-req-mcp-content';
    if (state.mcpPanelTab === 'list') {
      mcpContent.innerHTML = buildMcpToolListHTML();
    } else if (state.mcpPanelTab === 'logs') {
      mcpContent.innerHTML = buildMcpLogListHTML();
    } else {
      mcpContent.innerHTML = buildMcpLocalExportsHTML();
    }
    bodyEl.appendChild(mcpContent);
    bindMcpContentEvents(mcpContent);
  } else {
    var mcpContent2 = bodyEl.querySelector('.ai-req-mcp-content');
    if (mcpContent2) mcpContent2.remove();
  }
}

function buildMcpToolListHTML() {
  ensureMcpListUi();
  var ui = state.mcpListUi;
  var collapsed = !!ui.toolbarCollapsed;
  var html = '';
  html += '<div class="ai-req-mcp-toolbar-wrap' + (collapsed ? ' ai-req-mcp-toolbar-collapsed' : '') + '">';
  html += '<div class="ai-req-mcp-collapse-bar">';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-toolbar-collapse-btn">';
  html += collapsed ? '\u5C55\u5F00\u5DE5\u5177\u680F' : '\u6536\u8D77\u5DE5\u5177\u680F';
  html += '</button>';
  html += '<span class="ai-req-mcp-toolbar-mini"></span>';
  html += '</div>';
  html += '<div class="ai-req-mcp-toolbar-expandable">';
  html += '<div class="ai-req-mcp-status-bar">';
  html += '<span class="ai-req-mcp-status-dot ai-req-mcp-status-dot-off"></span>';
  html += '<span class="ai-req-mcp-status-text">MCP \u25CB \u672A\u542F\u52A8</span>';
  html += '<button class="ai-req-mcp-start-btn">\u542F\u52A8</button>';
  html += '</div>';
  html += '<div class="ai-req-mcp-site-filter-row">';
  html += '<label class="ai-req-mcp-site-filter-label">\u7AD9\u70B9</label>';
  html += '<select class="ai-req-mcp-site-filter" aria-label="MCP \u5DE5\u5177\u6309\u7AD9\u70B9\u7B5B\u9009"></select>';
  html +=
    '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-exclude-current-btn">\u6392\u9664\u5F53\u524D\u9875</button>';
  html +=
    '<span class="ai-req-mcp-site-filter-hint">\u4E0B\u62C9\u663E\u793A\u5404\u7AD9\u5DE5\u5177\u6570\uFF1B\u300C\u6392\u9664\u5F53\u524D\u9875\u300D\u9690\u85CF\u5F53\u524D\u6807\u7B7E\u9875\u57DF\u540D\u5728\u5168\u5E93\u5408\u5E76\u4E2D\u7684\u5DE5\u5177\u3002</span>';
  html += '</div>';
  html += '<div class="ai-req-mcp-filter-row">';
  html += '<input type="search" class="ai-req-mcp-list-search" placeholder="\u641C\u7D22\u5DE5\u5177/\u63CF\u8FF0/path..." value="' + escapeHtml(ui.keyword || '') + '">';
  html += '<select class="ai-req-mcp-view-mode" aria-label="视图模式">';
  var vm = ui.viewMode || 'flowTree';
  html += '<option value="flowTree"' + (vm === 'flowTree' ? ' selected' : '') + '>\u6D41\u7A0B\u6811</option>';
  html += '<option value="flat"' + (vm === 'flat' ? ' selected' : '') + '>\u5E73\u94FA</option>';
  html += '</select>';
  html += '<span class="ai-req-mcp-group-select-wrap">';
  html += '<select class="ai-req-mcp-group-select">';
  var gm = ui.groupMode || 'none';
  html += '<option value="none"' + (gm === 'none' ? ' selected' : '') + '>\u5E73\u94FA</option>';
  html += '<option value="method"' + (gm === 'method' ? ' selected' : '') + '>\u6309\u65B9\u6CD5</option>';
  html += '<option value="risk"' + (gm === 'risk' ? ' selected' : '') + '>\u6309\u98CE\u9669</option>';
  html += '<option value="pathPrefix"' + (gm === 'pathPrefix' ? ' selected' : '') + '>\u6309\u8DEF\u5F84\u9996\u6BB5</option>';
  html += '<option value="flow"' + (gm === 'flow' ? ' selected' : '') + '>\u6309\u6D41\u7A0B</option>';
  html += '</select>';
  html += '</span>';
  var fe = ui.filterEnabled || 'all';
  html += '<button type="button" class="ai-req-mcp-fe-chip' + (fe === 'all' ? ' ai-req-chip-on' : '') + '" data-mcp-fe="all">\u5168\u90E8</button>';
  html += '<button type="button" class="ai-req-mcp-fe-chip' + (fe === 'on' ? ' ai-req-chip-on' : '') + '" data-mcp-fe="on">\u5DF2\u542F\u7528</button>';
  html += '<button type="button" class="ai-req-mcp-fe-chip' + (fe === 'off' ? ' ai-req-chip-on' : '') + '" data-mcp-fe="off">\u5DF2\u5173\u95ED</button>';
  var risks = ui.riskLevels || {};
  html += '<button type="button" class="ai-req-mcp-risk-chip' + (risks.low ? ' ai-req-chip-on' : '') + '" data-mcp-risk="low">low</button>';
  html += '<button type="button" class="ai-req-mcp-risk-chip' + (risks.medium ? ' ai-req-chip-on' : '') + '" data-mcp-risk="medium">med</button>';
  html += '<button type="button" class="ai-req-mcp-risk-chip' + (risks.high ? ' ai-req-chip-on' : '') + '" data-mcp-risk="high">high</button>';
  html += '</div>';
  html += '<div class="ai-req-mcp-bulk-actions">';
  html += '<button type="button" class="ai-req-btn ai-req-btn-primary ai-req-mcp-flow-create-btn">\u65B0\u5EFA\u6D41\u7A0B</button>';
  html += '<select class="ai-req-mcp-move-to-flow-select"><option value="">\u79FB\u52A8\u5230\u6D41\u7A0B...</option></select>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-move-to-flow-btn">\u79FB\u52A8</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-unassign-flow-btn">\u79FB\u51FA\u6D41\u7A0B</button>';
  html += '<input type="file" accept="application/json,.json" class="ai-req-mcp-import-file-input" tabindex="-1" aria-hidden="true">';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-exp-all">\u5168\u90E8\u5BFC\u51FA</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-exp-sel">\u5DF2\u9009\u5BFC\u51FA</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-imp-btn">\u5BFC\u5165...</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-sel-all">\u5168\u9009</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-sel-clear">\u6E05\u9009</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-primary ai-req-mcp-merge-selected">\u5408\u5E76\u5DF2\u9009</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-dedupe-tools">\u5220\u9664\u91CD\u590D\u5DE5\u5177</button>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-danger ai-req-mcp-del-selected">\u5220\u9664\u5DF2\u9009</button>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-workbench-split">';
  html += '<div class="ai-req-mcp-table-pane">';
  html += '<div class="ai-req-mcp-selection-strip" style="display:none"><span class="ai-req-mcp-sel-count">已选 0</span></div>';
  html += '<div class="ai-req-mcp-table-head">';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-cb"></span>';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-name">工具名</span>';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-host">来源</span>';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-method">方法</span>';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-path">路径</span>';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-risk">风险</span>';
  html += '<span class="ai-req-mcp-th ai-req-mcp-th-enabled">启用</span>';
  html += '</div>';
  html += '<div class="ai-req-mcp-tool-list">';
  html += buildMcpToolListInnerHTML();
  html += '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector" style="display:none">';
  html += '<div class="ai-req-mcp-inspector-header">';
  html += '<span class="ai-req-mcp-inspector-title">工具详情</span>';
  html += '<button type="button" class="ai-req-panel-btn ai-req-mcp-inspector-close-btn" title="关闭详情">\u2715</button>';
  html += '</div>';
  html += '<div class="ai-req-mcp-inspector-body"></div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-tab-bar">';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'list' ? ' active' : '') + '" data-mcp-tab="list">\u5DE5\u5177\u5217\u8868</button>';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'logs' ? ' active' : '') + '" data-mcp-tab="logs">\u8C03\u7528\u65E5\u5FD7</button>';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'localExports' ? ' active' : '') + '" data-mcp-tab="localExports">\u8BFB\u53D6\u672C\u5730\u5DE5\u5177\u5217\u8868</button>';
  html += '</div>';
  return html;
}

function buildMcpLocalExportsHTML() {
  var pathDisp = (state.config && state.config.mcpExportPath) ? state.config.mcpExportPath.trim() : '';
  var html = '';
  html += '<div class="ai-req-mcp-status-bar">';
  html += '<span class="ai-req-mcp-status-dot ai-req-mcp-status-dot-off"></span>';
  html += '<span class="ai-req-mcp-status-text">MCP \u25CB \u672A\u542F\u52A8</span>';
  html += '<button class="ai-req-mcp-start-btn">\u542F\u52A8</button>';
  html += '</div>';
  html += '<div class="ai-req-mcp-local-exports-panel">';
  html += '<div class="ai-req-mcp-local-path-row"><span class="ai-req-mcp-local-path-label">\u5BFC\u51FA\u76EE\u5F55\uFF1A</span> ';
  html += '<span class="ai-req-mcp-local-path-value">' +
    (pathDisp ? escapeHtml(pathDisp) : escapeHtml('\uFF08\u672A\u914D\u7F6E\uFF0C\u8BF7\u6253\u5F00\u8BBE\u7F6E\u586B\u5199 MCP \u5BFC\u51FA\u76EE\u5F55\uFF09')) +
    '</span></div>';
  html += '<p class="ai-req-mcp-local-hint">\u9700 MCP \u52A9\u624B\u5DF2\u8FDE\u63A5\uFF1B\u5217\u8868\u7531\u52A9\u624B\u8BFB\u53D6\u672C\u673A\u76EE\u5F55\u3002\u8DEF\u5F84\u5728\u300C\u914D\u7F6E\u300D\u4E2D\u4FEE\u6539\u3002</p>';
  html += '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-local-refresh">\u5237\u65B0\u5217\u8868</button>';
  html += '<div class="ai-req-mcp-local-export-list"><div class="ai-req-mcp-local-export-placeholder">\u70B9\u51FB\u300C\u5237\u65B0\u5217\u8868\u300D\u52A0\u8F7D\u5DF2\u5BFC\u51FA\u7684 JSON</div></div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-tab-bar">';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'list' ? ' active' : '') + '" data-mcp-tab="list">\u5DE5\u5177\u5217\u8868</button>';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'logs' ? ' active' : '') + '" data-mcp-tab="logs">\u8C03\u7528\u65E5\u5FD7</button>';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'localExports' ? ' active' : '') + '" data-mcp-tab="localExports">\u8BFB\u53D6\u672C\u5730\u5DE5\u5177\u5217\u8868</button>';
  html += '</div>';
  return html;
}

function buildMcpLogListHTML() {
  var html = '';
  html += '<div class="ai-req-mcp-status-bar">';
  html += '<span class="ai-req-mcp-status-dot ai-req-mcp-status-dot-off"></span>';
  html += '<span class="ai-req-mcp-status-text">MCP ○ 未启动</span>';
  html += '<button class="ai-req-mcp-start-btn">启动</button>';
  html += '</div>';
  html += '<div class="ai-req-mcp-workbench-split ai-req-mcp-log-split">';
  html += '<div class="ai-req-mcp-table-pane">';
  html += '<div class="ai-req-mcp-log-table-head">';
  html += '<span class="ai-req-mcp-th">时间</span>';
  html += '<span class="ai-req-mcp-th">工具</span>';
  html += '<span class="ai-req-mcp-th">状态</span>';
  html += '<span class="ai-req-mcp-th">耗时</span>';
  html += '<span class="ai-req-mcp-th">错误</span>';
  html += '</div>';
  html += '<div class="ai-req-mcp-log-list">';
  html += '<div class="ai-req-mcp-log-loading">加载中...</div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-log-inspector" style="display:none">';
  html += '<div class="ai-req-mcp-inspector-header">';
  html += '<span class="ai-req-mcp-log-inspector-title">日志详情</span>';
  html += '<button type="button" class="ai-req-panel-btn ai-req-mcp-log-inspector-close-btn" title="关闭">\u2715</button>';
  html += '</div>';
  html += '<div class="ai-req-mcp-log-inspector-body"></div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="ai-req-mcp-tab-bar">';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'list' ? ' active' : '') + '" data-mcp-tab="list">工具列表</button>';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'logs' ? ' active' : '') + '" data-mcp-tab="logs">调用日志</button>';
  html += '<button class="ai-req-mcp-tab' + (state.mcpPanelTab === 'localExports' ? ' active' : '') + '" data-mcp-tab="localExports">读取本地工具列表</button>';
  html += '</div>';
  return html;
}

function renderMcpLogInspector(mcpContent, logEntry) {
  if (!mcpContent) return;
  var body = mcpContent.querySelector('.ai-req-mcp-log-inspector-body');
  var titleEl = mcpContent.querySelector('.ai-req-mcp-log-inspector-title');
  var inspector = mcpContent.querySelector('.ai-req-mcp-log-inspector');
  if (!body || !inspector) return;
  if (!logEntry) {
    if (titleEl) titleEl.textContent = '日志详情';
    body.innerHTML = '<div class="ai-req-inspector-empty">选择一条日志查看详情</div>';
    inspector.style.display = 'none';
    return;
  }
  if (titleEl) titleEl.textContent = (logEntry.toolName || '未知工具') + ' · ' + String(logEntry.status || 0);
  var argsText = '';
  try {
    argsText = JSON.stringify(JSON.parse(logEntry.argsSummary || '{}'), null, 2);
  } catch (e) {
    argsText = logEntry.argsSummary || '';
  }
  var html = '';
  html += '<div class="ai-req-mcp-inspector-section"><div class="ai-req-detail-label">请求参数</div>';
  html += '<pre class="ai-req-mcp-log-detail-code">' + escapeHtml(argsText) + '</pre></div>';
  html += '<div class="ai-req-mcp-inspector-section"><div class="ai-req-detail-label">代理模式</div>';
  html += '<div class="ai-req-detail-value">' + escapeHtml(logEntry.proxyMode || '-') + '</div></div>';
  if (logEntry.error) {
    html += '<div class="ai-req-mcp-inspector-section"><div class="ai-req-detail-label">错误详情</div>';
    html += '<div class="ai-req-detail-value ai-req-log-error-text">' + escapeHtml(logEntry.error) + '</div></div>';
  }
  body.innerHTML = html;
  inspector.style.display = 'flex';
}

function syncMcpLogInspectorLayout(mcpContent) {
  if (!mcpContent) return;
  var split = mcpContent.querySelector('.ai-req-mcp-log-split');
  var inspector = mcpContent.querySelector('.ai-req-mcp-log-inspector');
  if (!split || !inspector) return;
  var open = inspector.style.display !== 'none';
  var isWide = state.ui && state.ui.layoutMode === 'wide';
  inspector.classList.toggle('ai-req-mcp-inspector-overlay', open && !isWide);
  split.classList.toggle('ai-req-mcp-split-has-inspector', open && isWide);
}

function refreshLocalExportsFileList(mcpContent) {
  var listEl = mcpContent.querySelector('.ai-req-mcp-local-export-list');
  if (!listEl) return;
  var dirPath = state.config && state.config.mcpExportPath ? String(state.config.mcpExportPath).trim() : '';
  if (!dirPath) {
    listEl.innerHTML =
      '<div class="ai-req-mcp-empty">\u8BF7\u5728\u914D\u7F6E\u4E2D\u586B\u5199 MCP \u5BFC\u51FA\u76EE\u5F55\uFF08\u672C\u673A\u7EDD\u5BF9\u8DEF\u5F84\uFF09</div>';
    return;
  }
  listEl.innerHTML = '<div class="ai-req-mcp-local-export-loading">\u52A0\u8F7D\u4E2D...</div>';
  chrome.runtime.sendMessage({ type: 'MCP_LIST_EXPORT_DIR', dirPath: dirPath }, function (res) {
    if (chrome.runtime.lastError) {
      listEl.innerHTML =
        '<div class="ai-req-mcp-empty">' + escapeHtml(chrome.runtime.lastError.message) + '</div>';
      return;
    }
    if (!res || !res.ok) {
      listEl.innerHTML =
        '<div class="ai-req-mcp-empty">' + escapeHtml((res && res.error) || '\u5931\u8D25') + '</div>';
      return;
    }
    var files = res.files || [];
    if (files.length === 0) {
      listEl.innerHTML = '<div class="ai-req-mcp-empty">\u76EE\u5F55\u4E2D\u65E0 .json \u6587\u4EF6</div>';
      return;
    }
    var html = '';
    html += '<div class="ai-req-mcp-local-table-head">';
    html += '<span class="ai-req-mcp-th">文件名</span>';
    html += '<span class="ai-req-mcp-th">修改时间</span>';
    html += '<span class="ai-req-mcp-th ai-req-mcp-th-actions">导入策略</span>';
    html += '</div>';
    var fi;
    for (fi = 0; fi < files.length; fi++) {
      var f = files[fi];
      var encName = encodeURIComponent(f.name);
      var dt = new Date(f.mtimeMs || 0);
      var timeStr =
        dt.getFullYear() +
        '-' +
        pad2(dt.getMonth() + 1) +
        '-' +
        pad2(dt.getDate()) +
        ' ' +
        pad2(dt.getHours()) +
        ':' +
        pad2(dt.getMinutes());
      html += '<div class="ai-req-mcp-local-file-row">';
      html += '<span class="ai-req-mcp-local-file-name">' + escapeHtml(f.name) + '</span>';
      html += '<span class="ai-req-mcp-local-file-mtime">' + escapeHtml(timeStr) + '</span>';
      html += '<span class="ai-req-mcp-local-file-actions">';
      html +=
        '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-local-imp-skip" data-local-import="merge-skip" data-file-name="' +
        encName +
        '">合并</button>';
      html +=
        '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-mcp-local-imp-ow" data-local-import="merge-overwrite" data-file-name="' +
        encName +
        '">覆盖</button>';
      html +=
        '<button type="button" class="ai-req-btn ai-req-btn-danger ai-req-mcp-local-imp-repl" data-local-import="replace" data-file-name="' +
        encName +
        '">清空导入</button>';
      html += '</span></div>';
    }
    listEl.innerHTML = html;
  });
}

function runLocalMcpExportImport(_mcpContent, fileName, mode) {
  var dirPath = state.config && state.config.mcpExportPath ? String(state.config.mcpExportPath).trim() : '';
  if (!dirPath || !fileName) {
    showToast('\u8DEF\u5F84\u6216\u6587\u4EF6\u540D\u65E0\u6548');
    return;
  }
  if (mode === 'replace') {
    confirmDangerAction({
      title: '清空并导入 MCP 工具',
      message: '将清空当前站点下全部 MCP 工具，再以文件「' + fileName + '」全量替换。现有工具配置不可恢复（可先导出备份）。',
      confirmLabel: '清空并导入'
    }).then(function (ok) {
      if (!ok) return;
      doLocalMcpImport(_mcpContent, fileName, mode, dirPath);
    });
    return;
  }
  doLocalMcpImport(_mcpContent, fileName, mode, dirPath);
}

function doLocalMcpImport(_mcpContent, fileName, mode, dirPath) {
  dirPath = dirPath || (state.config && state.config.mcpExportPath ? String(state.config.mcpExportPath).trim() : '');
  chrome.runtime.sendMessage(
    { type: 'MCP_READ_EXPORT_FILE', dirPath: dirPath, fileName: fileName },
    function (res) {
      if (chrome.runtime.lastError) {
        showToast(chrome.runtime.lastError.message);
        return;
      }
      if (!res || !res.ok) {
        showToast((res && res.error) || '\u8BFB\u53D6\u5931\u8D25');
        return;
      }
      var parsed;
      try {
        parsed = JSON.parse(res.text || '{}');
      } catch (eParse) {
        showToast('JSON \u89E3\u6790\u5931\u8D25');
        return;
      }
      var outcome;
      if (mode === 'merge-skip') {
        outcome = applyMcpToolsImport(parsed, 'merge', 'skip');
      } else if (mode === 'merge-overwrite') {
        outcome = applyMcpToolsImport(parsed, 'merge', 'overwrite');
      } else {
        outcome = applyMcpToolsImport(parsed, 'replace');
      }
      if (outcome && outcome.ok) {
        saveMcpTools();
        chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
        if (mode === 'replace') {
          state.selectedMcpToolNames = {};
        }
        showToast('\u5DF2\u5BFC\u5165 ' + outcome.imported + ' \u4E2A\u5DE5\u5177');
      } else {
        showToast((outcome && outcome.error) || '\u5BFC\u5165\u5931\u8D25');
      }
    }
  );
}

function bindLocalExportsPanelEvents(mcpContent) {
  var refreshBtn = mcpContent.querySelector('.ai-req-mcp-local-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshLocalExportsFileList(mcpContent);
    });
  }
  var listEl = mcpContent.querySelector('.ai-req-mcp-local-export-list');
  if (listEl) {
    listEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-local-import]');
      if (!btn) return;
      var mode = btn.getAttribute('data-local-import');
      var enc = btn.getAttribute('data-file-name');
      if (!enc || !mode) return;
      var fileName;
      try {
        fileName = decodeURIComponent(enc);
      } catch (eDec) {
        return;
      }
      runLocalMcpExportImport(mcpContent, fileName, mode);
    });
  }
  refreshLocalExportsFileList(mcpContent);
}

function bindMcpContentEvents(mcpContent) {
  if (!mcpContent || mcpContent._aiReqMcpContentBound) return;
  mcpContent._aiReqMcpContentBound = true;

  refreshMcpStatusBar(mcpContent);

  ensureMcpListUi();

  var collapseTb = mcpContent.querySelector('.ai-req-mcp-toolbar-collapse-btn');
  if (collapseTb) {
    collapseTb.addEventListener('click', function () {
      ensureMcpListUi();
      state.mcpListUi.toolbarCollapsed = !state.mcpListUi.toolbarCollapsed;
      refreshMainPanelContent();
    });
  }

  var siteFilterSel = mcpContent.querySelector('.ai-req-mcp-site-filter');
  if (siteFilterSel && state.mcpPanelTab === 'list') {
    siteFilterSel.addEventListener('change', function () {
      ensureMcpListUi();
      state.mcpListUi.siteFilter = siteFilterSel.value || 'all';
      patchMcpToolListSection(mcpContent);
    });
  }

  var exCurBtn = mcpContent.querySelector('.ai-req-mcp-exclude-current-btn');
  if (exCurBtn && state.mcpPanelTab === 'list') {
    exCurBtn.addEventListener('click', function () {
      ensureMcpListUi();
      if ((state.mcpListUi.siteFilter || 'all') === MCP_SITE_FILTER_EXCLUDE_CURRENT) {
        state.mcpListUi.siteFilter = 'all';
      } else {
        state.mcpListUi.siteFilter = MCP_SITE_FILTER_EXCLUDE_CURRENT;
      }
      patchMcpToolListSection(mcpContent);
    });
  }

  var mcpSearch = mcpContent.querySelector('.ai-req-mcp-list-search');
  if (mcpSearch) {
    mcpSearch.addEventListener('input', function () {
      ensureMcpListUi();
      state.mcpListUi.keyword = mcpSearch.value;
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var grpSel = mcpContent.querySelector('.ai-req-mcp-group-select');
  if (grpSel) {
    grpSel.addEventListener('change', function () {
      ensureMcpListUi();
      state.mcpListUi.groupMode = grpSel.value || 'none';
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var viewModeSel = mcpContent.querySelector('.ai-req-mcp-view-mode');
  if (viewModeSel) {
    viewModeSel.addEventListener('change', function () {
      ensureMcpListUi();
      state.mcpListUi.viewMode = viewModeSel.value || 'flowTree';
      scheduleSaveMcpListUiPrefs();
      syncMcpViewModeToolbar(mcpContent);
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var flowCreateBtn = mcpContent.querySelector('.ai-req-mcp-flow-create-btn');
  if (flowCreateBtn) {
    flowCreateBtn.addEventListener('click', function () {
      showCreateManualFlowModal(function (name, host) {
        var flow = createManualFlow(name, host);
        ensureMcpListUi();
        state.mcpListUi.selectedFlowId = flow.id;
        state.mcpListUi.selectedToolName = null;
        state.mcpListUi.inspectorOpen = true;
        delete state.mcpListUi.collapsedFlowIds[flow.id];
        refreshMcpToolListViewLocal(mcpContent);
        showToast('已创建流程: ' + flow.name, 2500, 'success');
      });
    });
  }

  var moveFlowBtn = mcpContent.querySelector('.ai-req-mcp-move-to-flow-btn');
  if (moveFlowBtn) {
    moveFlowBtn.addEventListener('click', function () {
      var names = getSelectedMcpToolNamesOrdered();
      if (!names.length) {
        showToast('请先勾选要移动的工具');
        return;
      }
      var sel = mcpContent.querySelector('.ai-req-mcp-move-to-flow-select');
      var targetId = sel && sel.value;
      if (!targetId) {
        showToast('请选择目标流程');
        return;
      }
      var result = assignToolsToFlow(names, targetId);
      if (!result.ok) {
        showToast('移动失败: ' + (result.error || 'unknown'), 3000, 'error');
        return;
      }
      if (result.rejected > 0) {
        showToast('已移动 ' + result.moved + ' 个，' + result.rejected + ' 个因站点不匹配跳过', 3000, 'warning');
      } else if (result.moved > 0) {
        showToast('已移动 ' + result.moved + ' 个工具', 2500, 'success');
      }
      state.selectedMcpToolNames = {};
      if (sel) sel.value = '';
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var unassignFlowBtn = mcpContent.querySelector('.ai-req-mcp-unassign-flow-btn');
  if (unassignFlowBtn) {
    unassignFlowBtn.addEventListener('click', function () {
      var names = getSelectedMcpToolNamesOrdered();
      if (!names.length) {
        showToast('请先勾选要移出的工具');
        return;
      }
      var result = unassignToolsFromFlow(names);
      state.selectedMcpToolNames = {};
      refreshMcpToolListViewLocal(mcpContent);
      showToast('已移出 ' + result.moved + ' 个工具', 2500, 'success');
    });
  }

  var feChips = mcpContent.querySelectorAll('.ai-req-mcp-fe-chip');
  var fc;
  for (fc = 0; fc < feChips.length; fc++) {
    feChips[fc].addEventListener('click', function () {
      ensureMcpListUi();
      var v = this.getAttribute('data-mcp-fe');
      state.mcpListUi.filterEnabled = v || 'all';
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var rkChips = mcpContent.querySelectorAll('.ai-req-mcp-risk-chip');
  for (fc = 0; fc < rkChips.length; fc++) {
    rkChips[fc].addEventListener('click', function () {
      ensureMcpListUi();
      var rk = this.getAttribute('data-mcp-risk');
      if (!state.mcpListUi.riskLevels) state.mcpListUi.riskLevels = {};
      state.mcpListUi.riskLevels[rk] = !state.mcpListUi.riskLevels[rk];
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var startBtn = mcpContent.querySelector('.ai-req-mcp-start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', function () {
      var btn = startBtn;
      if (btn.textContent === '\u542F\u52A8') {
        btn.disabled = true;
        applyMcpStatusBarState(mcpContent, { serverStarting: true });
        chrome.runtime.sendMessage({ type: 'MCP_START_HELPER', payload: { mcpPort: state.config.mcpPort || 9527 } }, function (resp) {
          btn.disabled = false;
          if (resp && resp.ok) {
            setTimeout(function () { refreshMcpStatusBar(mcpContent); }, 300);
          } else {
            var errMsg = (resp && (resp.error || resp.httpError || resp.helperError)) || '\u672A\u77E5\u9519\u8BEF';
            showToast('MCP \u542F\u52A8\u5931\u8D25: ' + errMsg, 3500, 'error');
            setTimeout(function () { refreshMcpStatusBar(mcpContent); }, 200);
          }
        });
      } else {
        chrome.runtime.sendMessage({ type: 'MCP_STOP_HELPER' }, function () {
          setTimeout(function () { refreshMcpStatusBar(mcpContent); }, 300);
        });
      }
    });
  }

  var tabs = mcpContent.querySelectorAll('.ai-req-mcp-tab');
  for (var ti = 0; ti < tabs.length; ti++) {
    tabs[ti].addEventListener('click', function () {
      var tab = this;
      var tabName = tab.getAttribute('data-mcp-tab');
      state.mcpPanelTab = tabName;
      refreshMainPanelContent();
    });
  }

  if (state.mcpPanelTab === 'list') {
    patchMcpToolListSection(mcpContent);
    var mcpCloseInsp = mcpContent.querySelector('.ai-req-mcp-inspector-close-btn');
    if (mcpCloseInsp && !mcpCloseInsp._bound) {
      mcpCloseInsp._bound = true;
      mcpCloseInsp.addEventListener('click', function (e) {
        e.stopPropagation();
        ensureMcpListUi();
        state.mcpListUi.inspectorOpen = false;
        syncMcpInspectorVisibility(mcpContent);
        refreshMcpToolListViewLocal(mcpContent);
      });
    }
  }

  var expAllBtn = mcpContent.querySelector('.ai-req-mcp-exp-all');
  if (expAllBtn) {
    expAllBtn.addEventListener('click', function () {
      var sanHead = confirm('\u5BFC\u51FA\u65F6\u5220\u9664 Authorization/Cookie \u7B49\u654F\u611F\u5934\uFF1F');
      var mapFull = getMcpListToolsMap();
      var pkgFull = buildMcpToolsExportPayload(mapFull, !!sanHead);
      var sfTag = state.mcpListUi.siteFilter || 'all';
      var fnameBase;
      if (sfTag === 'all') {
        fnameBase = 'mcp-tools_allmerged_' + mcpFmtDateTag();
      } else if (sfTag === MCP_SITE_FILTER_EXCLUDE_CURRENT) {
        fnameBase =
          'mcp-tools_exclude_' + mcpSafeFilenameSegment(location.hostname) + '_' + mcpFmtDateTag();
      } else {
        fnameBase = 'mcp-tools_' + mcpSafeFilenameSegment(sfTag) + '_' + mcpFmtDateTag();
      }
      exportMcpPkgToConfiguredDirOrDownload(pkgFull, fnameBase);
    });
  }

  var expSelBtn = mcpContent.querySelector('.ai-req-mcp-exp-sel');
  if (expSelBtn) {
    expSelBtn.addEventListener('click', function () {
      var snames = getSelectedMcpToolNamesOrdered();
      if (!snames.length) {
        showToast('\u5148\u52FE\u9009\u8981\u5BFC\u51FA\u7684\u5DE5\u5177');
        return;
      }
      var subset = {};
      var si;
      var tmSel = getMcpListToolsMap();
      for (si = 0; si < snames.length; si++) subset[snames[si]] = tmSel[snames[si]];
      var sanSel = confirm('\u8131\u654F\u5934\u90E8\u518D\u5BFC\u51FA\uFF1F');
      var pkgSel = buildMcpToolsExportPayload(subset, !!sanSel);
      var sfSel = state.mcpListUi.siteFilter || 'all';
      var selMid =
        sfSel === 'all'
          ? 'merged'
          : sfSel === MCP_SITE_FILTER_EXCLUDE_CURRENT
            ? 'exclude_' + mcpSafeFilenameSegment(location.hostname)
            : mcpSafeFilenameSegment(sfSel);
      var fnameSel = 'mcp-tools_sel_' + selMid + '_' + mcpFmtDateTag();
      exportMcpPkgToConfiguredDirOrDownload(pkgSel, fnameSel);
      showToast('\u5DF2\u9009 ' + snames.length + '\u4E2A\u5DE5\u5177');
    });
  }

  var impBtn = mcpContent.querySelector('.ai-req-mcp-imp-btn');
  var impInput = mcpContent.querySelector('.ai-req-mcp-import-file-input');
  if (impBtn && impInput) {
    impBtn.addEventListener('click', function () {
      impInput.click();
    });
    impInput.addEventListener('change', function () {
      var f = impInput.files && impInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function (evRf) {
        try {
          var parsedImp = JSON.parse(String(evRf.target.result || '{}'));
          var mergeFirst = confirm('确定 = 合并导入 | 取消 = 全量替换');
          if (mergeFirst) {
            var cmode = (prompt('同名: skip | overwrite | rename', 'skip') || 'skip').toLowerCase();
            if (['skip', 'overwrite', 'rename'].indexOf(cmode) === -1) cmode = 'skip';
            var outcomeMerge = applyMcpToolsImport(parsedImp, 'merge', cmode);
            finishFileImport(outcomeMerge);
          } else {
            confirmDangerAction({
              title: '全量替换 MCP 工具',
              message: '将用导入文件完全替换当前站点的 MCP 工具配置。现有工具不可恢复，建议先导出备份。',
              confirmLabel: '全量替换'
            }).then(function (ok) {
              if (!ok) return;
              finishFileImport(applyMcpToolsImport(parsedImp, 'replace'));
            });
          }
          function finishFileImport(outcome) {
            if (outcome && outcome.ok) {
              saveMcpTools();
              chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
              refreshMainPanelContent();
              showToast('导入成功 ' + (outcome.imported || ''), 2500, 'success');
            } else if (outcome && outcome.error !== 'cancelled') {
              showToast('导入失败: ' + outcome.error, 3000, 'error');
            }
          }
        } catch (eImp) {
          showToast('\u89E3\u6790\u5931\u8D25: ' + eImp.message);
        }
        impInput.value = '';
      };
      reader.readAsText(f, 'UTF-8');
    });
  }

  var selAllMc = mcpContent.querySelector('.ai-req-mcp-sel-all');
  if (selAllMc) {
    selAllMc.addEventListener('click', function () {
      if (!state.selectedMcpToolNames) state.selectedMcpToolNames = {};
      var vis = getFilteredSortedMcpToolNames();
      var vx;
      for (vx = 0; vx < vis.length; vx++) state.selectedMcpToolNames[vis[vx]] = true;
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var selClrMc = mcpContent.querySelector('.ai-req-mcp-sel-clear');
  if (selClrMc) {
    selClrMc.addEventListener('click', function () {
      state.selectedMcpToolNames = {};
      refreshMcpToolListViewLocal(mcpContent);
    });
  }

  var mergeBtn = mcpContent.querySelector('.ai-req-mcp-merge-selected');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', function () {
      var mnames = getSelectedMcpToolNamesOrdered();
      if (mnames.length < 2) {
        showToast('\u5408\u5E76\u81F3\u5C11\u9009\u4E24\u9879');
        return;
      }
      var hbMerge = (state.mcpViewDataset && state.mcpViewDataset.hostByTool) || {};
      var hostsSeen = {};
      var mi;
      for (mi = 0; mi < mnames.length; mi++) {
        var hhM = hbMerge[mnames[mi]];
        if (hhM) hostsSeen[hhM] = true;
      }
      var uh = Object.keys(hostsSeen);
      if (uh.length !== 1) {
        showToast(
          '\u5408\u5E76\u4EC5\u652F\u6301\u540C\u4E00\u7AD9\u70B9\u4E0B\u7684\u5DE5\u5177\uFF0C\u8BF7\u5207\u6362\u7AD9\u70B9\u7B5B\u9009\u6216\u53EA\u9009\u540C\u4E00\u57DF\u540D\u6765\u6E90\u7684\u9879'
        );
        return;
      }
      var targetHost = uh[0];
      var toolsObjMerge = loadToolsObjectForHostname(targetHost);
      var mobjs = [];
      for (mi = 0; mi < mnames.length; mi++) {
        if (toolsObjMerge[mnames[mi]]) mobjs.push(toolsObjMerge[mnames[mi]]);
      }
      try {
        var mergedToolDef = mergeMcpToolDefinitions(mobjs);
        for (mi = 0; mi < mnames.length; mi++) delete toolsObjMerge[mnames[mi]];
        state.selectedMcpToolNames = {};
        toolsObjMerge[mergedToolDef.name] = mergedToolDef;
        persistToolsObjectForHostname(targetHost, toolsObjMerge);
        chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
        patchMcpToolListSection(mcpContent);
        showToast('\u5DF2\u5408\u5E76\u4E3A ' + mergedToolDef.name);
      } catch (errM) {
        showToast('\u5408\u5E76\u5931\u8D25: ' + errM.message);
      }
    });
  }

  var dedupeMcBtn = mcpContent.querySelector('.ai-req-mcp-dedupe-tools');
  if (dedupeMcBtn) {
    dedupeMcBtn.addEventListener('click', function () {
      if (!confirm('\u6309\u8DEF\u5F84\u6A21\u677F/pathPatternKey \u6216 METHOD+pathname\u7B7E\u540D\u4FDD\u7559\u5B57\u5178\u5E8F\u9996\u4E2A\u5DE5\u5177\uFF0C\u5220\u9664\u5176\u4F59\u91CD\u590D\u9879\u3002\u786E\u5B9A\uFF1F')) return;
      var sfDed = state.mcpListUi.siteFilter || 'all';
      if (sfDed === 'all' || sfDed === MCP_SITE_FILTER_EXCLUDE_CURRENT) {
        showToast(
          '\u8BF7\u5148\u5728\u300C\u7AD9\u70B9\u300D\u4E2D\u9009\u62E9\u5177\u4F53\u57DF\u540D\uFF0C\u518D\u6267\u884C\u5220\u9664\u91CD\u590D\uFF08\u4EC5\u9488\u5BF9\u5355\u7AD9\u5B58\u50A8\uFF09'
        );
        return;
      }
      var nDed = removeDuplicateMcpToolsByConflictKeyForHostname(sfDed);
      chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
      patchMcpToolListSection(mcpContent);
      showToast(nDed ? '\u5DF2\u5220\u9664\u91CD\u590D ' + nDed + ' \u4E2A' : '\u65E0\u91CD\u590D\u5DE5\u5177');
    });
  }

  var delSelBtn = mcpContent.querySelector('.ai-req-mcp-del-selected');
  if (delSelBtn) {
    delSelBtn.addEventListener('click', function () {
      var dnm = getSelectedMcpToolNamesOrdered();
      if (!dnm.length) {
        showToast('请先勾选要删除的项目', 2500, 'info');
        return;
      }
      confirmDangerAction({
        title: '批量删除 MCP 工具',
        message: '将永久删除已选的 ' + dnm.length + ' 个工具。同步后 Cursor 侧不再可用，且不可撤销。',
        confirmLabel: '删除 ' + dnm.length + ' 个工具'
      }).then(function (ok) {
        if (!ok) return;
        var hbDel = (state.mcpViewDataset && state.mcpViewDataset.hostByTool) || {};
        var removed = 0;
        var dj;
        for (dj = 0; dj < dnm.length; dj++) {
          var tn = dnm[dj];
          var hh = hbDel[tn] || location.hostname;
          if (deleteMcpToolFromHost(hh, tn)) removed++;
        }
        state.selectedMcpToolNames = {};
        if (state.mcpListUi) {
          state.mcpListUi.selectedToolName = null;
          state.mcpListUi.inspectorOpen = false;
        }
        state.mcpViewDataset = null;
        chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' }, function () {
          patchMcpToolListSection(mcpContent);
          showToast(removed > 0 ? '已删除 ' + removed + ' 个工具' : '未删除任何工具', 2500, removed > 0 ? 'success' : 'warning');
        });
      });
    });
  }

  if (state.mcpPanelTab === 'logs') {
    var logCloseBtn = mcpContent.querySelector('.ai-req-mcp-log-inspector-close-btn');
    if (logCloseBtn && !logCloseBtn._bound) {
      logCloseBtn._bound = true;
      logCloseBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        renderMcpLogInspector(mcpContent, null);
        syncMcpLogInspectorLayout(mcpContent);
        var rows = mcpContent.querySelectorAll('.ai-req-mcp-log-row');
        for (var ri = 0; ri < rows.length; ri++) rows[ri].classList.remove('ai-req-mcp-row-selected');
      });
    }
    chrome.runtime.sendMessage({ type: 'MCP_GET_CALL_LOGS' }, function (resp) {
      var logs = (resp && resp.logs) || [];
      var logListEl = mcpContent.querySelector('.ai-req-mcp-log-list');
      var logHead = mcpContent.querySelector('.ai-req-mcp-log-table-head');
      if (!logListEl) return;
      logListEl.innerHTML = '';
      if (logs.length === 0) {
        if (logHead) logHead.style.display = 'none';
        logListEl.innerHTML = '<div class="ai-req-mcp-empty">暂无调用日志</div>';
        renderMcpLogInspector(mcpContent, null);
        return;
      }
      if (logHead) logHead.style.display = 'grid';
      for (var li = logs.length - 1; li >= 0; li--) {
        (function (logEntry, idx) {
          var date = new Date(logEntry.timestamp || Date.now());
          var timeStr = pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
          var logItem = document.createElement('div');
          logItem.className = 'ai-req-mcp-log-row';
          logItem.setAttribute('data-log-index', String(idx));
          logItem.innerHTML =
            '<span class="ai-req-mcp-log-time">' + escapeHtml(timeStr) + '</span>' +
            '<span class="ai-req-mcp-log-tool" title="' + escapeHtml(logEntry.toolName || '') + '">' + escapeHtml(logEntry.toolName || '') + '</span>' +
            '<span class="ai-req-mcp-log-status' + (logEntry.error ? ' error' : ' success') + '">' + escapeHtml(String(logEntry.status || 0)) + '</span>' +
            '<span class="ai-req-mcp-log-duration">' + escapeHtml(String(logEntry.duration || 0) + 'ms') + '</span>' +
            '<span class="ai-req-mcp-log-error">' + escapeHtml(logEntry.error || '-') + '</span>';
          logItem.addEventListener('click', function () {
            var rows = mcpContent.querySelectorAll('.ai-req-mcp-log-row');
            for (var ri = 0; ri < rows.length; ri++) {
              rows[ri].classList.toggle('ai-req-mcp-row-selected', rows[ri] === logItem);
            }
            renderMcpLogInspector(mcpContent, logEntry);
            syncMcpLogInspectorLayout(mcpContent);
          });
          logListEl.appendChild(logItem);
        })(logs[li], li);
      }
    });
  }

  if (state.mcpPanelTab === 'localExports') {
    bindLocalExportsPanelEvents(mcpContent);
  }

  if (state.mcpPanelTab === 'list' && typeof initMcpFlowDnD === 'function') {
    initMcpFlowDnD(mcpContent);
  }
}

function applyMcpStatusBarState(mcpContent, resp) {
  if (!mcpContent) return;
  var bars = mcpContent.querySelectorAll('.ai-req-mcp-status-bar');
  if (!bars.length) return;
  var bi;
  for (bi = 0; bi < bars.length; bi++) {
    var bar = bars[bi];
    var dotEl = bar.querySelector('.ai-req-mcp-status-dot');
    var textEl = bar.querySelector('.ai-req-mcp-status-text');
    var btnEl = bar.querySelector('.ai-req-mcp-start-btn');
    if (!dotEl || !textEl || !btnEl) continue;

    if (resp && resp.serverStarting) {
      dotEl.className = 'ai-req-mcp-status-dot ai-req-mcp-status-dot-warn';
      textEl.textContent = 'MCP \u25D0 \u542F\u52A8\u4E2D\u2026';
      btnEl.textContent = '\u542F\u52A8';
      btnEl.className = 'ai-req-mcp-start-btn';
      continue;
    }

    if (resp && resp.helperConnected && resp.httpReady) {
      var port = resp.serverPort || 9527;
      var mcpUrl = resp.mcpUrl || ('http://127.0.0.1:' + port + '/mcp');
      var tc = typeof resp.toolCount === 'number' ? resp.toolCount : 0;
      dotEl.className = 'ai-req-mcp-status-dot ai-req-mcp-status-dot-on';
      textEl.textContent = 'MCP \u25CF \u5DF2\u542F\u52A8 ' + mcpUrl + ' \u00B7 \u5DE5\u5177 ' + tc;
      btnEl.textContent = '\u505C\u6B62';
      btnEl.className = 'ai-req-mcp-start-btn ai-req-mcp-stop-btn';
    } else if (resp && resp.helperConnected && !resp.httpReady) {
      dotEl.className = 'ai-req-mcp-status-dot ai-req-mcp-status-dot-warn';
      textEl.textContent =
        'MCP \u25D0 Helper \u5DF2\u8FDE\u63A5\uFF0CHTTP \u672A\u5C31\u7EEA' +
        (resp.httpError ? '\uFF08' + resp.httpError + '\uFF09' : '');
      btnEl.textContent = '\u505C\u6B62';
      btnEl.className = 'ai-req-mcp-start-btn ai-req-mcp-stop-btn';
    } else {
      dotEl.className = 'ai-req-mcp-status-dot ai-req-mcp-status-dot-off';
      textEl.textContent =
        'MCP \u25CB \u672A\u542F\u52A8' + (resp && resp.helperError ? '\uFF08' + resp.helperError + '\uFF09' : '');
      btnEl.textContent = '\u542F\u52A8';
      btnEl.className = 'ai-req-mcp-start-btn';
    }
  }
}

function refreshMcpStatusBar(mcpContent) {
  if (!mcpContent) return;
  chrome.runtime.sendMessage({ type: 'MCP_GET_STATUS' }, function (resp) {
    applyMcpStatusBarState(mcpContent, resp || {});
  });
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function mcpFmtDateTag() {
  var d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

var MCP_EXPORT_NM_UTF8_SOFT_LIMIT = 1040000;

function exportMcpPkgToConfiguredDirOrDownload(pkg, filenameBase) {
  var dir = state.config && state.config.mcpExportPath ? String(state.config.mcpExportPath).trim() : '';
  var jsonText = JSON.stringify(pkg, null, 2);
  var byteLen = jsonText.length;
  try {
    if (typeof TextEncoder !== 'undefined') byteLen = new TextEncoder().encode(jsonText).length;
  } catch (eTe) {}

  function fallbackDownload(extraMsg) {
    downloadMcpPkgWithFilename(pkg, filenameBase);
    if (extraMsg) showToast(extraMsg);
  }

  if (!dir) {
    fallbackDownload('\u672A\u914D\u7F6E MCP \u5BFC\u51FA\u76EE\u5F55\uFF0C\u5DF2\u4F7F\u7528\u6D4F\u89C8\u5668\u4E0B\u8F7D\u5230\u9ED8\u8BA4\u6587\u4EF6\u5939');
    return;
  }

  if (byteLen > MCP_EXPORT_NM_UTF8_SOFT_LIMIT) {
    fallbackDownload(
      '\u5BFC\u51FA\u8FC7\u5927\uFF08Native Messaging \u9650\u5236 ~1MB\uFF09\uFF0C\u5DF2\u6539\u4E3A\u6D4F\u89C8\u5668\u4E0B\u8F7D'
    );
    return;
  }

  var baseName = /\.json$/i.test(filenameBase) ? filenameBase : filenameBase + '.json';

  chrome.runtime.sendMessage(
    {
      type: 'MCP_WRITE_EXPORT_FILE',
      dirPath: dir,
      fileName: baseName,
      text: jsonText
    },
    function (res) {
      if (chrome.runtime.lastError) {
        fallbackDownload('\u5199\u5165\u5931\u8D25\uFF0C\u5DF2\u6539\u4E3A\u4E0B\u8F7D\uFF1A' + chrome.runtime.lastError.message);
        return;
      }
      if (!res || !res.ok) {
        fallbackDownload(
          '\u5199\u5165\u914D\u7F6E\u76EE\u5F55\u5931\u8D25\uFF0C\u5DF2\u6539\u4E3A\u4E0B\u8F7D' +
            ((res && res.error) ? '\uFF1A' + res.error : '')
        );
        return;
      }
      showToast('\u5DF2\u5199\u5165\u914D\u7F6E\u76EE\u5F55\uFF1A' + baseName);
    }
  );
}

function downloadMcpPkgWithFilename(pkg, filenameBase) {
  var blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = /\.json$/i.test(filenameBase) ? filenameBase : filenameBase + '.json';
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 2500);
}

function getSelectedMcpToolNamesOrdered() {
  var outArr = [];
  var sm = state.selectedMcpToolNames || {};
  var tm = getMcpListToolsMap();
  var nm;
  for (nm in tm) {
    if (!Object.prototype.hasOwnProperty.call(tm, nm)) continue;
    if (isFlowContextSystemToolName(nm)) continue;
    if (sm[nm]) outArr.push(nm);
  }
  return outArr;
}
function openMcpToolEditor(toolName) {
  var editingHost = resolveMcpToolHostFromView(toolName);
  var toolsObj = loadToolsObjectForHostname(editingHost);
  var tool = toolsObj[toolName];
  if (!tool) return;

  var overlay = document.createElement('div');
  overlay.className = 'ai-req-mcp-editor-overlay';

  var modal = document.createElement('div');
  modal.className = 'ai-req-mcp-editor-modal';

  var titleEl = document.createElement('div');
  titleEl.className = 'ai-req-mcp-editor-title';
  titleEl.textContent = '\u7F16\u8F91 MCP \u5DE5\u5177';

  var body = document.createElement('div');
  body.className = 'ai-req-mcp-editor-body';

  var nameField = document.createElement('div');
  nameField.className = 'ai-req-mcp-editor-field';
  nameField.innerHTML = '<label class="ai-req-mcp-editor-label">\u540D\u79F0</label><input type="text" class="ai-req-mcp-editor-input ai-req-mcp-editor-name" value="' + escapeHtml(tool.name || toolName) + '">';

  var descField = document.createElement('div');
  descField.className = 'ai-req-mcp-editor-field';
  descField.innerHTML = '<label class="ai-req-mcp-editor-label">\u63CF\u8FF0</label><textarea class="ai-req-mcp-editor-textarea ai-req-mcp-editor-desc">' + escapeHtml(tool.description || '') + '</textarea>';

  var enabledField = document.createElement('div');
  enabledField.className = 'ai-req-mcp-editor-field';
  enabledField.innerHTML = '<label class="ai-req-mcp-editor-label">\u542F\u7528\u72B6\u6001</label><input type="checkbox" class="ai-req-mcp-editor-enabled"' + (tool.enabled !== false ? ' checked' : '') + '>';

  body.appendChild(nameField);
  body.appendChild(descField);
  body.appendChild(enabledField);

  var props = (tool.inputSchema && tool.inputSchema.properties) || {};
  var required = (tool.inputSchema && tool.inputSchema.required) || [];
  var propKeys = Object.keys(props);
  if (propKeys.length > 0) {
    var propSection = document.createElement('div');
    propSection.className = 'ai-req-mcp-editor-section';
    var propTitle = document.createElement('div');
    propTitle.className = 'ai-req-mcp-editor-section-title';
    propTitle.textContent = '\u53C2\u6570\u63CF\u8FF0';
    propSection.appendChild(propTitle);

    for (var pi = 0; pi < propKeys.length; pi++) {
      var pName = propKeys[pi];
      var pDef = props[pName];
      var pDesc = pDef.description || '';
      var pType = pDef.type || 'string';
      var isReq = required.indexOf(pName) !== -1;
      var pField = document.createElement('div');
      pField.className = 'ai-req-mcp-editor-field';
      var pHtml = '<label class="ai-req-mcp-editor-label">' + escapeHtml(pName) + ' <span class="ai-req-mcp-editor-type">(' + escapeHtml(pType) + ')</span></label>';
      pHtml += '<input type="text" class="ai-req-mcp-editor-input ai-req-mcp-editor-prop-desc" data-prop-name="' + escapeHtml(pName) + '" value="' + escapeHtml(pDesc) + '" placeholder="\u53C2\u6570\u63CF\u8FF0">';
      pHtml += '<label class="ai-req-mcp-editor-required-label"><input type="checkbox" class="ai-req-mcp-editor-prop-required" data-prop-name="' + escapeHtml(pName) + '"' + (isReq ? ' checked' : '') + '> Required</label>';
      pField.innerHTML = pHtml;
      propSection.appendChild(pField);
    }
    body.appendChild(propSection);
  }

  var actions = document.createElement('div');
  actions.className = 'ai-req-mcp-editor-actions';

  var saveBtn = document.createElement('button');
  saveBtn.className = 'ai-req-btn ai-req-btn-primary';
  saveBtn.textContent = '\u4FDD\u5B58';
  saveBtn.addEventListener('click', function () {
    var newName = modal.querySelector('.ai-req-mcp-editor-name').value.trim();
    var newDesc = modal.querySelector('.ai-req-mcp-editor-desc').value.trim();
    var newEnabled = modal.querySelector('.ai-req-mcp-editor-enabled').checked;

    tool.description = newDesc;
    tool.enabled = newEnabled;

    if (newName && newName !== toolName) {
      delete toolsObj[toolName];
      tool.name = newName;
      toolsObj[newName] = tool;
    }

    var propDescInputs = modal.querySelectorAll('.ai-req-mcp-editor-prop-desc');
    for (var pdi = 0; pdi < propDescInputs.length; pdi++) {
      var pn = propDescInputs[pdi].getAttribute('data-prop-name');
      var pdVal = propDescInputs[pdi].value.trim();
      if (tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties[pn]) {
        if (pdVal) {
          tool.inputSchema.properties[pn].description = pdVal;
        } else {
          delete tool.inputSchema.properties[pn].description;
        }
      }
    }

    var reqChecks = modal.querySelectorAll('.ai-req-mcp-editor-prop-required');
    var newRequired = [];
    for (var ri = 0; ri < reqChecks.length; ri++) {
      if (reqChecks[ri].checked) {
        newRequired.push(reqChecks[ri].getAttribute('data-prop-name'));
      }
    }
    if (tool.inputSchema) {
      tool.inputSchema.required = newRequired;
    }

    persistToolsObjectForHostname(editingHost, toolsObj);
    chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
    overlay.remove();
    refreshMainPanelContent();
    showToast('MCP \u5DE5\u5177\u5DF2\u4FDD\u5B58');
  });

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'ai-req-btn ai-req-btn-secondary';
  cancelBtn.textContent = '\u53D6\u6D88';
  cancelBtn.addEventListener('click', function () {
    overlay.remove();
  });

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  modal.appendChild(titleEl);
  modal.appendChild(body);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.remove();
  });

  safeAppendChild(overlay);
}

function openMcpToolTester(toolName) {
  var testerHost = resolveMcpToolHostFromView(toolName);
  var toolsObjTester = loadToolsObjectForHostname(testerHost);
  var tool = toolsObjTester[toolName];
  if (!tool) return;

  var overlay = document.createElement('div');
  overlay.className = 'ai-req-mcp-editor-overlay';

  var modal = document.createElement('div');
  modal.className = 'ai-req-mcp-editor-modal ai-req-mcp-tester-modal';

  var titleEl = document.createElement('div');
  titleEl.className = 'ai-req-mcp-editor-title';
  titleEl.textContent = '\u6D4B\u8BD5 MCP \u5DE5\u5177: ' + toolName;

  var body = document.createElement('div');
  body.className = 'ai-req-mcp-editor-body';

  var props = (tool.inputSchema && tool.inputSchema.properties) || {};
  var required = (tool.inputSchema && tool.inputSchema.required) || [];
  var propKeys = Object.keys(props);

  if (propKeys.length === 0) {
    var noParam = document.createElement('div');
    noParam.className = 'ai-req-mcp-empty';
    noParam.textContent = '\u8BE5\u5DE5\u5177\u65E0\u53C2\u6570';
    body.appendChild(noParam);
  }

  for (var pi = 0; pi < propKeys.length; pi++) {
    var pName = propKeys[pi];
    var pDef = props[pName];
    var pType = pDef.type || 'string';
    var pDesc = pDef.description || '';
    var isReq = required.indexOf(pName) !== -1;

    var pField = document.createElement('div');
    pField.className = 'ai-req-mcp-editor-field';

    var label = document.createElement('label');
    label.className = 'ai-req-mcp-editor-label';
    label.textContent = pName + ' (' + pType + ')' + (isReq ? ' *' : '');

    var input;
    if (pType === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'ai-req-mcp-tester-input ai-req-mcp-tester-param';
    } else if (pType === 'number' || pType === 'integer') {
      input = document.createElement('input');
      input.type = 'number';
      input.className = 'ai-req-mcp-editor-input ai-req-mcp-tester-param';
    } else if (pType === 'object' || pType === 'array') {
      input = document.createElement('textarea');
      input.className = 'ai-req-mcp-editor-textarea ai-req-mcp-tester-param';
      input.placeholder = '\u8F93\u5165 JSON ' + pType;
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'ai-req-mcp-editor-input ai-req-mcp-tester-param';
      if (pDef.enum && pDef.enum.length > 0) {
        input.placeholder = '\u53EF\u9009\u503C: ' + pDef.enum.join(', ');
      }
    }
    input.setAttribute('data-param-name', pName);
    input.setAttribute('data-param-type', pType);

    if (pDesc) {
      var descHint = document.createElement('div');
      descHint.className = 'ai-req-mcp-editor-hint';
      descHint.textContent = pDesc;
      pField.appendChild(label);
      pField.appendChild(descHint);
    } else {
      pField.appendChild(label);
    }
    pField.appendChild(input);
    body.appendChild(pField);
  }

  var resultArea = document.createElement('div');
  resultArea.className = 'ai-req-mcp-tester-result';
  resultArea.style.display = 'none';

  var actions = document.createElement('div');
  actions.className = 'ai-req-mcp-editor-actions';

  var execBtn = document.createElement('button');
  execBtn.className = 'ai-req-btn ai-req-btn-primary';
  execBtn.textContent = '\u6267\u884C';
  execBtn.addEventListener('click', function () {
    var args = {};
    var paramInputs = modal.querySelectorAll('.ai-req-mcp-tester-param');
    for (var ai = 0; ai < paramInputs.length; ai++) {
      var pInput = paramInputs[ai];
      var pN = pInput.getAttribute('data-param-name');
      var pT = pInput.getAttribute('data-param-type');
      var val;
      if (pT === 'boolean') {
        val = pInput.checked;
      } else if (pT === 'number' || pT === 'integer') {
        val = pInput.value.trim() !== '' ? Number(pInput.value) : undefined;
      } else if (pT === 'object' || pT === 'array') {
        var rawText = pInput.value.trim();
        if (rawText) {
          try {
            val = JSON.parse(rawText);
          } catch (e) {
            resultArea.style.display = 'block';
            resultArea.innerHTML = '<div class="ai-req-mcp-tester-error">\u53C2\u6570 ' + escapeHtml(pN) + ' JSON \u89E3\u6790\u5931\u8D25: ' + escapeHtml(e.message) + '</div>';
            return;
          }
        }
      } else {
        val = pInput.value;
      }
      if (val !== undefined) args[pN] = val;
    }

    execBtn.disabled = true;
    execBtn.textContent = '\u6267\u884C\u4E2D...';

    chrome.runtime.sendMessage({ type: 'MCP_TOOL_TEST', toolName: toolName, arguments: args }, function (resp) {
      execBtn.disabled = false;
      execBtn.textContent = '\u6267\u884C';
      resultArea.style.display = 'block';
      if (resp && resp.ok) {
        updateMcpToolUsability(toolName, {
          verified: true,
          tested: resp.status >= 200 && resp.status < 300,
          lastTestAt: Date.now(),
          lastStatus: resp.status || 0,
          lastError: resp.status >= 200 && resp.status < 300 ? '' : ('HTTP ' + (resp.status || 0))
        }, resolveMcpToolHostFromView(toolName));
        var statusClass = resp.status >= 200 && resp.status < 300 ? 'ai-req-mcp-tester-success' : 'ai-req-mcp-tester-warn';
        resultArea.innerHTML = '<div class="ai-req-mcp-tester-status ' + statusClass + '">\u72B6\u6001\u7801: ' + (resp.status || 0) + '</div>';
        var resultPre = document.createElement('pre');
        resultPre.className = 'ai-req-mcp-tester-body';
        try {
          resultPre.textContent = JSON.stringify(resp.body, null, 2);
        } catch (e2) {
          resultPre.textContent = String(resp.body);
        }
        resultArea.appendChild(resultPre);
      } else {
        updateMcpToolUsability(toolName, {
          verified: true,
          tested: false,
          lastTestAt: Date.now(),
          lastStatus: 0,
          lastError: (resp && resp.error) || '未知错误'
        }, resolveMcpToolHostFromView(toolName));
        resultArea.innerHTML = '<div class="ai-req-mcp-tester-error">\u8BF7\u6C42\u5931\u8D25: ' + escapeHtml((resp && resp.error) || '\u672A\u77E5\u9519\u8BEF') + '</div>';
      }
      var mcpContent = state.mainPanel ? state.mainPanel.querySelector('.ai-req-mcp-content') : null;
      if (mcpContent) renderMcpToolInspector(mcpContent, toolName);
    });
  });

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'ai-req-btn ai-req-btn-secondary';
  cancelBtn.textContent = '\u5173\u95ED';
  cancelBtn.addEventListener('click', function () {
    overlay.remove();
  });

  actions.appendChild(execBtn);
  actions.appendChild(cancelBtn);

  modal.appendChild(titleEl);
  modal.appendChild(body);
  modal.appendChild(resultArea);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.remove();
  });

  safeAppendChild(overlay);
}
