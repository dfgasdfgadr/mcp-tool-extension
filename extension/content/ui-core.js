function injectStyles() {
  /* Styles loaded via manifest content_scripts css: content/content.css */
}

function startDomGuard() {
  if (state.domGuardStarted) return;
  state.domGuardStarted = true;
  setInterval(function () {
    if (!state.extensionEnabled || !state.uiBootstrapped) return;
    if (state.floatingBall && !document.contains(state.floatingBall)) {
      try { getContainer().appendChild(state.floatingBall); } catch (e) {}
    }
    if (state.mainPanel && !document.contains(state.mainPanel)) {
      try { getContainer().appendChild(state.mainPanel); } catch (e2) {}
    }
    if (state.recordingTrayEl && !document.contains(state.recordingTrayEl)) {
      try { getContainer().appendChild(state.recordingTrayEl); } catch (e3) {}
    }
    ensureElementInViewport(state.floatingBall, 56, 56, '20px', '20px');
    ensureElementInViewport(state.mainPanel, 420, 620, '90px', '20px');
    ensureElementInViewport(state.recordingTrayEl, 260, 112, '20px', '20px');
  }, 2000);
}

function showExtensionUi() {
  if (state.floatingBall) state.floatingBall.style.display = 'flex';
  if (state.mainPanel && state.isPanelOpen) state.mainPanel.style.display = 'flex';
  if (state.recordingTrayEl && state.recordingTrayVisible) {
    state.recordingTrayEl.style.display = 'flex';
  }
}

function hideExtensionUi() {
  state.isPanelOpen = false;
  if (state.floatingBall) state.floatingBall.style.display = 'none';
  if (state.mainPanel) state.mainPanel.style.display = 'none';
  if (state.configPanel) state.configPanel.style.display = 'none';
  if (state.jsonEditor) state.jsonEditor.style.display = 'none';
  if (state.rewriteEditor) state.rewriteEditor.style.display = 'none';
  if (state.recordingTrayEl) state.recordingTrayEl.style.display = 'none';
}

function bootstrapExtensionUi() {
  if (state.uiBootstrapped) {
    showExtensionUi();
    return;
  }
  injectStyles();
  createFloatingBall();
  createMainPanel();
  createConfigPanel();
  createJsonEditor();
  createRewriteEditor();
  setupPageSelectionProvenance();
  startDomGuard();
  state.uiBootstrapped = true;
  state.uiReady = true;
  if (typeof applyRecordingTrayUiIfNeeded === 'function') {
    applyRecordingTrayUiIfNeeded();
  }
  showExtensionUi();
}

function createFloatingBall() {
  var ball = document.createElement('div');
  ball.className = 'ai-req-floating-ball';

  ball.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

  var savedPos = storageGet(getScopedStorageKey('ai_req_ball_position'), null);
  if (savedPos) {
    try {
      var pos = clampPosition(JSON.parse(savedPos), 56, 56);
      ball.style.left = pos.left + 'px';
      ball.style.top = pos.top + 'px';
    } catch (e) {
      ball.style.right = '20px';
      ball.style.bottom = '20px';
    }
  } else {
    ball.style.right = '20px';
    ball.style.bottom = '20px';
  }

  var isDragging = false;
  var startX, startY, startLeft, startTop;
  var hasMoved = false;

  ball.addEventListener('mousedown', function (e) {
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    var rect = ball.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
    ball.style.left = startLeft + 'px';
    ball.style.top = startTop + 'px';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
    }
    var newLeft = Math.max(0, Math.min(window.innerWidth - 56, startLeft + dx));
    var newTop = Math.max(0, Math.min(window.innerHeight - 56, startTop + dy));
    ball.style.left = newLeft + 'px';
    ball.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (!isDragging) return;
    isDragging = false;
    if (hasMoved) {
      storageSet(getScopedStorageKey('ai_req_ball_position'), JSON.stringify({
        left: parseInt(ball.style.left),
        top: parseInt(ball.style.top)
      }));
    } else {
      toggleMainPanel();
    }
  });

  safeAppendChild(ball);
  state.floatingBall = ball;
}

function toggleMainPanel() {
  if (state.flowRecording && state.recordingTrayVisible) {
    openMainPanelForFlowRecording();
    return;
  }
  state.isPanelOpen = !state.isPanelOpen;
  if (state.isPanelOpen) {
    state.mainPanel.style.display = 'flex';
    refreshMainWorkbench();
  } else {
    state.mainPanel.style.display = 'none';
  }
}

function capturePanelScroll(selector) {
  if (!state.mainPanel) return 0;
  var el = state.mainPanel.querySelector(selector);
  return el ? el.scrollTop : 0;
}

function restorePanelScroll(selector, scrollTop) {
  if (!state.mainPanel) return;
  var el = state.mainPanel.querySelector(selector);
  if (el) el.scrollTop = scrollTop;
}

function syncRequestSelectionChrome() {
  if (!state.mainPanel) return;
  var bulkBarOuter = state.mainPanel.querySelector('.ai-req-req-bulk-bar');
  if (bulkBarOuter) {
    var bn = selectionCountRequests();
    bulkBarOuter.style.display = bn > 0 ? 'flex' : 'none';
    var spn = bulkBarOuter.querySelector('.ai-req-req-bulk-count');
    if (spn) spn.textContent = '已选 ' + bn;
  }
}

function updateRecordingTrayContent(flowName) {
  var tray = state.recordingTrayEl;
  if (!tray) return;
  var nameEl = tray.querySelector('.ai-req-recording-tray-name');
  if (nameEl) nameEl.textContent = flowName || '未命名流程';
}

function ensureRecordingTray() {
  if (state.recordingTrayEl && document.contains(state.recordingTrayEl)) {
    return state.recordingTrayEl;
  }
  var tray = document.createElement('div');
  tray.className = 'ai-req-recording-tray';
  tray.innerHTML =
    '<div class="ai-req-recording-tray-indicator"><span class="ai-req-recording-tray-dot"></span><span class="ai-req-recording-tray-status">正在录制</span></div>' +
    '<div class="ai-req-recording-tray-name"></div>' +
    '<div class="ai-req-recording-tray-actions">' +
    '  <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-recording-tray-open">打开面板</button>' +
    '  <button type="button" class="ai-req-btn ai-req-btn-danger ai-req-recording-tray-stop">结束录制</button>' +
    '</div>';
  var openBtn = tray.querySelector('.ai-req-recording-tray-open');
  var stopBtn = tray.querySelector('.ai-req-recording-tray-stop');
  if (openBtn) {
    openBtn.addEventListener('click', function () {
      openMainPanelForFlowRecording();
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      stopFlowRecordingFromTray(true);
    });
  }
  safeAppendChild(tray);
  state.recordingTrayEl = tray;
  return tray;
}

function enterFlowRecordingTrayMode(flow) {
  state.recordingTrayVisible = true;
  var tray = ensureRecordingTray();
  updateRecordingTrayContent(flow && flow.name);
  tray.style.display = 'flex';
  if (state.mainPanel) state.mainPanel.style.display = 'none';
  state.isPanelOpen = false;
  if (state.floatingBall) state.floatingBall.style.display = 'none';
}

function applyRecordingTrayUiIfNeeded() {
  if (!state.flowRecording) return false;
  var flow = typeof getActiveFlow === 'function' ? getActiveFlow() : null;
  if (!flow && state.activeFlowId && state.flows && state.flows[state.activeFlowId]) {
    flow = state.flows[state.activeFlowId];
  }
  if (!flow && state.activeFlowId) {
    flow = { id: state.activeFlowId, name: '录制中' };
  }
  if (!flow) return false;
  if (state.uiReady || state.floatingBall || state.mainPanel || state.recordingTrayEl) {
    enterFlowRecordingTrayMode(flow);
    return true;
  }
  state.recordingTrayVisible = true;
  return false;
}

function hideRecordingTray() {
  state.recordingTrayVisible = false;
  if (state.recordingTrayEl) state.recordingTrayEl.style.display = 'none';
  if (state.floatingBall) state.floatingBall.style.display = 'flex';
}

function openMainPanelForFlowRecording() {
  ensureMainUiState();
  state.ui.activeMainTab = 'flow';
  state.isPanelOpen = true;
  if (state.mainPanel) {
    state.mainPanel.style.display = 'flex';
    state.mainPanel.setAttribute('data-ai-req-tab', 'flow');
  }
  refreshMainWorkbench();
}

function mountConfirmOverlay(overlay) {
  var hasBlockingOverlay = !!document.querySelector('.ai-req-provenance-overlay');
  if (
    state.mainPanel &&
    state.mainPanel.parentNode &&
    state.isPanelOpen &&
    !hasBlockingOverlay
  ) {
    state.mainPanel.appendChild(overlay);
    return;
  }
  safeAppendChild(overlay);
}

function showFlowMcpResultDialog(flow) {
  var existing = document.querySelector('.ai-req-flow-mcp-result-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'ai-req-confirm-overlay ai-req-flow-mcp-result-overlay';
  var modal = document.createElement('div');
  modal.className = 'ai-req-confirm-modal ai-req-flow-mcp-result-modal';
  var title = document.createElement('div');
  title.className = 'ai-req-confirm-title';
  title.textContent = '录制完成';
  var body = document.createElement('div');
  body.className = 'ai-req-confirm-body';
  var verified = (flow.verifiedRequestIds || []).length;
  body.textContent =
    '流程「' +
    (flow.name || '未命名流程') +
    '」已结束。已验证请求 ' +
    verified +
    ' 个。可立即从已验证请求生成并查看 MCP 工具；或留在流程页确认分类/验证后，再点击「同步到 MCP」生成。';
  var actions = document.createElement('div');
  actions.className = 'ai-req-confirm-actions ai-req-flow-mcp-result-actions';
  var viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'ai-req-btn ai-req-btn-primary';
  viewBtn.textContent = '查看 MCP 工具';
  viewBtn.addEventListener('click', function () {
    overlay.remove();
    var stats = { added: 0, skipped: 0, linked: 0 };
    if (typeof generateMcpToolsFromFlow === 'function') {
      stats = generateMcpToolsFromFlow(flow) || stats;
    }
    ensureMainUiState();
    state.ui.activeMainTab = 'mcp';
    state.mcpPanelTab = 'list';
    state.isPanelOpen = true;
    if (state.mainPanel) state.mainPanel.style.display = 'flex';
    refreshMainWorkbench();
    if (stats.added > 0 || stats.linked > 0) {
      showToast('MCP 已同步：新增 ' + stats.added + '，关联 ' + (stats.linked || 0), 2500, 'success');
    } else if (stats.skipped > 0) {
      showToast('MCP 工具已更新并同步（' + stats.skipped + ' 个已存在）', 2500, 'success');
    } else if (verified === 0) {
      showToast('暂无已验证请求，未生成新工具', 2500, 'warn');
    }
  });
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-req-btn ai-req-btn-secondary';
  closeBtn.textContent = '留在 Flow 确认';
  closeBtn.addEventListener('click', function () {
    overlay.remove();
    ensureMainUiState();
    state.ui.activeMainTab = 'flow';
    refreshMainWorkbench();
  });
  actions.appendChild(viewBtn);
  actions.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(body);
  modal.appendChild(actions);
  modal.addEventListener('click', function (e) {
    e.stopPropagation();
  });
  overlay.appendChild(modal);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.remove();
  });
  mountConfirmOverlay(overlay);
  requestAnimationFrame(function () {
    if (viewBtn && viewBtn.focus) viewBtn.focus();
  });
}

function finishFlowRecordingCommon(openMcpAfter) {
  var flowId = state.activeFlowId || (state.flowUi && state.flowUi.selectedFlowId);
  var flow = finishFlow(flowId);
  if (flow) {
    pruneEmptyFlowSteps(flow);
    saveFlows();
  }
  hideRecordingTray();
  if (!flow) {
    refreshFlowWorkbench();
    return null;
  }
  state.flowUi.selectedFlowId = flow.id;
  ensureMainUiState();
  state.ui.activeMainTab = 'flow';
  state.isPanelOpen = true;
  if (state.mainPanel) {
    state.mainPanel.style.display = 'flex';
    state.mainPanel.setAttribute('data-ai-req-tab', 'flow');
  }
  refreshMainWorkbench();
  if (openMcpAfter) {
    requestAnimationFrame(function () {
      showFlowMcpResultDialog(flow);
    });
  }
  return flow;
}

function stopFlowRecordingFromTray(openMcpAfter) {
  finishFlowRecordingCommon(!!openMcpAfter);
  showToast('流程录制已结束', 2500, 'success');
}

function handleFlowClassificationChange(flow, reqId, cls) {
  if (!flow || !reqId) return;
  applyFlowClassificationToRequest(flow, reqId, cls || 'unknown', 'manual');
  saveFlows();
}

function handleFlowVerifiedChange(flow, reqId, checked) {
  if (!flow || !reqId) return;
  setFlowRequestVerified(flow, reqId, !!checked, 'manual');
  saveFlows();
}

function patchFlowRequestRowUi(pane, flow, reqId) {
  if (!pane || !flow || !reqId) return;
  var row = pane.querySelector('.ai-req-flow-request[data-req-id="' + reqId + '"]');
  if (!row) return;
  var cls = (flow.classifications && flow.classifications[reqId]) || 'unknown';
  var verified = flow.verifiedRequestIds && flow.verifiedRequestIds.indexOf(reqId) !== -1;
  var sel = row.querySelector('.ai-req-flow-class-select');
  if (sel) sel.value = cls;
  var cb = row.querySelector('.ai-req-flow-verified-cb');
  if (cb) cb.checked = verified;
}

function patchFlowSummaryUi(pane, flow) {
  if (!pane || !flow) return;
  var summaryLine = pane.querySelector('.ai-req-flow-summary > div:last-child');
  if (summaryLine) {
    var stepCount = typeof countFlowStepsWithRequests === 'function'
      ? countFlowStepsWithRequests(flow)
      : (flow.steps || []).length;
    var verifiedCount = (flow.verifiedRequestIds || []).length;
    summaryLine.textContent =
      '步骤 ' +
      stepCount +
      ' · 已验证请求 ' +
      verifiedCount +
      (state.activeFlowId === flow.id && state.flowRecording ? ' · 录制中' : '');
  }
}

var PANEL_LAYOUT_STORAGE_KEY = 'ai_req_panel_layout_mode';

function ensureMainUiState() {
  if (!state.ui || typeof state.ui !== 'object') state.ui = {};
  if (!state.ui.activeMainTab) state.ui.activeMainTab = 'requests';
  if (typeof state.ui.requestKeyword !== 'string') state.ui.requestKeyword = '';
  if (!state.ui.layoutMode) {
    var savedLayout = storageGet(getScopedStorageKey(PANEL_LAYOUT_STORAGE_KEY), null);
    state.ui.layoutMode = savedLayout === 'wide' ? 'wide' : 'compact';
  }
  if (!state.ui.requestTable || typeof state.ui.requestTable !== 'object') {
    state.ui.requestTable = {};
  }
  if (state.ui.requestTable.selectedId == null && state.expandedReqId) {
    state.ui.requestTable.selectedId = state.expandedReqId;
    state.ui.requestTable.detailOpen = true;
  }
  if (typeof state.ui.requestTable.detailOpen !== 'boolean') {
    state.ui.requestTable.detailOpen = !!state.ui.requestTable.selectedId;
  }
}

function extractRequestPath(url) {
  try {
    var u = new URL(url);
    return u.pathname + (u.search || '');
  } catch (e) {
    return url || '';
  }
}

function countDuplicateRequests(records) {
  var mp = duplicateSignatureCounts(records || []);
  var dup = 0;
  for (var i = 0; i < (records || []).length; i++) {
    var sig = computeRequestSignature(records[i]);
    if ((mp[sig] || 0) > 1) dup++;
  }
  return dup;
}

function syncRequestInspectorVisibility() {
  if (!state.mainPanel) return;
  ensureMainUiState();
  var panel = state.mainPanel;
  var inspector = panel.querySelector('.ai-req-request-inspector');
  var split = panel.querySelector('.ai-req-request-split');
  if (!inspector || !split) return;
  var selId = state.ui.requestTable.selectedId;
  var open = !!state.ui.requestTable.detailOpen && !!selId;
  var isWide = state.ui.layoutMode === 'wide';
  split.setAttribute('data-inspector-open', open ? '1' : '0');
  split.setAttribute('data-has-selection', selId ? '1' : '0');
  inspector.style.display = open ? 'flex' : 'none';
  inspector.classList.toggle('ai-req-inspector-overlay', open && !isWide);
  split.classList.toggle('ai-req-split-has-inspector', open && isWide);
}

function restorePanelCompactPosition(panel) {
  var savedPos = storageGet(getScopedStorageKey('ai_req_panel_position'), null);
  if (savedPos) {
    try {
      var pos = clampPosition(JSON.parse(savedPos), 420, 620);
      panel.style.left = pos.left + 'px';
      panel.style.top = pos.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      return;
    } catch (e) {}
  }
  panel.style.left = 'auto';
  panel.style.right = '90px';
  panel.style.top = 'auto';
  panel.style.bottom = '20px';
}

function applyPanelLayoutMode(panel) {
  if (!panel) panel = state.mainPanel;
  if (!panel) return;
  ensureMainUiState();
  var mode = state.ui.layoutMode === 'wide' ? 'wide' : 'compact';
  panel.setAttribute('data-ai-req-layout', mode);
  var layoutBtn = panel.querySelector('.ai-req-layout-toggle-btn');
  if (layoutBtn) {
    layoutBtn.title = mode === 'wide' ? '切换紧凑浮层' : '切换宽屏工作台';
    layoutBtn.setAttribute('aria-pressed', mode === 'wide' ? 'true' : 'false');
    layoutBtn.textContent = mode === 'wide' ? '\u229F' : '\u2922';
  }
  if (mode === 'wide') {
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = '50%';
    panel.style.top = '50%';
    panel.style.transform = 'translate(-50%, -50%)';
    if (state.ui.requestTable && state.ui.requestTable.selectedId) {
      state.ui.requestTable.detailOpen = true;
    }
  } else {
    panel.style.transform = '';
    restorePanelCompactPosition(panel);
  }
  syncRequestInspectorVisibility();
  var mcpContent = panel.querySelector('.ai-req-mcp-content');
  if (mcpContent && typeof syncMcpInspectorVisibility === 'function') {
    if (mode === 'wide' && state.mcpListUi && state.mcpListUi.selectedToolName) {
      state.mcpListUi.inspectorOpen = true;
    }
    syncMcpInspectorVisibility(mcpContent);
  }
  if (mcpContent && typeof syncMcpLogInspectorLayout === 'function') {
    syncMcpLogInspectorLayout(mcpContent);
  }
}

function togglePanelLayoutMode() {
  ensureMainUiState();
  state.ui.layoutMode = state.ui.layoutMode === 'wide' ? 'compact' : 'wide';
  storageSet(getScopedStorageKey(PANEL_LAYOUT_STORAGE_KEY), state.ui.layoutMode);
  applyPanelLayoutMode();
}

function syncShellChrome() {
  if (!state.mainPanel) return;
  var panel = state.mainPanel;
  var hostEl = panel.querySelector('.ai-req-shell-host');
  if (hostEl) {
    hostEl.textContent = typeof location !== 'undefined' ? location.hostname : '';
  }
  var reqEl = panel.querySelector('.ai-req-shell-req-count');
  if (reqEl) {
    var records = state.requestRecords || [];
    var analyzed = 0;
    for (var ri = 0; ri < records.length; ri++) {
      if (records[ri].aiAnalysis) analyzed++;
    }
    reqEl.textContent = records.length + ' 请求' + (analyzed ? ' · 已分析 ' + analyzed : '');
  }
  var mcpEl = panel.querySelector('.ai-req-shell-mcp-status');
  if (mcpEl && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'MCP_GET_STATUS' }, function (resp) {
      if (!mcpEl) return;
      if (resp && resp.helperConnected) {
        mcpEl.textContent = 'MCP 已连接';
        mcpEl.classList.add('ai-req-shell-mcp-on');
        mcpEl.classList.remove('ai-req-shell-mcp-off');
      } else {
        mcpEl.textContent = 'MCP 未启动';
        mcpEl.classList.add('ai-req-shell-mcp-off');
        mcpEl.classList.remove('ai-req-shell-mcp-on');
      }
    });
  }
}

function setMainWorkbenchTab(tabName) {
  ensureMainUiState();
  state.ui.activeMainTab = tabName || 'requests';
  if (state.mainPanel) {
    state.mainPanel.setAttribute('data-ai-req-tab', state.ui.activeMainTab);
  }
  refreshMainWorkbench();
}

function refreshMainNavButtons() {
  if (!state.mainPanel) return;
  ensureMainUiState();
  var tabs = state.mainPanel.querySelectorAll('.ai-req-nav-item');
  for (var i = 0; i < tabs.length; i++) {
    var active = tabs[i].getAttribute('data-main-tab') === state.ui.activeMainTab;
    tabs[i].classList.toggle('ai-req-nav-item-active', active);
    tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function getSelectedFlow() {
  ensureFlowState();
  var id = (state.flowUi && state.flowUi.selectedFlowId) || state.activeFlowId;
  if (id && typeof hydrateFlowIntoWorkbench === 'function') {
    var hydrated = hydrateFlowIntoWorkbench(id);
    if (hydrated) return hydrated;
  }
  if (id && typeof getFlowById === 'function') {
    var merged = getFlowById(id);
    if (merged) {
      state.flows[merged.id] = merged;
      return merged;
    }
  }
  if (id && state.flows[id]) return state.flows[id];
  var ids = Object.keys(state.flows || {});
  ids.sort(function (a, b) {
    return ((state.flows[b] && state.flows[b].startedAt) || 0) - ((state.flows[a] && state.flows[a].startedAt) || 0);
  });
  if (ids.length > 0) {
    state.flowUi.selectedFlowId = ids[0];
    return state.flows[ids[0]];
  }
  return null;
}

function flowRequestLine(req) {
  if (!req) return '';
  var urlText = extractRequestPath(req.originalUrl || req.url || '');
  return ((req.method || 'GET').toUpperCase() + ' ' + urlText).trim();
}

function renderFlowRequestRow(flow, reqId) {
  var req = findRequestById(reqId);
  if (!req) return '';
  var cls = (flow.classifications && flow.classifications[reqId]) || 'unknown';
  var verified = flow.verifiedRequestIds && flow.verifiedRequestIds.indexOf(reqId) !== -1;
  return '' +
    '<div class="ai-req-flow-request" data-req-id="' + escapeHtml(reqId) + '">' +
    '  <div class="ai-req-flow-request-main">' +
    '    <span class="ai-req-method-badge ai-req-method-' + escapeHtml((req.method || 'GET').toLowerCase()) + '">' + escapeHtml((req.method || 'GET').toUpperCase()) + '</span>' +
    '    <span class="ai-req-flow-request-url" title="' + escapeHtml(req.originalUrl || req.url || '') + '">' + escapeHtml(flowRequestLine(req)) + '</span>' +
    '    <span class="ai-req-flow-status">' + escapeHtml(req.responseStatus || 0) + '</span>' +
    '  </div>' +
    '  <div class="ai-req-flow-request-actions">' +
    '    <select class="ai-req-flow-class-select" data-req-id="' + escapeHtml(reqId) + '">' +
    '      <option value="core"' + (cls === 'core' ? ' selected' : '') + '>核心</option>' +
    '      <option value="support"' + (cls === 'support' ? ' selected' : '') + '>支撑</option>' +
    '      <option value="noise"' + (cls === 'noise' ? ' selected' : '') + '>噪音</option>' +
    '      <option value="unknown"' + (cls === 'unknown' ? ' selected' : '') + '>待判定</option>' +
    '    </select>' +
    '    <label class="ai-req-flow-verified-label"><input type="checkbox" class="ai-req-flow-verified-cb" data-req-id="' + escapeHtml(reqId) + '"' + (verified ? ' checked' : '') + '> 已验证</label>' +
    '  </div>' +
    '</div>';
}

function renderFlowStepCard(flow, step) {
  var requestIds = step.requestIds || [];
  var html = '';
  html += '<div class="ai-req-flow-step" data-step-id="' + escapeHtml(step.id) + '">';
  html += '  <div class="ai-req-flow-step-head">';
  html += '    <span class="ai-req-flow-step-index">' + escapeHtml(step.index || 0) + '</span>';
  html += '    <div class="ai-req-flow-step-title-wrap">';
  html += '      <div class="ai-req-flow-step-title">' + escapeHtml(step.title || '用户步骤') + '</div>';
  html += '      <div class="ai-req-flow-step-meta">' + escapeHtml(step.type || 'user_action') + ' · ' + escapeHtml(new Date(step.at || Date.now()).toLocaleTimeString()) + '</div>';
  html += '    </div>';
  html += '    <span class="ai-req-flow-step-count">' + requestIds.length + ' 请求</span>';
  html += '  </div>';
  if (requestIds.length === 0) {
    html += '<div class="ai-req-flow-empty-inline">该步骤暂无归属请求</div>';
  } else {
    html += '<div class="ai-req-flow-request-list">';
    for (var i = 0; i < requestIds.length; i++) {
      html += renderFlowRequestRow(flow, requestIds[i]);
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function getFlowWorkbenchToolsMap() {
  if (typeof getMcpListToolsMap === 'function') {
    var mapped = getMcpListToolsMap();
    if (mapped && typeof mapped === 'object' && Object.keys(mapped).length > 0) return mapped;
  }
  return state.mcpTools || {};
}

function countFlowToolsetStats(flow) {
  var names = typeof resolveFlowToolNames === 'function'
    ? resolveFlowToolNames(flow)
    : ((flow && flow.mcpToolNames) || []);
  var toolsMap = getFlowWorkbenchToolsMap();
  var stats = { total: names.length, available: 0, disabled: 0, missing: 0, names: names };
  for (var i = 0; i < names.length; i++) {
    var t = toolsMap[names[i]];
    if (!t) stats.missing++;
    else if (t.enabled === false) stats.disabled++;
    else stats.available++;
  }
  return stats;
}

function buildFlowToolsetHTML(flow) {
  if (!flow) return '';
  var stats = countFlowToolsetStats(flow);
  var toolNames = stats.names || [];
  var toolsMap = getFlowWorkbenchToolsMap();
  var html = '';
  html += '<div class="ai-req-flow-toolset">';
  html += '  <div class="ai-req-flow-toolset-head"><strong>流程工具集</strong></div>';
  html += '  <div class="ai-req-flow-toolset-stats">';
  html += '    已关联 ' + stats.total + ' · 可用 ' + stats.available + ' · 禁用 ' + stats.disabled + ' · 缺失 ' + stats.missing;
  html += '  </div>';
  if (stats.total > 0) {
    html += '  <ul class="ai-req-flow-toolset-list">';
    for (var ti = 0; ti < toolNames.length; ti++) {
      var tn = toolNames[ti];
      var tool = toolsMap[tn];
      var st = !tool ? 'missing' : (tool.enabled === false ? 'disabled' : 'available');
      html += '    <li class="ai-req-flow-toolset-item ai-req-flow-toolset-' + st + '">' + escapeHtml(tn) + '</li>';
    }
    html += '  </ul>';
  } else {
    html += '  <div class="ai-req-flow-toolset-empty">尚未从已验证请求生成 MCP 工具。</div>';
  }
  html += '  <div class="ai-req-flow-toolset-actions">';
  html += '    <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-context-view-btn">查看流程上下文</button>';
  html += '    <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-mcp-manage-btn">在 MCP 页管理工具</button>';
  html += '    <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-context-sync-btn">同步到 MCP</button>';
  html += '    <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-context-copy-btn">复制 AI 使用提示</button>';
  html += '  </div>';
  html += '</div>';
  return html;
}

function showFlowContextPreviewDialog(flow, payload) {
  var existing = document.querySelector('.ai-req-flow-context-preview-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'ai-req-confirm-overlay ai-req-flow-context-preview-overlay';
  var modal = document.createElement('div');
  modal.className = 'ai-req-confirm-modal ai-req-flow-context-preview-modal';
  var title = document.createElement('div');
  title.className = 'ai-req-confirm-title';
  title.textContent = '流程上下文 · ' + (flow.name || '未命名流程');
  var body = document.createElement('pre');
  body.className = 'ai-req-flow-context-preview-body';
  body.textContent = JSON.stringify(payload, null, 2);
  var actions = document.createElement('div');
  actions.className = 'ai-req-confirm-actions';
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-req-btn ai-req-btn-primary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', function () { overlay.remove(); });
  actions.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(body);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  mountConfirmOverlay(overlay);
}

function openFlowInWorkbench(flowId) {
  ensureFlowState();
  ensureMainUiState();
  var flow = typeof hydrateFlowIntoWorkbench === 'function'
    ? hydrateFlowIntoWorkbench(flowId)
    : null;
  if (!flow && typeof getFlowById === 'function') flow = getFlowById(flowId);
  if (!flow && flowId && state.flows) flow = state.flows[flowId] || null;
  if (flow && flow.id) {
    state.flows[flow.id] = flow;
    state.flowUi.selectedFlowId = flow.id;
  } else {
    state.flowUi.selectedFlowId = flowId || null;
  }
  state.isPanelOpen = true;
  if (state.mainPanel) state.mainPanel.style.display = 'flex';
  setMainWorkbenchTab('flow');
}

function openMcpFlowManagement(flowId) {
  ensureMcpListUi();
  ensureMainUiState();
  state.mcpListUi.scrollToFlowId = flowId || null;
  state.mcpListUi.selectedFlowId = flowId || null;
  state.mcpListUi.selectedToolName = null;
  state.mcpListUi.inspectorOpen = !!flowId;
  state.mcpPanelTab = 'list';
  state.isPanelOpen = true;
  if (state.mainPanel) state.mainPanel.style.display = 'flex';
  setMainWorkbenchTab('mcp');
}

function bindFlowToolsetActions(pane, flow) {
  if (!pane || !flow) return;
  var viewBtn = pane.querySelector('.ai-req-flow-context-view-btn');
  if (viewBtn) {
    viewBtn.addEventListener('click', function () {
      chrome.runtime.sendMessage({
        type: 'MCP_GET_FLOW_CONTEXT',
        flowId: flow.id,
        flowName: flow.name || ''
      }, function (resp) {
        if (chrome.runtime.lastError) {
          showToast('无法读取流程上下文', 3000, 'error');
          return;
        }
        showFlowContextPreviewDialog(flow, resp || { ok: false });
      });
    });
  }
  var mcpManageBtn = pane.querySelector('.ai-req-flow-mcp-manage-btn');
  if (mcpManageBtn) {
    mcpManageBtn.addEventListener('click', function () {
      openMcpFlowManagement(flow.id);
    });
  }
  var syncBtn = pane.querySelector('.ai-req-flow-context-sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', function () {
      var current = getSelectedFlow();
      if (!current) {
        showToast('请先选择流程', 2500, 'warn');
        return;
      }
      if (typeof generateMcpToolsFromFlow !== 'function') {
        showToast('MCP 生成模块未加载', 3000, 'error');
        return;
      }
      var verified = (current.verifiedRequestIds || []).length;
      if (verified === 0) {
        showToast('请先勾选已验证请求，再同步到 MCP', 3000, 'warn');
        return;
      }
      var stats = generateMcpToolsFromFlow(current) || { added: 0, skipped: 0, linked: 0 };
      refreshFlowWorkbench();
      if (stats.added > 0 || stats.linked > 0) {
        showToast('已生成并同步：新增 ' + stats.added + '，关联 ' + (stats.linked || 0), 2500, 'success');
      } else if (stats.skipped > 0) {
        showToast('工具已存在并已同步（' + stats.skipped + ' 个）', 2500, 'success');
      } else {
        showToast('未生成新工具', 2500, 'warn');
      }
    });
  }
  var copyBtn = pane.querySelector('.ai-req-flow-context-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var text =
        '请使用“' + (flow.name || '未命名流程') + '”流程。' +
        '先调用 get_recorded_flow_context 获取该流程相关工具，再根据我的目标选择具体工具。' +
        '步骤仅供参考，不需要按顺序执行。';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showToast('已复制 AI 使用提示', 2000, 'success');
        }).catch(function () {
          showToast('复制失败', 2000, 'error');
        });
      } else {
        showToast('当前环境不支持剪贴板复制', 2500, 'warn');
      }
    });
  }
}

function refreshFlowWorkbench() {
  if (!state.mainPanel) return;
  ensureFlowState();
  var pane = state.mainPanel.querySelector('.ai-req-flow-workbench');
  if (!pane) return;
  var savedScrollTop = capturePanelScroll('.ai-req-flow-steps');
  var selected = getSelectedFlow();
  if (selected && selected.id && !state.flows[selected.id]) {
    state.flows[selected.id] = selected;
  }
  var flowIds = Object.keys(state.flows || {});
  flowIds.sort(function (a, b) {
    return ((state.flows[b] && state.flows[b].startedAt) || 0) - ((state.flows[a] && state.flows[a].startedAt) || 0);
  });
  if (selected && selected.id && flowIds.indexOf(selected.id) === -1) {
    flowIds.unshift(selected.id);
  }
  var html = '';
  html += '<div class="ai-req-flow-toolbar">';
  html += '  <button type="button" class="ai-req-btn ai-req-btn-primary ai-req-flow-start-btn">' + (state.flowRecording ? '重新开始录制' : '开始录制') + '</button>';
  html += '  <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-stop-btn"' + (state.flowRecording ? '' : ' disabled') + '>结束录制</button>';
  html += '  <select class="ai-req-flow-select">';
  if (flowIds.length === 0) {
    html += '    <option value="">暂无流程</option>';
  } else {
    for (var fi = 0; fi < flowIds.length; fi++) {
      var f = state.flows[flowIds[fi]];
      var kindTag = inferFlowKind(f) === 'manual' ? ' [手动]' : '';
      html += '    <option value="' + escapeHtml(f.id) + '"' + (selected && selected.id === f.id ? ' selected' : '') + '>' + escapeHtml(f.name || f.id) + kindTag + '</option>';
    }
  }
  html += '  </select>';
  html += '  <select class="ai-req-flow-filter">';
  var filters = ['all', 'core', 'support', 'noise', 'unknown', 'verified'];
  var labels = { all: '全部请求', core: '核心', support: '支撑', noise: '噪音', unknown: '待判定', verified: '已验证' };
  for (var ff = 0; ff < filters.length; ff++) {
    var fv = filters[ff];
    html += '    <option value="' + fv + '"' + (state.flowUi.filterClassification === fv ? ' selected' : '') + '>' + labels[fv] + '</option>';
  }
  html += '  </select>';
  html += '  <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-flow-mcp-btn"' + (selected ? '' : ' disabled') + '>已验证生成 MCP</button>';
  html += '</div>';

  if (!selected) {
    html += '<div class="ai-req-flow-empty">还没有录制流程。点击“开始录制”，按真实业务顺序操作页面，请求会自动挂到步骤下。</div>';
    pane.innerHTML = html;
    bindFlowWorkbench(pane);
    return;
  }

  refreshArchivedFlowRecordsForActiveSession();

  var verifiedCount = (selected.verifiedRequestIds || []).length;
  var stepCountDisplay = typeof countFlowStepsWithRequests === 'function'
    ? countFlowStepsWithRequests(selected)
    : (selected.steps || []).length;
  html += '<div class="ai-req-flow-summary">';
  var selKind = inferFlowKind(selected);
  html += '  <div><strong>' + escapeHtml(selected.name || '未命名流程') + '</strong>';
  if (selKind === 'manual') html += ' <span class="ai-req-mcp-flow-kind-badge ai-req-mcp-flow-kind-manual">手动</span>';
  html += '<span>' + escapeHtml(selected.hostname || location.hostname) + '</span></div>';
  if (selKind === 'manual') {
    var manualToolCount = typeof resolveFlowToolNames === 'function'
      ? resolveFlowToolNames(selected).length
      : ((selected.mcpToolNames || []).length);
    html += '  <div>手动工具分组 · 已关联工具 ' + manualToolCount + '</div>';
  } else {
    html += '  <div>步骤 ' + stepCountDisplay + ' · 已验证请求 ' + verifiedCount + (state.activeFlowId === selected.id && state.flowRecording ? ' · 录制中' : '') + '</div>';
  }
  html += '</div>';
  html += buildFlowToolsetHTML(selected);
  if (selKind === 'manual') {
    html += '<div class="ai-req-flow-empty">手动分组，无录制步骤。点击「在 MCP 页管理工具」调整工具归属。</div>';
  } else {
  html += '<div class="ai-req-flow-steps">';
  var shownAny = false;
  var clsFilter = state.flowUi.filterClassification || 'all';
  for (var si = 0; si < (selected.steps || []).length; si++) {
    var step = selected.steps[si];
    var originalReqIds = step.requestIds || [];
    if (originalReqIds.length === 0) continue;
    if (clsFilter !== 'all') {
      step = Object.assign({}, step);
      step.requestIds = originalReqIds.filter(function (rid) {
        if (clsFilter === 'verified') return (selected.verifiedRequestIds || []).indexOf(rid) !== -1;
        return ((selected.classifications || {})[rid] || 'unknown') === clsFilter;
      });
      if (step.requestIds.length === 0) continue;
    }
    shownAny = true;
    html += renderFlowStepCard(selected, step);
  }
  if (!shownAny) {
    html += '<div class="ai-req-flow-empty">当前筛选下没有请求。</div>';
  }
  html += '</div>';
  }
  pane.innerHTML = html;
  bindFlowWorkbench(pane);
  bindFlowToolsetActions(pane, selected);
  restorePanelScroll('.ai-req-flow-steps', savedScrollTop);
}

function bindFlowWorkbench(pane) {
  var startBtn = pane.querySelector('.ai-req-flow-start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', function () {
      var defaultName = '流程 ' + new Date().toLocaleString();
      var name = prompt('给这个调试流程起个名字', defaultName);
      if (name === null) return;
      var flow = createFlow((name || defaultName).trim());
      addFlowStep('navigation', null);
      showToast('已开始录制流程');
      enterFlowRecordingTrayMode(flow);
    });
  }
  var stopBtn = pane.querySelector('.ai-req-flow-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      finishFlowRecordingCommon(false);
      showToast('流程录制已结束');
    });
  }
  var select = pane.querySelector('.ai-req-flow-select');
  if (select) {
    select.addEventListener('change', function () {
      state.flowUi.selectedFlowId = select.value || null;
      refreshFlowWorkbench();
    });
  }
  var filter = pane.querySelector('.ai-req-flow-filter');
  if (filter) {
    filter.addEventListener('change', function () {
      state.flowUi.filterClassification = filter.value || 'all';
      refreshFlowWorkbench();
    });
  }
  var classSelects = pane.querySelectorAll('.ai-req-flow-class-select');
  for (var ci = 0; ci < classSelects.length; ci++) {
    classSelects[ci].addEventListener('change', function () {
      var flow = getSelectedFlow();
      if (!flow) return;
      var reqId = this.getAttribute('data-req-id');
      handleFlowClassificationChange(flow, reqId, this.value || 'unknown');
      patchFlowRequestRowUi(pane, flow, reqId);
      patchFlowSummaryUi(pane, flow);
    });
  }
  var verifiedCbs = pane.querySelectorAll('.ai-req-flow-verified-cb');
  for (var vi = 0; vi < verifiedCbs.length; vi++) {
    verifiedCbs[vi].addEventListener('change', function () {
      var flow = getSelectedFlow();
      if (!flow) return;
      var reqId = this.getAttribute('data-req-id');
      handleFlowVerifiedChange(flow, reqId, this.checked);
      patchFlowSummaryUi(pane, flow);
    });
  }
  var mcpBtn = pane.querySelector('.ai-req-flow-mcp-btn');
  if (mcpBtn) {
    mcpBtn.addEventListener('click', function () {
      var flow = getSelectedFlow();
      if (!flow || typeof generateMcpToolsFromFlow !== 'function') return;
      var stats = generateMcpToolsFromFlow(flow);
      showToast('Flow MCP 新增 ' + stats.added + '，跳过 ' + stats.skipped);
      refreshFlowWorkbench();
    });
  }
}

function refreshMainWorkbench() {
  if (!state.mainPanel) return;
  ensureMainUiState();
  state.mainPanel.setAttribute('data-ai-req-tab', state.ui.activeMainTab);
  applyPanelLayoutMode(state.mainPanel);
  refreshMainNavButtons();
  syncShellChrome();
  if (state.ui.activeMainTab === 'requests') {
    refreshRequestList(undefined, true);
  } else if (state.ui.activeMainTab === 'mcp') {
    if (!state.mcpPanelTab) state.mcpPanelTab = 'list';
    refreshMainPanelContent();
  } else if (state.ui.activeMainTab === 'flow') {
    refreshFlowWorkbench();
  } else if (state.ui.activeMainTab === 'settings') {
    hydrateSettingsWorkbench();
  }
}

function createMainNavButton(tabName, label, shortLabel) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-req-nav-item';
  btn.setAttribute('data-main-tab', tabName);
  btn.setAttribute('role', 'tab');
  btn.title = label;
  var shortEl = document.createElement('span');
  shortEl.className = 'ai-req-nav-short';
  shortEl.textContent = shortLabel || label.charAt(0);
  var labelEl = document.createElement('span');
  labelEl.className = 'ai-req-nav-label';
  labelEl.textContent = label;
  btn.appendChild(shortEl);
  btn.appendChild(labelEl);
  btn.addEventListener('click', function () {
    setMainWorkbenchTab(tabName);
  });
  return btn;
}

function createMainPanel() {
  var panel = document.createElement('div');
  panel.className = 'ai-req-main-panel';

  var savedPos = storageGet(getScopedStorageKey('ai_req_panel_position'), null);
  if (savedPos) {
    try {
      var pos = clampPosition(JSON.parse(savedPos), 420, 620);
      panel.style.left = pos.left + 'px';
      panel.style.top = pos.top + 'px';
    } catch (e) {
      panel.style.right = '90px';
      panel.style.bottom = '20px';
    }
  } else {
    panel.style.right = '90px';
    panel.style.bottom = '20px';
  }

  ensureMainUiState();
  panel.setAttribute('data-ai-req-tab', state.ui.activeMainTab);
  panel.setAttribute('data-ai-req-layout', state.ui.layoutMode === 'wide' ? 'wide' : 'compact');

  var header = document.createElement('div');
  header.className = 'ai-req-panel-header';

  var brand = document.createElement('div');
  brand.className = 'ai-req-panel-brand';
  var brandDot = document.createElement('span');
  brandDot.className = 'ai-req-panel-brand-dot';
  var title = document.createElement('div');
  title.className = 'ai-req-panel-title';
  title.textContent = 'AI请求分析助手';
  brand.appendChild(brandDot);
  brand.appendChild(title);

  var meta = document.createElement('div');
  meta.className = 'ai-req-shell-meta';
  var hostMeta = document.createElement('span');
  hostMeta.className = 'ai-req-shell-host';
  hostMeta.textContent = typeof location !== 'undefined' ? location.hostname : '';
  var reqMeta = document.createElement('span');
  reqMeta.className = 'ai-req-shell-req-count';
  reqMeta.textContent = '0 请求';
  var mcpMeta = document.createElement('span');
  mcpMeta.className = 'ai-req-shell-mcp-status ai-req-shell-mcp-off';
  mcpMeta.textContent = 'MCP 未启动';
  meta.appendChild(hostMeta);
  meta.appendChild(reqMeta);
  meta.appendChild(mcpMeta);

  var headerActions = document.createElement('div');
  headerActions.className = 'ai-req-panel-actions';

  var layoutBtn = document.createElement('button');
  layoutBtn.type = 'button';
  layoutBtn.className = 'ai-req-panel-btn ai-req-layout-toggle-btn';
  layoutBtn.textContent = '\u2922';
  layoutBtn.title = '切换宽屏工作台';
  layoutBtn.setAttribute('aria-pressed', 'false');
  layoutBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePanelLayoutMode();
  });

  var configBtn = document.createElement('button');
  configBtn.type = 'button';
  configBtn.className = 'ai-req-panel-btn';
  configBtn.textContent = '\u2699';
  configBtn.title = '设置';
  configBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setMainWorkbenchTab('settings');
  });

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-req-panel-btn';
  closeBtn.textContent = '\u2715';
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    state.isPanelOpen = false;
    panel.style.display = 'none';
  });

  headerActions.appendChild(layoutBtn);
  headerActions.appendChild(configBtn);
  headerActions.appendChild(closeBtn);

  header.appendChild(brand);
  header.appendChild(meta);
  header.appendChild(headerActions);

  var shellBody = document.createElement('div');
  shellBody.className = 'ai-req-shell-body';

  var navRail = document.createElement('div');
  navRail.className = 'ai-req-nav-rail';
  navRail.setAttribute('role', 'tablist');
  navRail.appendChild(createMainNavButton('requests', '\u8BF7\u6C42', 'REQ'));
  navRail.appendChild(createMainNavButton('flow', '\u6D41\u7A0B', 'FLOW'));
  navRail.appendChild(createMainNavButton('mcp', 'MCP', 'MCP'));
  navRail.appendChild(createMainNavButton('settings', '\u8BBE\u7F6E', 'SET'));

  var workbenchStage = document.createElement('div');
  workbenchStage.className = 'ai-req-workbench-stage';

  var searchBox = document.createElement('div');
  searchBox.className = 'ai-req-search-box';
  var searchInput = document.createElement('textarea');
  searchInput.className = 'ai-req-search-input';
  searchInput.name = 'ai_req_search_' + Date.now();
  searchInput.id = 'ai_req_search_' + Math.random().toString(36).substr(2, 9);
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('autocomplete', 'off');
  searchInput.setAttribute('autocorrect', 'off');
  searchInput.setAttribute('autocapitalize', 'off');
  searchInput.setAttribute('spellcheck', 'false');
  searchInput.setAttribute('data-lpignore', 'true');
  searchInput.setAttribute('data-form-type', 'other');
  searchInput.setAttribute('aria-label', '搜索请求URL或分析结果');
  searchInput.rows = 1;
  searchInput.placeholder = '搜索请求URL或分析结果...';
  ensureMainUiState();
  searchInput.value = state.ui.requestKeyword || '';
  searchInput.addEventListener('input', function () {
    searchInput.value = searchInput.value.replace(/[\r\n]+/g, '');
    state.ui.requestKeyword = searchInput.value.trim();
    refreshRequestList(state.ui.requestKeyword, false);
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  });
  searchBox.appendChild(searchInput);

  var filterBar = document.createElement('div');
  filterBar.className = 'ai-req-filter-toolbar';
  filterBar.innerHTML = '' +
    '<div class="ai-req-chip-row">' +
    '  <span class="ai-req-filter-label">\u7B5B\u9009:</span>' +
    '  <button type="button" class="ai-req-chip" data-filter-chip="dup">\u91CD\u590D\u8BF7\u6C42</button>' +
    '  <button type="button" class="ai-req-chip ai-req-dedupe-reqs-btn">\u5220\u9664\u91CD\u590D\u8BF7\u6C42</button>' +
    '  <span class="ai-req-chip-sep">|</span>' +
    '  <span class="ai-req-chip-sub">Mock:</span>' +
    '  <button type="button" class="ai-req-chip" data-mock-filter-chip="all">\u5168\u90E8</button>' +
    '  <button type="button" class="ai-req-chip" data-mock-filter-chip="mocked">\u5DF2Mock</button>' +
    '  <button type="button" class="ai-req-chip" data-mock-filter-chip="plain">\u672AMock</button>' +
    '  <span class="ai-req-chip-sep">|</span>' +
    '  <span class="ai-req-chip-sub">AI:</span>' +
    '  <button type="button" class="ai-req-chip" data-analyzed-filter-chip="all">\u5168\u90E8</button>' +
    '  <button type="button" class="ai-req-chip" data-analyzed-filter-chip="done">\u5DF2\u5206\u6790</button>' +
    '  <button type="button" class="ai-req-chip" data-analyzed-filter-chip="pending">\u672A\u5206\u6790</button>' +
    '</div>' +
    '<div class="ai-req-chip-row">' +
    '  <span class="ai-req-chip-sub">\u65B9\u6CD5:</span>' +
    '  <button type="button" class="ai-req-chip ai-req-method-chip-btn" data-method-chip="GET">GET</button>' +
    '  <button type="button" class="ai-req-chip ai-req-method-chip-btn" data-method-chip="POST">POST</button>' +
    '  <button type="button" class="ai-req-chip ai-req-method-chip-btn" data-method-chip="PUT">PUT</button>' +
    '  <button type="button" class="ai-req-chip ai-req-method-chip-btn" data-method-chip="PATCH">PATCH</button>' +
    '  <button type="button" class="ai-req-chip ai-req-method-chip-btn" data-method-chip="DELETE">DEL</button>' +
    '  <span class="ai-req-chip-spacer"></span>' +
    '  <label class="ai-req-toolbar-group">\u5206\u7EC4: <select class="ai-req-group-select">' +
    '    <option value="none">\u5E73\u94FA</option>' +
    '    <option value="host">\u6309\u57DF\u540D</option>' +
    '    <option value="endpoint">\u6309\u63A5\u53E3(METHOD + path)</option>' +
    '  </select></label>' +
    '  <label class="ai-req-enhanced-gen-label">' +
    '    <input type="checkbox" class="ai-req-enhanced-gen-cb">\u589E\u5F3A MCP \u63A8\u65AD (\u975E\u4E00\u952E\u9ED8\u8BA4\u8DEF\u5F84)' +
    '  </label>' +
    '</div>';

  var actionBar = document.createElement('div');
  actionBar.className = 'ai-req-action-bar';
  var analyzeAllBtn = document.createElement('button');
  analyzeAllBtn.className = 'ai-req-analyze-all-btn';
  analyzeAllBtn.textContent = '\u2728 \u4E00\u952E\u5206\u6790\u6240\u6709';
  analyzeAllBtn.addEventListener('click', function () {
    analyzeAllRequests();
  });
  var mcpGenAllBtn = document.createElement('button');
  mcpGenAllBtn.className = 'ai-req-action-btn ai-req-mcp-gen-all-btn';
  mcpGenAllBtn.textContent = '\uD83D\uDD17 \u4E00\u952E\u751F\u6210MCP\u5DE5\u5177';
  mcpGenAllBtn.title = '\u6839\u636E\u5168\u90E8\u6293\u5305\u8BB0\u5F55\uFF08\u4E0E\u4EE5\u524D\u4E00\u81F4\uFF09\uFF1B\u975E\u201C\u589E\u5F3A\u201D\u914D\u7F6E';
  mcpGenAllBtn.addEventListener('click', function () {
    var toolsNative = generateMcpToolsFromRecords(state.requestRecords);
    var stats = mergeGeneratedMcpToolsIntoState(toolsNative);
    if (stats.added > 0) {
      saveMcpTools();
      chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
    }
    showToast('\u65B0\u589E ' + stats.added + '\uFF0C\u8DF3\u8FC7\u91CD\u590D ' + stats.skipped);
  });
  var mcpGenViewBtn = document.createElement('button');
  mcpGenViewBtn.type = 'button';
  mcpGenViewBtn.className = 'ai-req-action-btn ai-req-mcp-gen-view-btn';
  mcpGenViewBtn.title = '\u6839\u636E\u5F53\u524D\u5339\u914D/\u641C\u7D22/\u8FC7\u6EE4\u540E\u7684\u5217\u8868\u751F\u6210\uFF0C\u9075\u7167 MCP \u589E\u5F3A\u5F00\u5173\u72B6\u6001';
  mcpGenViewBtn.textContent = '\uD83E\uDD16 \u89C6\u56FE\u5185 MCP';
  mcpGenViewBtn.addEventListener('click', function () {
    var viewRecs = filterRequestRecords(state.requestRecords, getActiveListKeyword());
    var genVX = typeof pickGeneratorForRequests === 'function' ? pickGeneratorForRequests() : generateMcpToolsFromRecords;
    var toolsV = genVX(viewRecs);
    var statsV = mergeGeneratedMcpToolsIntoState(toolsV);
    if (statsV.added > 0) {
      saveMcpTools();
      chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
    }
    showToast('\u89C6\u56FE MCP \u65B0\u589E ' + statsV.added + '\uFF0C\u8DF3\u8FC7 ' + statsV.skipped);
  });

  var mcpGenSelBtn = document.createElement('button');
  mcpGenSelBtn.type = 'button';
  mcpGenSelBtn.className = 'ai-req-action-btn ai-req-mcp-gen-sel-btn';
  mcpGenSelBtn.title = '\u7528 checkbox \u52FE\u9009\u591A\u6761\u8BF7\u6C42\u540E\u751F\u6210\uFF0C\u9075\u5FAA MCP \u589E\u5F3A\u5F00\u5173';
  mcpGenSelBtn.textContent = '\u2705 \u5DF2\u9009 MCP';
  mcpGenSelBtn.addEventListener('click', function () {
    var smap = {};
    for (var xk in state.selectedReqIds) if (state.selectedReqIds[xk]) smap[xk] = true;
    var srec = state.requestRecords.filter(function (r) {
      return smap[r.id];
    });
    if (!srec.length) {
      showToast('\u8BF7\u5148\u52FE\u9009\u8BF7\u6C42\u884C');
      return;
    }
    var genSX = typeof pickGeneratorForRequests === 'function' ? pickGeneratorForRequests() : generateMcpToolsFromRecords;
    var toolsS = genSX(srec);
    var statsS = mergeGeneratedMcpToolsIntoState(toolsS);
    if (statsS.added > 0) {
      saveMcpTools();
      chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
    }
    showToast('\u5DF2\u9009 MCP \u65B0\u589E ' + statsS.added + '\uFF0C\u8DF3\u8FC7 ' + statsS.skipped);
  });

  var clearMockBtn = document.createElement('button');
  clearMockBtn.className = 'ai-req-clear-mock-btn';
  clearMockBtn.textContent = '\u6E05\u9664\u6240\u6709\u89C4\u5219';
  clearMockBtn.title = '\u6E05\u9664\u5F53\u524D\u57DF\u540D\u4E0B\u4FDD\u5B58\u7684\u6240\u6709\u8C03\u8BD5\u89C4\u5219';
  clearMockBtn.addEventListener('click', function () {
    clearAllMockRules();
  });
  var envReplayCfgBtn = document.createElement('button');
  envReplayCfgBtn.type = 'button';
  envReplayCfgBtn.className = 'ai-req-action-btn ai-req-envreplay-cfg-btn';
  envReplayCfgBtn.textContent = '\uD83C\uDF10 \u7AD9\u70B9\u8DE8\u73AF\u5883\u914D\u7F6E';
  envReplayCfgBtn.title = '\u67E5\u770B\u5E76\u7F16\u8F91\u5F53\u524D\u6D4B\u8BD5\u7AD9\u70B9\u7684\u6B63\u5F0F\u73AF\u5883\u914D\u7F6E\uFF08\u6B63\u5F0F\u73AF\u5883\u57DF\u540D\u3001Token \u5B58\u50A8 Key\u3001Bearer Token\u3001\u6B63\u5F0F\u73AF\u5883\u8BF7\u6C42\u5934\uFF09';
  envReplayCfgBtn.addEventListener('click', function () {
    openEnvReplayConfigDialog();
  });
  var reqCount = document.createElement('span');
  reqCount.className = 'ai-req-req-count';
  reqCount.textContent = '0 \u8BF7\u6C42';
  actionBar.appendChild(analyzeAllBtn);
  actionBar.appendChild(mcpGenAllBtn);
  actionBar.appendChild(mcpGenViewBtn);
  actionBar.appendChild(mcpGenSelBtn);
  actionBar.appendChild(envReplayCfgBtn);
  actionBar.appendChild(clearMockBtn);
  actionBar.appendChild(reqCount);

  var progressBar = document.createElement('div');
  progressBar.className = 'ai-req-progress-bar';
  var taskStrip = document.createElement('div');
  taskStrip.className = 'ai-req-task-strip';
  taskStrip.style.display = 'none';
  var progressFill = document.createElement('div');
  progressFill.className = 'ai-req-progress-fill';
  progressBar.appendChild(progressFill);

  var requestSummary = document.createElement('div');
  requestSummary.className = 'ai-req-request-summary';

  var requestSplit = document.createElement('div');
  requestSplit.className = 'ai-req-request-split';

  var tablePane = document.createElement('div');
  tablePane.className = 'ai-req-request-table-pane';

  var tableHead = document.createElement('div');
  tableHead.className = 'ai-req-request-table-head';
  tableHead.innerHTML = '' +
    '<span class="ai-req-th ai-req-th-cb"></span>' +
    '<span class="ai-req-th ai-req-th-method">方法</span>' +
    '<span class="ai-req-th ai-req-th-path">路径</span>' +
    '<span class="ai-req-th ai-req-th-status">状态</span>' +
    '<span class="ai-req-th ai-req-th-time">耗时</span>' +
    '<span class="ai-req-th ai-req-th-flags">标记</span>';

  var requestList = document.createElement('div');
  requestList.className = 'ai-req-request-list';

  var requestInspector = document.createElement('div');
  requestInspector.className = 'ai-req-request-inspector';
  requestInspector.style.display = 'none';
  var inspectorHeader = document.createElement('div');
  inspectorHeader.className = 'ai-req-request-inspector-header';
  var inspectorTitle = document.createElement('span');
  inspectorTitle.className = 'ai-req-request-inspector-title';
  inspectorTitle.textContent = '请求详情';
  var inspectorClose = document.createElement('button');
  inspectorClose.type = 'button';
  inspectorClose.className = 'ai-req-panel-btn ai-req-inspector-close-btn';
  inspectorClose.textContent = '\u2715';
  inspectorClose.title = '关闭详情';
  inspectorClose.addEventListener('click', function (e) {
    e.stopPropagation();
    ensureMainUiState();
    state.ui.requestTable.detailOpen = false;
    state.expandedReqId = null;
    syncRequestInspectorVisibility();
    refreshRequestList(getActiveListKeyword(), true);
  });
  inspectorHeader.appendChild(inspectorTitle);
  inspectorHeader.appendChild(inspectorClose);
  var inspectorBody = document.createElement('div');
  inspectorBody.className = 'ai-req-request-inspector-body';
  requestInspector.appendChild(inspectorHeader);
  requestInspector.appendChild(inspectorBody);

  var mainBody = document.createElement('div');
  mainBody.className = 'ai-req-main-body';
  var bulkBarReq = document.createElement('div');
  bulkBarReq.className = 'ai-req-req-bulk-bar';
  bulkBarReq.style.display = 'none';
  bulkBarReq.innerHTML = '' +
    '<span class="ai-req-req-bulk-count">\u5DF2\u9009 0</span>' +
    '<button type="button" class="ai-req-btn ai-req-btn-secondary" data-bulk-act="bulk-ai">\u6279\u91CF AI\u5206\u6790</button>' +
    '<button type="button" class="ai-req-btn ai-req-btn-secondary" data-bulk-act="bulk-mcp-selected">\u5DF2\u9009\u2192MCP</button>' +
    '<button type="button" class="ai-req-btn ai-req-btn-secondary" data-bulk-act="clear-selection">\u6E05\u7A7A\u9009\u62E9</button>';
  tablePane.appendChild(bulkBarReq);
  tablePane.appendChild(tableHead);
  tablePane.appendChild(requestList);
  requestSplit.appendChild(tablePane);
  requestSplit.appendChild(requestInspector);
  mainBody.appendChild(requestSplit);

  var bottomInput = document.createElement('div');
  bottomInput.className = 'ai-req-bottom-input';
  var chatInput = document.createElement('textarea');
  chatInput.className = 'ai-req-bottom-textarea';
  chatInput.placeholder = '输入修改指令，如"将第1个请求的返回数据中status改为true"...';
  var sendBtn = document.createElement('button');
  sendBtn.className = 'ai-req-send-btn';
  sendBtn.textContent = '\u27A4 发送';
  sendBtn.addEventListener('click', function () {
    var msg = chatInput.value.trim();
    if (!msg) return;
    chatInput.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '处理中...';
    chatModify(msg).then(function (data) {
      sendBtn.disabled = false;
      sendBtn.textContent = '\u27A4 发送';
      if (data) {
        openJsonEditor(data);
      }
    }).catch(function () {
      sendBtn.disabled = false;
      sendBtn.textContent = '\u27A4 发送';
    });
  });
  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  chatInput.addEventListener('input', function () {
    this.style.height = '36px';
    this.style.height = Math.min(80, this.scrollHeight) + 'px';
  });
  bottomInput.appendChild(chatInput);
  bottomInput.appendChild(sendBtn);

  var requestPane = document.createElement('div');
  requestPane.className = 'ai-req-workbench ai-req-request-workbench';
  requestPane.setAttribute('data-workbench', 'requests');
  requestPane.appendChild(searchBox);
  requestPane.appendChild(filterBar);
  requestPane.appendChild(actionBar);
  requestPane.appendChild(taskStrip);
  requestPane.appendChild(progressBar);
  requestPane.appendChild(requestSummary);
  requestPane.appendChild(mainBody);
  requestPane.appendChild(bottomInput);

  var flowPane = document.createElement('div');
  flowPane.className = 'ai-req-workbench ai-req-flow-workbench';
  flowPane.setAttribute('data-workbench', 'flow');

  var mcpPane = document.createElement('div');
  mcpPane.className = 'ai-req-workbench ai-req-mcp-workbench';
  mcpPane.setAttribute('data-workbench', 'mcp');
  var mcpBody = document.createElement('div');
  mcpBody.className = 'ai-req-mcp-body';
  mcpPane.appendChild(mcpBody);

  var settingsPane = document.createElement('div');
  settingsPane.className = 'ai-req-workbench ai-req-settings-workbench';
  settingsPane.setAttribute('data-workbench', 'settings');
  settingsPane.innerHTML = '' +
    '<div class="ai-req-settings-scroll">' +
    '  <div class="ai-req-settings-section">' +
    '    <div class="ai-req-settings-title">AI 配置</div>' +
    '    <label class="ai-req-settings-field"><span>API Key</span><input type="password" class="ai-req-settings-input ai-req-settings-apikey" placeholder="输入 API Key"></label>' +
    '    <label class="ai-req-settings-field"><span>Base URL</span><input type="text" class="ai-req-settings-input ai-req-settings-baseurl" placeholder="https://api.moonshot.cn/v1"></label>' +
    '    <label class="ai-req-settings-field"><span>模型名称</span><input type="text" class="ai-req-settings-input ai-req-settings-model" placeholder="kimi-k2.6"></label>' +
    '  </div>' +
    '  <div class="ai-req-settings-section">' +
    '    <div class="ai-req-settings-title">MCP Server 配置</div>' +
    '    <label class="ai-req-settings-field"><span>MCP 端口</span><input type="number" min="1" max="65535" class="ai-req-settings-input ai-req-settings-mcp-port" placeholder="9527"></label>' +
    '    <label class="ai-req-settings-field"><span>鉴权 Token</span><input type="password" class="ai-req-settings-input ai-req-settings-mcp-token" placeholder="可选，用于 MCP 连接鉴权"></label>' +
    '    <label class="ai-req-settings-check"><input type="checkbox" class="ai-req-settings-mcp-auto-sync"> 启动时自动同步工具列表</label>' +
    '  </div>' +
    '  <div class="ai-req-settings-section">' +
    '    <div class="ai-req-settings-title">MCP 流程上下文工具</div>' +
    '    <label class="ai-req-settings-check"><input type="checkbox" class="ai-req-settings-flow-ctx-list" checked> 暴露 list_recorded_flows</label>' +
    '    <label class="ai-req-settings-check"><input type="checkbox" class="ai-req-settings-flow-ctx-detail" checked> 暴露 get_recorded_flow_context</label>' +
    '    <label class="ai-req-settings-check"><input type="checkbox" class="ai-req-settings-flow-ctx-brainstorm" checked> 暴露 brainstorm_mcp_tool</label>' +
    '    <div class="ai-req-settings-hint">关闭后需保存设置并重新同步 MCP；若 Cursor 仍显示旧列表，请在 MCP 设置页刷新服务器。</div>' +
    '  </div>' +
    '  <div class="ai-req-settings-section">' +
    '    <div class="ai-req-settings-title">工具生成配置</div>' +
    '    <label class="ai-req-settings-field"><span>MCP 工具命名</span><select class="ai-req-settings-input ai-req-settings-mcp-tool-naming"><option value="full">完整路径（默认）</option><option value="compact">紧凑（末段+哈希）</option></select></label>' +
    '    <label class="ai-req-settings-check"><input type="checkbox" class="ai-req-settings-enhanced-gen"> 增强 MCP 推断（非一键默认路径）</label>' +
    '    <div class="ai-req-settings-hint">与请求工作台的「增强 MCP 推断」开关同步；影响视图内/已选生成时的推断策略。</div>' +
    '  </div>' +
    '  <div class="ai-req-settings-section">' +
    '    <div class="ai-req-settings-title">跨环境 Mock（当前站点）</div>' +
    '    <div class="ai-req-settings-hint">测试站点：' + location.hostname + '。下面配置只保存到该站点，不会影响其他测试站点。</div>' +
    '    <label class="ai-req-settings-field"><span>正式环境域名</span><input type="text" class="ai-req-settings-input ai-req-settings-env-replay-prod" placeholder="https://prod.admin.com 或 prod.admin.com"></label>' +
    '    <label class="ai-req-settings-field"><span>Token 存储 Key</span><input type="text" class="ai-req-settings-input ai-req-settings-env-replay-token-key" placeholder="token（localStorage 中的键名）"></label>' +
    '    <label class="ai-req-settings-field"><span>Bearer Token（手动）</span><input type="text" class="ai-req-settings-input ai-req-settings-env-replay-manual-token" placeholder="留空则自动从正式环境 tab 读取"></label>' +
    '    <label class="ai-req-settings-field"><span>正式环境请求头（JSON）</span><textarea class="ai-req-settings-input ai-req-settings-env-replay-prod-headers" rows="3" placeholder=\'{"X-Tenant":"888"} 留空则沿用测试请求头\'></textarea></label>' +
    '    <div class="ai-req-settings-hint">配置后可在请求页勾选接口，自动拉取该站点对应正式环境的数据回放。请求头默认沿用测试请求头，上方 JSON 会合并覆盖。需在同一浏览器登录过正式环境，或填写 Bearer Token。仅支持 GET。</div>' +
    '  </div>' +
    '  <div class="ai-req-settings-section">' +
    '    <div class="ai-req-settings-title">导入导出配置</div>' +
    '    <label class="ai-req-settings-field"><span>MCP 导出目录（本机）</span><input type="text" class="ai-req-settings-input ai-req-settings-mcp-export-path" placeholder="D:\\\\exports\\\\mcp 或 /home/user/mcp-export"></label>' +
    '    <div class="ai-req-settings-hint">导出目录非空且 MCP 助手已启动时，会优先写入本机目录；否则使用浏览器下载。</div>' +
    '  </div>' +
    '  <div class="ai-req-settings-section ai-req-settings-danger">' +
    '    <div class="ai-req-settings-title">危险区</div>' +
    '    <div class="ai-req-settings-hint ai-req-settings-danger-hint">以下操作仅影响当前站点（' + (typeof location !== 'undefined' ? location.hostname : '') + '），不可撤销。</div>' +
    '    <button type="button" class="ai-req-btn ai-req-btn-danger ai-req-settings-clear-rules">清除全部调试规则</button>' +
    '  </div>' +
    '</div>' +
    '<div class="ai-req-settings-actions">' +
    '  <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-settings-open-legacy" title="兼容旧版浮层配置">打开浮层配置</button>' +
    '  <button type="button" class="ai-req-btn ai-req-btn-primary ai-req-settings-save">保存设置</button>' +
    '</div>';

  workbenchStage.appendChild(requestPane);
  workbenchStage.appendChild(flowPane);
  workbenchStage.appendChild(mcpPane);
  workbenchStage.appendChild(settingsPane);
  shellBody.appendChild(navRail);
  shellBody.appendChild(workbenchStage);

  panel.appendChild(header);
  panel.appendChild(shellBody);

  makeDraggable(panel, header);
  applyPanelLayoutMode(panel);

  safeAppendChild(panel);
  state.mainPanel = panel;
  wireReqFilterInteractionsOnce(panel);
  bindSettingsWorkbench(panel);
  refreshFilterChipHighlight();
  refreshMainWorkbench();
}

function hydrateSettingsWorkbench() {
  if (!state.mainPanel) return;
  var panel = state.mainPanel;
  var cfg = state.config || {};
  function setVal(sel, val) {
    var el = panel.querySelector(sel);
    if (el) el.value = val == null ? '' : val;
  }
  function setChecked(sel, val) {
    var el = panel.querySelector(sel);
    if (el) el.checked = !!val;
  }
  setVal('.ai-req-settings-apikey', cfg.apiKey || '');
  setVal('.ai-req-settings-baseurl', cfg.baseURL || DEFAULT_CONFIG.baseURL);
  setVal('.ai-req-settings-model', cfg.model || DEFAULT_CONFIG.model);
  setVal('.ai-req-settings-mcp-port', cfg.mcpPort || 9527);
  setVal('.ai-req-settings-mcp-token', cfg.mcpToken || '');
  setVal('.ai-req-settings-mcp-tool-naming', cfg.mcpToolNaming === 'compact' ? 'compact' : 'full');
  setChecked('.ai-req-settings-mcp-auto-sync', !!cfg.mcpAutoSync);
  setChecked('.ai-req-settings-flow-ctx-list', cfg.enableFlowContextListTool !== false);
  setChecked('.ai-req-settings-flow-ctx-detail', cfg.enableFlowContextDetailTool !== false);
  setChecked('.ai-req-settings-flow-ctx-brainstorm', cfg.enableBrainstormMcpTool !== false);
  setVal('.ai-req-settings-mcp-export-path', cfg.mcpExportPath || '');
  setVal('.ai-req-settings-env-replay-prod', (state.envReplayConfig && state.envReplayConfig.prodOrigin) || '');
  setVal('.ai-req-settings-env-replay-token-key', (state.envReplayConfig && state.envReplayConfig.tokenStorageKey) || 'token');
  setVal('.ai-req-settings-env-replay-manual-token', (state.envReplayConfig && state.envReplayConfig.manualToken) || '');
  setVal('.ai-req-settings-env-replay-prod-headers', (state.envReplayConfig && state.envReplayConfig.prodHeaders) ? JSON.stringify(state.envReplayConfig.prodHeaders, null, 2) : '');
  setChecked('.ai-req-settings-enhanced-gen', !!state.mcpUseEnhancedGeneration);
  var reqEnhCb = panel.querySelector('.ai-req-enhanced-gen-cb');
  if (reqEnhCb) reqEnhCb.checked = !!state.mcpUseEnhancedGeneration;
}

function syncEnhancedGenCheckboxes(panel, checked) {
  var root = panel || state.mainPanel;
  if (!root) return;
  state.mcpUseEnhancedGeneration = !!checked;
  var settingsCb = root.querySelector('.ai-req-settings-enhanced-gen');
  var reqCb = root.querySelector('.ai-req-enhanced-gen-cb');
  if (settingsCb) settingsCb.checked = !!checked;
  if (reqCb) reqCb.checked = !!checked;
}

function saveSettingsWorkbench(panel) {
  var root = panel || state.mainPanel;
  if (!root) return;
  function val(sel) {
    var el = root.querySelector(sel);
    return el ? el.value.trim() : '';
  }
  function checked(sel) {
    var el = root.querySelector(sel);
    return !!(el && el.checked);
  }
  state.config.apiKey = val('.ai-req-settings-apikey');
  state.config.baseURL = val('.ai-req-settings-baseurl') || DEFAULT_CONFIG.baseURL;
  state.config.model = val('.ai-req-settings-model') || DEFAULT_CONFIG.model;
  var portVal = parseInt(val('.ai-req-settings-mcp-port'), 10);
  state.config.mcpPort = (portVal > 0 && portVal <= 65535) ? portVal : 9527;
  state.config.mcpToken = val('.ai-req-settings-mcp-token');
  state.config.mcpToolNaming = val('.ai-req-settings-mcp-tool-naming') === 'compact' ? 'compact' : 'full';
  state.config.mcpAutoSync = checked('.ai-req-settings-mcp-auto-sync');
  state.config.enableFlowContextListTool = checked('.ai-req-settings-flow-ctx-list');
  state.config.enableFlowContextDetailTool = checked('.ai-req-settings-flow-ctx-detail');
  state.config.enableBrainstormMcpTool = checked('.ai-req-settings-flow-ctx-brainstorm');
  state.config.mcpExportPath = val('.ai-req-settings-mcp-export-path');
  var envProdOrigin = val('.ai-req-settings-env-replay-prod');
  var envTokenKey = val('.ai-req-settings-env-replay-token-key');
  var envManualToken = val('.ai-req-settings-env-replay-manual-token');
  var envProdHeaders = val('.ai-req-settings-env-replay-prod-headers');
  saveEnvReplayConfig(envProdOrigin, envTokenKey, envManualToken, envProdHeaders);
  syncEnhancedGenCheckboxes(root, checked('.ai-req-settings-enhanced-gen'));
  saveConfig();
  showToast('设置已保存', 2500, 'success');
  try {
    chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
  } catch (eSync) {}
}

function bindSettingsWorkbench(panel) {
  var saveBtn = panel.querySelector('.ai-req-settings-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      saveSettingsWorkbench(panel);
    });
  }
  var legacyBtn = panel.querySelector('.ai-req-settings-open-legacy');
  if (legacyBtn) {
    legacyBtn.addEventListener('click', function () {
      openConfigPanel();
    });
  }
  var clearRulesBtn = panel.querySelector('.ai-req-settings-clear-rules');
  if (clearRulesBtn) {
    clearRulesBtn.addEventListener('click', function () {
      clearAllMockRules();
    });
  }
  var enhCb = panel.querySelector('.ai-req-settings-enhanced-gen');
  if (enhCb) {
    enhCb.addEventListener('change', function () {
      syncEnhancedGenCheckboxes(panel, enhCb.checked);
    });
  }
}

function makeDraggable(element, handle) {
  var isDragging = false;
  var startX, startY, startLeft, startTop;
  var hasDragged = false;

  handle.addEventListener('mousedown', function (e) {
    if (e.target.tagName === 'BUTTON') return;
    ensureMainUiState();
    if (state.ui.layoutMode === 'wide') return;
    isDragging = true;
    hasDragged = false;
    startX = e.clientX;
    startY = e.clientY;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    var rect = element.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    element.style.left = startLeft + 'px';
    element.style.top = startTop + 'px';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasDragged = true;
    }
    var newLeft = Math.max(0, Math.min(window.innerWidth - element.offsetWidth, startLeft + dx));
    var newTop = Math.max(0, Math.min(window.innerHeight - element.offsetHeight, startTop + dy));
    element.style.left = newLeft + 'px';
    element.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (!isDragging) return;
    isDragging = false;
    if (hasDragged) {
      storageSet(getScopedStorageKey('ai_req_panel_position'), JSON.stringify({
        left: parseInt(element.style.left),
        top: parseInt(element.style.top)
      }));
    }
  });
}

function getActiveListKeyword() {
  ensureMainUiState();
  if (typeof state.ui.requestKeyword === 'string') return state.ui.requestKeyword.trim();
  var kw = '';
  if (state.mainPanel) {
    var si = state.mainPanel.querySelector('.ai-req-search-input');
    if (si) kw = (si.value || '').trim();
  }
  return kw;
}

function duplicateSignatureCounts(records) {
  var mp = {};
  for (var i = 0; i < records.length; i++) {
    var s = computeRequestSignature(records[i]);
    mp[s] = (mp[s] || 0) + 1;
  }
  return mp;
}

function removeDuplicateRequestRecordsBySignature() {
  var records = state.requestRecords || [];
  if (records.length < 2) return 0;
  var seen = Object.create(null);
  var kept = [];
  var removedIds = Object.create(null);
  var i;
  for (i = 0; i < records.length; i++) {
    var rec = records[i];
    var sig = computeRequestSignature(rec);
    if (seen[sig]) {
      removedIds[rec.id] = true;
      continue;
    }
    seen[sig] = true;
    kept.push(rec);
  }
  var removed = records.length - kept.length;
  if (!removed) return 0;
  state.requestRecords = kept;
  for (var id in state.selectedReqIds) {
    if (removedIds[id]) delete state.selectedReqIds[id];
  }
  if (state.selectedReqId && removedIds[state.selectedReqId]) state.selectedReqId = null;
  if (state.ui && state.ui.requestTable && state.ui.requestTable.selectedId && removedIds[state.ui.requestTable.selectedId]) {
    state.ui.requestTable.selectedId = null;
    state.ui.requestTable.detailOpen = false;
    state.expandedReqId = null;
  }
  if (state.selectedRewriteReqId && removedIds[state.selectedRewriteReqId]) state.selectedRewriteReqId = null;
  return removed;
}

function passesMethodChip(rec, methodsObj) {
  var chosen = false;
  for (var mk in methodsObj) {
    if (methodsObj.hasOwnProperty(mk) && methodsObj[mk]) chosen = true;
  }
  if (!chosen) return true;
  var up = (rec.method || 'GET').toUpperCase();
  return !!methodsObj[up];
}

function recordShowsMocked(rec) {
  var raw = findDebugRule(rec.originalUrl || rec.url, rec.method);
  var ar = raw ? normalizeRule(raw) : null;
  return !!(rec.isMocked === true || (ar && hasResponseBodyMock(ar)));
}

function passesListFiltersExtras(rec, dupCounts, dupOnly) {
  var lf = state.listFilters || {};
  if (dupOnly && dupCounts) {
    var sig = computeRequestSignature(rec);
    if ((dupCounts[sig] || 0) < 2) return false;
  }
  if (lf.mock === 'mocked' && !recordShowsMocked(rec)) return false;
  if (lf.mock === 'plain' && recordShowsMocked(rec)) return false;
  if (lf.analyzed === 'done' && !(rec.aiAnalysis != null && rec.aiAnalysis !== '')) return false;
  if (lf.analyzed === 'pending' && (rec.aiAnalysis != null && rec.aiAnalysis !== '')) return false;
  if (!passesMethodChip(rec, lf.methods || {})) return false;
  return true;
}

function filterRequestRecords(records, keyword) {
  var filt = records;
  if (keyword) {
    var kw = keyword.toLowerCase();
    filt = records.filter(function (r) {
      return String(r.url || '').toLowerCase().indexOf(kw) !== -1 ||
        (r.aiAnalysis && r.aiAnalysis.toLowerCase().indexOf(kw) !== -1);
    });
  }
  var lf = state.listFilters || {};
  var dc = lf.dupOnly ? duplicateSignatureCounts(filt) : null;
  return filt.filter(function (r2) {
    return passesListFiltersExtras(r2, dc, !!lf.dupOnly);
  });
}

function selectionCountRequests() {
  var n = 0;
  for (var rq in state.selectedReqIds) {
    if (state.selectedReqIds[rq]) n++;
  }
  return n;
}

function pruneSelectedReqIdsToMatchRecords(visibleRecords) {
  var allow = {};
  for (var i = 0; i < visibleRecords.length; i++) {
    allow[visibleRecords[i].id] = true;
  }
  var nx = {};
  for (var id in state.selectedReqIds) {
    if (state.selectedReqIds[id] && allow[id]) nx[id] = true;
  }
  state.selectedReqIds = nx;
}

function setAllRecordsSelection(recordsList, chk) {
  if (!state.selectedReqIds || typeof state.selectedReqIds !== 'object') state.selectedReqIds = {};
  for (var ij = 0; ij < recordsList.length; ij++) {
    var rid = recordsList[ij].id;
    if (chk) state.selectedReqIds[rid] = true;
    else delete state.selectedReqIds[rid];
  }
}

function recordGroupMeta(rec, groupMode) {
  try {
    if (groupMode === 'host') {
      return new URL(rec.url || '').hostname || location.hostname || 'host';
    }
    if (groupMode === 'endpoint') {
      var mh = (rec.method || 'GET').toUpperCase();
      try {
        return mh + ' ' + new URL(rec.originalUrl || rec.url || '').pathname;
      } catch (e1) {
        return mh + ' ';
      }
    }
  } catch (e2) {}
  return '其他';
}

function groupRecordsSorted(records, groupMode) {
  if (!groupMode || groupMode === 'none') return { keys: [], map: {}, useFlat: true, flat: records };
  var order = [];
  var mp = {};
  for (var g = 0; g < records.length; g++) {
    var rec = records[g];
    var gn = recordGroupMeta(rec, groupMode);
    if (!mp[gn]) {
      mp[gn] = [];
      order.push(gn);
    }
    mp[gn].push(rec);
  }
  return { keys: order, map: mp, useFlat: false };
}

function refreshFilterChipHighlight() {
  if (!state.mainPanel) return;
  var lf = state.listFilters || {};

  function chip(name1, active) {
    var ch = state.mainPanel.querySelector('[data-filter-chip="' + name1 + '"]');
    if (ch) ch.classList.toggle('ai-req-chip-active', active);
  }

  chip('dup', !!lf.dupOnly);

  var mockKeys = [['all'], ['mocked'], ['plain']];
  mockKeys.forEach(function (tuple) {
    var q = '[data-mock-filter-chip="' + tuple[0] + '"]';
    var cel = state.mainPanel.querySelector(q);
    if (cel) cel.classList.toggle('ai-req-chip-active', lf.mock === tuple[0]);
  });

  var anKeys = ['all', 'done', 'pending'];
  for (var ai = 0; ai < anKeys.length; ai++) {
    var ax = state.mainPanel.querySelector('[data-analyzed-filter-chip="' + anKeys[ai] + '"]');
    if (ax) ax.classList.toggle('ai-req-chip-active', lf.analyzed === anKeys[ai]);
  }

  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].forEach(function (mh) {
    var btn = state.mainPanel.querySelector('[data-method-chip="' + mh + '"]');
    if (btn) btn.classList.toggle('ai-req-chip-active', !!(lf.methods && lf.methods[mh]));
  });

  var gsel = state.mainPanel.querySelector('.ai-req-group-select');
  if (gsel) gsel.value = lf.groupMode || 'none';

  var ech = state.mainPanel.querySelector('.ai-req-enhanced-gen-cb');
  if (ech) ech.checked = !!state.mcpUseEnhancedGeneration;
}

function wireReqFilterInteractionsOnce(panel) {
  if (panel._wireReqFiltersOnce) return;
  panel._wireReqFiltersOnce = true;

  panel.addEventListener('click', function (ev) {
    var tg = ev.target;
    var dedupeReqBtn = tg.closest && tg.closest('.ai-req-dedupe-reqs-btn');
    if (dedupeReqBtn) {
      if (!confirm('\u6309 METHOD+\u8DEF\u5F84+\u67E5\u8BE2+\u8BF7\u6C42\u4F53\u6307\u7EB9\u5220\u9664\u91CD\u590D\uFF0C\u6BCF\u6761\u7B7E\u540D\u4EC5\u4FDD\u7559\u9996\u6761\u8BB0\u5F55\u3002\u786E\u5B9A\uFF1F')) return;
      var nRm = removeDuplicateRequestRecordsBySignature();
      refreshRequestList(getActiveListKeyword(), false);
      showToast(nRm ? '\u5DF2\u5220\u9664\u91CD\u590D ' + nRm + ' \u6761' : '\u65E0\u91CD\u590D\u8BF7\u6C42');
      return;
    }
    var chipDupEl = tg.closest && tg.closest('[data-filter-chip="dup"]');
    if (chipDupEl) {
      state.listFilters.dupOnly = !state.listFilters.dupOnly;
      refreshFilterChipHighlight();
      refreshRequestList(undefined, false);
      return;
    }
    var mfc = tg.closest && tg.closest('[data-mock-filter-chip]');
    if (mfc && mfc.dataset.mockFilterChip) {
      state.listFilters.mock = mfc.dataset.mockFilterChip;
      refreshFilterChipHighlight();
      refreshRequestList(undefined, false);
      return;
    }
    var afc = tg.closest && tg.closest('[data-analyzed-filter-chip]');
    if (afc && afc.dataset.analyzedFilterChip) {
      state.listFilters.analyzed = afc.dataset.analyzedFilterChip;
      refreshFilterChipHighlight();
      refreshRequestList(undefined, false);
      return;
    }
    var mthc = tg.closest && tg.closest('[data-method-chip]');
    if (mthc && mthc.dataset.methodChip) {
      var lm = mthc.dataset.methodChip;
      if (!state.listFilters.methods) state.listFilters.methods = {};
      state.listFilters.methods[lm] = !state.listFilters.methods[lm];
      refreshFilterChipHighlight();
      refreshRequestList(undefined, false);
    }
  });

  panel.addEventListener('change', function (evc) {
    if (evc.target && evc.target.classList && evc.target.classList.contains('ai-req-group-select')) {
      state.listFilters.groupMode = evc.target.value || 'none';
      refreshRequestList(undefined, false);
    }
    if (evc.target && evc.target.classList && evc.target.classList.contains('ai-req-enhanced-gen-cb')) {
      syncEnhancedGenCheckboxes(panel, evc.target.checked);
    }
  });

  var bulkInner = panel.querySelector('.ai-req-req-bulk-bar');
  if (bulkInner && !bulkInner._bulkOnce) {
    bulkInner._bulkOnce = true;
    bulkInner.addEventListener('click', function (be) {
      var bbtn = be.target.closest && be.target.closest('[data-bulk-act]');
      if (!bbtn) return;
      var act = bbtn.getAttribute('data-bulk-act');
      function selectedRecsInner() {
        var sm = {};
        for (var k in state.selectedReqIds) if (state.selectedReqIds[k]) sm[k] = true;
        return state.requestRecords.filter(function (rr) {
          return sm[rr.id];
        });
      }
      if (act === 'clear-selection') {
        state.selectedReqIds = {};
      } else if (act === 'bulk-ai') {
        var lids = [];
        for (var k2 in state.selectedReqIds) if (state.selectedReqIds[k2]) lids.push(k2);
        analyzeRequestsSequential(lids).catch(function () {});
      } else if (act === 'bulk-mcp-selected') {
        var genFnSel = typeof pickGeneratorForRequests === 'function' ? pickGeneratorForRequests() : generateMcpToolsFromRecords;
        var tlsSel = genFnSel(selectedRecsInner());
        var bulkSt = mergeGeneratedMcpToolsIntoState(tlsSel);
        if (bulkSt.added > 0) {
          saveMcpTools();
          chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
        }
        showToast('\u751F\u6210 \u65B0\u589E ' + bulkSt.added + '\uFF0C\u8DF3\u8FC7 ' + bulkSt.skipped);
      }
      refreshRequestList(undefined, false);
    });
  }
}

function findRequestById(reqId) {
  for (var i = 0; i < state.requestRecords.length; i++) {
    if (state.requestRecords[i].id === reqId) return state.requestRecords[i];
  }
  return null;
}

function refreshArchivedFlowRecordsForActiveSession() {
  if (!state.flowRecording || !state.activeFlowRecordStorageKey) return 0;
  ensureFlowState();
  var now = Date.now();
  if (
    state.flowUi.lastArchiveRefreshKey === state.activeFlowRecordStorageKey &&
    now - (state.flowUi.lastArchiveRefreshAt || 0) < 1500
  ) {
    return 0;
  }
  state.flowUi.lastArchiveRefreshKey = state.activeFlowRecordStorageKey;
  state.flowUi.lastArchiveRefreshAt = now;
  var before = state.requestRecords.length;
  loadArchivedFlowRecords(state.activeFlowRecordStorageKey);
  var added = state.requestRecords.length - before;
  var freshKey = state.activeFlowRecordStorageKey;
  if (typeof loadArchivedFlowRecordsFresh === 'function') {
    loadArchivedFlowRecordsFresh(freshKey, function (freshAdded) {
      if (!freshAdded) return;
      if (!state.flowRecording || state.activeFlowRecordStorageKey !== freshKey) return;
      if (!state.isPanelOpen || !state.ui || state.ui.activeMainTab !== 'flow') return;
      refreshFlowWorkbench();
    });
  }
  return added;
}

function renderRequestSummary(filtered) {
  if (!state.mainPanel) return;
  var el = state.mainPanel.querySelector('.ai-req-request-summary');
  if (!el) return;
  var analyzed = 0;
  var mocked = 0;
  for (var i = 0; i < filtered.length; i++) {
    if (filtered[i].aiAnalysis) analyzed++;
    if (recordShowsMocked(filtered[i])) mocked++;
  }
  var dupCount = countDuplicateRequests(state.requestRecords);
  var sel = selectionCountRequests();
  el.innerHTML = '';
  var stats = [
    { label: '显示', value: filtered.length },
    { label: '已分析', value: analyzed },
    { label: 'Mock', value: mocked },
    { label: '重复', value: dupCount },
    { label: '已选', value: sel }
  ];
  for (var s = 0; s < stats.length; s++) {
    var chip = document.createElement('span');
    chip.className = 'ai-req-summary-chip';
    var lbl = document.createElement('span');
    lbl.className = 'ai-req-summary-label';
    lbl.textContent = stats[s].label;
    var val = document.createElement('span');
    val.className = 'ai-req-summary-value';
    val.textContent = String(stats[s].value);
    chip.appendChild(lbl);
    chip.appendChild(val);
    el.appendChild(chip);
  }
}

function renderRequestInspector(req, kwEffective) {
  if (!state.mainPanel) return;
  var body = state.mainPanel.querySelector('.ai-req-request-inspector-body');
  var titleEl = state.mainPanel.querySelector('.ai-req-request-inspector-title');
  if (!body) return;
  if (!req) {
    if (titleEl) titleEl.textContent = '请求详情';
    body.innerHTML = '<div class="ai-req-inspector-empty">选择一条请求查看详情</div>';
    return;
  }
  if (titleEl) {
    titleEl.textContent = (req.method || 'GET') + ' ' + extractRequestPath(req.url);
  }
  body.innerHTML = buildDetailHTML(req);
  bindDetailEvents(body, req, kwEffective);
}

function appendRequestRowToList(listElInner, req, kwEffective) {
  ensureMainUiState();
  var selectedId = state.ui.requestTable.selectedId;

  var itemInner = document.createElement('div');
  itemInner.className = 'ai-req-request-item';
  if (selectedId === req.id) itemInner.classList.add('ai-req-request-selected');
  itemInner.setAttribute('data-id', req.id);

  var rowWrap = document.createElement('div');
  rowWrap.className = 'ai-req-request-row-wrap';

  var cbCell = document.createElement('label');
  cbCell.className = 'ai-req-req-checkbox-cell';
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ai-req-req-select-cb';
  cb.checked = !!state.selectedReqIds[req.id];
  cb.addEventListener('click', function (e2) {
    e2.stopPropagation();
  });
  cb.addEventListener('change', function () {
    if (cb.checked) state.selectedReqIds[req.id] = true;
    else delete state.selectedReqIds[req.id];
    syncRequestSelectionChrome();
  });
  cbCell.appendChild(cb);

  var rowInner = document.createElement('div');
  rowInner.className = 'ai-req-request-row';

  var methodTag2 = document.createElement('span');
  methodTag2.className = 'ai-req-method-tag ai-req-method-' + getMethodClass(req.method);
  methodTag2.textContent = req.method;

  var pathText = document.createElement('span');
  pathText.className = 'ai-req-path-text';
  var pathStr = extractRequestPath(req.url);
  pathText.textContent = truncateURL(pathStr, 48);
  pathText.title = req.url;

  var statusCode2 = document.createElement('span');
  statusCode2.className = 'ai-req-status-code ' + getStatusClass(req.responseStatus);
  statusCode2.textContent = req.responseStatus;

  var duration2 = document.createElement('span');
  duration2.className = 'ai-req-duration';
  duration2.textContent = req.duration + 'ms';

  var flagsWrap = document.createElement('span');
  flagsWrap.className = 'ai-req-row-flags';

  var aiIcon2 = document.createElement('span');
  aiIcon2.className = 'ai-req-icon-indicator ' + (req.aiAnalysis ? 'ai-req-ai-analyzed' : 'ai-req-ai-not-analyzed');
  aiIcon2.textContent = req.aiAnalysis ? 'AI' : '-';
  aiIcon2.title = req.aiAnalysis ? '已AI分析' : '未AI分析';

  var mockShown = recordShowsMocked(req);
  var mockIcon2 = document.createElement('span');
  mockIcon2.className = 'ai-req-icon-indicator ' + (mockShown ? 'ai-req-mock-active' : 'ai-req-mock-inactive');
  mockIcon2.textContent = mockShown ? 'M' : '-';
  mockIcon2.title = mockShown ? '已Mock' : '未Mock';

  var activeRule2 = req.debugRule || findDebugRule(req.originalUrl || req.url, req.method);
  var tags2 = buildDebugTagElement(activeRule2);

  flagsWrap.appendChild(aiIcon2);
  flagsWrap.appendChild(mockIcon2);
  if (tags2) flagsWrap.appendChild(tags2);

  if (req.envReplayHit) {
    var pfTag = document.createElement('span');
    pfTag.className = 'ai-req-icon-indicator ai-req-envreplay-tag';
    pfTag.textContent = 'ProdFetch';
    pfTag.title = '正式数据回放' + (req.envReplaySource ? ' · ' + req.envReplaySource : '');
    flagsWrap.appendChild(pfTag);
  } else if (req.envReplayError) {
    var pfErr = document.createElement('span');
    pfErr.className = 'ai-req-icon-indicator ai-req-envreplay-error';
    pfErr.textContent = 'ProdFail';
    pfErr.title = '正式回放失败：' + req.envReplayError;
    flagsWrap.appendChild(pfErr);
  }

  rowInner.appendChild(methodTag2);
  rowInner.appendChild(pathText);
  rowInner.appendChild(statusCode2);
  rowInner.appendChild(duration2);
  rowInner.appendChild(flagsWrap);

  // 跨环境 mock 内联按钮（仅当已配置正式域名且当前站点非正式域名时显示）
  if (isEnvReplayConfiguredForCurrentHost()) {
    var envReplayActions = document.createElement('span');
    envReplayActions.className = 'ai-req-row-env-actions';

    var reqMethod = String(req.method || 'GET').toUpperCase();
    var reqParsed;
    try { reqParsed = new URL(req.originalUrl || req.url, location.href); } catch (e) { reqParsed = null; }
    var reqPathname = reqParsed ? reqParsed.pathname : (req.originalUrl || req.url);
    var reqQuery = reqParsed && reqParsed.search ? reqParsed.search.substring(1) : '';
    var isGet = reqMethod === 'GET';

    var selKeyNoQ = buildEnvReplaySelectionKey(reqMethod, reqPathname, '', false);
    var selKeyQ = buildEnvReplaySelectionKey(reqMethod, reqPathname, reqQuery, true);
    var sels = state.envReplaySelections || {};
    var envEnabled = (sels[selKeyNoQ] && sels[selKeyNoQ].enabled) || (sels[selKeyQ] && sels[selKeyQ].enabled);

    var envBtn = document.createElement('button');
    envBtn.type = 'button';
    envBtn.className = 'ai-req-row-env-btn' + (envEnabled ? ' ai-req-row-env-btn-active' : '');
    // 显示当前生效模式
    var activeMode = '';
    if (envEnabled) {
      var actSel = sels[selKeyNoQ] && sels[selKeyNoQ].enabled ? sels[selKeyNoQ] : (sels[selKeyQ] && sels[selKeyQ].enabled ? sels[selKeyQ] : null);
      activeMode = actSel ? actSel.mode : '';
    }
    envBtn.textContent = envEnabled ? ('跨环境' + (activeMode === 'persistent' ? '∞' : '●')) : '跨环境';
    envBtn.title = isGet
      ? (envEnabled
          ? '已启用正式数据回放（' + (activeMode === 'persistent' ? '持续' : '仅下一次') + '），点击关闭'
          : '启用正式数据回放：选择「仅下一次」或「持续」')
      : '仅支持 GET';
    if (!isGet) envBtn.disabled = true;
    envBtn.addEventListener('click', function (e2) {
      e2.stopPropagation();
      if (!isGet) return;
      if (envEnabled) {
        removeEnvReplaySelection(reqMethod, reqPathname, reqQuery, false);
        removeEnvReplaySelection(reqMethod, reqPathname, reqQuery, true);
        refreshRequestList(undefined, true);
      } else {
        // 弹出小菜单选择生效模式
        openEnvReplayModeMenu(envBtn, function (mode) {
          upsertEnvReplaySelection(reqMethod, reqPathname, reqQuery, false, true, mode);
          refreshRequestList(undefined, true);
        });
      }
    });
    envReplayActions.appendChild(envBtn);

    // 独立测试按钮：立即向正式环境拉一次，预览结果（不修改 selections）
    if (isGet) {
      var testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'ai-req-row-env-test-btn';
      testBtn.textContent = '测试';
      testBtn.title = '立即向正式环境拉取一次该接口，预览响应（不改勾选状态）';
      testBtn.addEventListener('click', function (e3) {
        e3.stopPropagation();
        testEnvReplayForRequest(reqMethod, reqPathname, reqQuery, req);
      });
      envReplayActions.appendChild(testBtn);
    }

    rowInner.appendChild(envReplayActions);
  }

  rowInner.addEventListener('click', function () {
    ensureMainUiState();
    var sid = state.ui.requestTable.selectedId;
    if (sid === req.id) {
      if (state.ui.layoutMode !== 'wide') {
        state.ui.requestTable.detailOpen = !state.ui.requestTable.detailOpen;
      }
    } else {
      state.ui.requestTable.selectedId = req.id;
      state.ui.requestTable.detailOpen = true;
      state.selectedReqId = req.id;
    }
    state.expandedReqId = state.ui.requestTable.detailOpen ? req.id : null;
    refreshRequestList(kwEffective, true);
  });

  rowWrap.appendChild(cbCell);
  rowWrap.appendChild(rowInner);
  itemInner.appendChild(rowWrap);
  listElInner.appendChild(itemInner);
}

function refreshRequestList(keyword, skipPruneSel) {
  if (!state.mainPanel) return;
  ensureMainUiState();
  var kwEffective = typeof keyword === 'undefined' ? getActiveListKeyword() : keyword;
  state.ui.requestKeyword = (kwEffective || '').trim();
  var searchInput = state.mainPanel.querySelector('.ai-req-search-input');
  if (searchInput && searchInput.value.trim() !== state.ui.requestKeyword) {
    searchInput.value = state.ui.requestKeyword;
  }

  var listEl = state.mainPanel.querySelector('.ai-req-request-list');
  var countEl = state.mainPanel.querySelector('.ai-req-req-count');
  if (!listEl || !countEl) return;
  var savedScrollTop = listEl.scrollTop;
  listEl.innerHTML = '';

  var filtered = filterRequestRecords(state.requestRecords, kwEffective);
  if (!skipPruneSel) {
    pruneSelectedReqIdsToMatchRecords(filtered);
  }

  var selId = state.ui.requestTable.selectedId;
  if (selId) {
    var stillThere = false;
    for (var si = 0; si < filtered.length; si++) {
      if (filtered[si].id === selId) {
        stillThere = true;
        break;
      }
    }
    if (!stillThere) {
      state.ui.requestTable.selectedId = null;
      state.ui.requestTable.detailOpen = false;
      state.expandedReqId = null;
      selId = null;
    }
  }

  var bulkBarOuter = state.mainPanel.querySelector('.ai-req-req-bulk-bar');
  if (bulkBarOuter) {
    var bn = selectionCountRequests();
    bulkBarOuter.style.display = bn > 0 ? 'flex' : 'none';
    var spn = bulkBarOuter.querySelector('.ai-req-req-bulk-count');
    if (spn) spn.textContent = '已选 ' + bn;
  }

  countEl.textContent = filtered.length + ' 请求';
  renderRequestSummary(filtered);
  syncShellChrome();

  var tableHead = state.mainPanel.querySelector('.ai-req-request-table-head');
  if (tableHead) {
    var showHead = state.ui.layoutMode === 'wide' || filtered.length > 0;
    tableHead.style.display = showHead ? 'flex' : 'none';
  }

  if (filtered.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'ai-req-empty-state';
    var lf0 = state.listFilters || {};
    var hasExtras = !!(kwEffective || lf0.dupOnly || lf0.mock !== 'all' || lf0.analyzed !== 'all');
    empty.textContent = hasExtras ?
      '没有匹配的请求' :
      '暂无请求记录';
    listEl.appendChild(empty);
    renderRequestInspector(null, kwEffective);
    syncRequestInspectorVisibility();
    listEl.scrollTop = savedScrollTop;
    return;
  }

  var selectStrip = document.createElement('div');
  selectStrip.className = 'ai-req-select-all-strip';
  var cbAllLbl = document.createElement('label');
  cbAllLbl.className = 'ai-req-select-all-label';
  var cbAll = document.createElement('input');
  cbAll.type = 'checkbox';
  cbAll.className = 'ai-req-req-select-all-cb';
  cbAll.checked = (function selAllCHK(arr) {
    for (var h = 0; h < arr.length; h++) {
      if (!state.selectedReqIds[arr[h].id]) return false;
    }
    return true;
  })(filtered);
  cbAll.addEventListener('change', function () {
    setAllRecordsSelection(filtered, cbAll.checked);
    refreshRequestList(kwEffective, true);
  });
  cbAllLbl.appendChild(cbAll);
  cbAllLbl.appendChild(document.createTextNode(' 全选当前'));
  selectStrip.appendChild(cbAllLbl);
  listEl.appendChild(selectStrip);

  var grp = groupRecordsSorted(filtered, state.listFilters.groupMode || 'none');

  function renderSubset(arrSubs) {
    var revSubs = arrSubs.slice().reverse();
    for (var rs = 0; rs < revSubs.length; rs++) {
      appendRequestRowToList(listEl, revSubs[rs], kwEffective);
    }
  }

  if (grp.useFlat) {
    renderSubset(filtered);
  } else {
    for (var gi = 0; gi < grp.keys.length; gi++) {
      var gnk = grp.keys[gi];
      var headEl = document.createElement('div');
      headEl.className = 'ai-req-group-header';
      headEl.textContent = gnk + ' （' + grp.map[gnk].length + '条）';
      listEl.appendChild(headEl);
      renderSubset(grp.map[gnk]);
    }
  }

  var selectedReq = selId ? findRequestById(selId) : null;
  if (state.ui.layoutMode === 'wide' && selectedReq && state.ui.requestTable.detailOpen) {
    state.ui.requestTable.detailOpen = true;
  }
  renderRequestInspector(
    state.ui.requestTable.detailOpen ? selectedReq : null,
    kwEffective
  );
  syncRequestInspectorVisibility();
  listEl.scrollTop = savedScrollTop;
}

function getMethodClass(method) {
  var m = (method || '').toUpperCase();
  if (m === 'GET') return 'GET';
  if (m === 'POST') return 'POST';
  if (m === 'PUT') return 'PUT';
  if (m === 'DELETE') return 'DELETE';
  if (m === 'PATCH') return 'PATCH';
  return 'OTHER';
}

function getStatusClass(code) {
  if (code >= 200 && code < 300) return 'ai-req-status-2xx';
  if (code >= 300 && code < 400) return 'ai-req-status-3xx';
  if (code >= 400 && code < 500) return 'ai-req-status-4xx';
  if (code >= 500) return 'ai-req-status-5xx';
  return 'ai-req-status-0';
}

function truncateURL(url, max) {
  if (url.length <= max) return url;
  return url.substring(0, max) + '...';
}

function buildDebugTagElement(rule) {
  if (!rule) return null;
  rule = normalizeRule(rule);
  var tagNames = [];
  if (hasResponseBodyMock(rule)) tagNames.push('Mock');
  if (hasResponsePatches(rule)) tagNames.push('Patch');
  if (hasRequestRewrite(rule)) tagNames.push('Req');
  if (hasResponseHeaderRewrite(rule)) tagNames.push('ResH');
  if (rule.once) tagNames.push('Once');
  if (!tagNames.length) return null;
  var wrap = document.createElement('span');
  wrap.className = 'ai-req-debug-tags';
  tagNames.forEach(function (name) {
    var tag = document.createElement('span');
    tag.className = 'ai-req-debug-tag';
    tag.textContent = name;
    wrap.appendChild(tag);
  });
  return wrap;
}

function buildDetailHTML(req) {
  var html = '';
  var activeRule = req.debugRule || findDebugRule(req.originalUrl || req.url, req.method);

  html += '<div class="ai-req-detail-section">';
  html += '<div class="ai-req-detail-label">请求信息</div>';
  html += '<div class="ai-req-detail-value"><strong>方法:</strong> ' + escapeHtml(req.method) + '</div>';
  if (req.originalUrl && req.originalUrl !== req.url) {
    html += '<div class="ai-req-detail-value"><strong>原始URL:</strong> ' + escapeHtml(req.originalUrl) + '</div>';
  }
  html += '<div class="ai-req-detail-value"><strong>URL:</strong> ' + escapeHtml(req.url) + '</div>';
  html += buildCollapsible('请求头', formatJson(req.requestHeaders));
  html += buildCollapsible('请求体', formatJson(req.requestBody));
  html += '</div>';

  html += '<div class="ai-req-detail-section">';
  html += '<div class="ai-req-detail-label">响应信息</div>';
  html += '<div class="ai-req-detail-value"><strong>状态码:</strong> ' + req.responseStatus + '</div>';
  html += buildCollapsible('响应头', formatJson(req.responseHeaders));
  html += buildCollapsible('响应体', formatJson(req.responseBody));
  html += '</div>';

  html += '<div class="ai-req-detail-section">';
  html += '<div class="ai-req-detail-label">AI分析</div>';
  if (req.aiAnalysis) {
    html += '<div class="ai-req-ai-result">' + escapeHtml(req.aiAnalysis) + '</div>';
  } else {
    html += '<button class="ai-req-btn ai-req-btn-primary ai-req-analyze-single-btn" data-id="' + req.id + '">\u2728 AI分析</button>';
  }
  html += '</div>';

  html += '<div class="ai-req-detail-section">';
  html += '<div class="ai-req-detail-label">调试规则</div>';
  if (activeRule) {
    html += '<div class="ai-req-mock-info">\u5F53\u524D\u8BF7\u6C42\u547D\u4E2D\u8C03\u8BD5\u89C4\u5219</div>';
    html += '<div class="ai-req-mock-btn-group">';
    html += '<button class="ai-req-btn ai-req-btn-primary ai-req-edit-rewrite-btn" data-id="' + req.id + '">高级改写</button>';
    html += '<button class="ai-req-btn ai-req-btn-success ai-req-replay-btn" data-id="' + req.id + '">\uD83D\uDD04 \u5237\u65B0\u9875\u9762\u751F\u6548</button>';
    html += '<button class="ai-req-btn ai-req-btn-danger ai-req-cancel-mock-btn" data-id="' + req.id + '">\u53D6\u6D88\u89C4\u5219</button>';
    html += '</div>';
    html += buildCollapsible('调试规则', formatJson(activeRule));
    if (req.mockData !== null && req.mockData !== undefined) {
      html += buildCollapsible('Mock\u6570\u636E', formatJson(req.mockData));
    }
  } else {
    html += '<div class="ai-req-mock-btn-group">';
    html += '<button class="ai-req-btn ai-req-btn-primary ai-req-edit-mock-btn" data-id="' + req.id + '">\u270F \u4FEE\u6539\u54CD\u5E94</button>';
    html += '<button class="ai-req-btn ai-req-btn-secondary ai-req-edit-rewrite-btn" data-id="' + req.id + '">高级改写</button>';
    html += '<button class="ai-req-btn ai-req-detail-btn ai-req-mcp-gen-btn" data-req-id="' + req.id + '">\uD83D\uDD27 \u751F\u6210MCP\u5DE5\u5177</button>';
    html += '</div>';
  }
  html += '</div>';

  return html;
}

function buildCollapsible(label, content) {
  var id = 'col_' + label + '_' + Math.random().toString(36).substr(2, 6);
  var html = '<div class="ai-req-collapsible-wrap">';
  html += '<div class="ai-req-collapsible-header" data-target="' + id + '">';
  html += '<span class="ai-req-collapsible-arrow ai-req-collapsed">\u25BC</span> ' + escapeHtml(label);
  html += '</div>';
  html += '<div class="ai-req-collapsible-content" id="' + id + '" style="display:none">';
  html += '<div class="ai-req-code-block">' + escapeHtml(content || '(空)') + '</div>';
  html += '</div>';
  html += '</div>';
  return html;
}

function bindDetailEvents(detailEl, req, keyword) {
  var collapsibles = detailEl.querySelectorAll('.ai-req-collapsible-header');
  collapsibles.forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var targetId = el.getAttribute('data-target');
      var content = document.getElementById(targetId);
      var arrow = el.querySelector('.ai-req-collapsible-arrow');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        arrow.classList.remove('ai-req-collapsed');
      } else {
        content.style.display = 'none';
        arrow.classList.add('ai-req-collapsed');
      }
    });
  });

  var analyzeBtn = detailEl.querySelector('.ai-req-analyze-single-btn');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var btn = e.target;
      btn.disabled = true;
      btn.textContent = '分析中...';
      analyzeRequest(req.id).catch(function () {}).then(function () {
        btn.disabled = false;
      });
    });
  }

  var editMockBtn = detailEl.querySelector('.ai-req-edit-mock-btn');
  if (editMockBtn) {
    editMockBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      state.selectedReqId = req.id;
      openJsonEditor(req.responseBody);
    });
  }

  var editRewriteBtn = detailEl.querySelector('.ai-req-edit-rewrite-btn');
  if (editRewriteBtn) {
    editRewriteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openRewriteEditor(req);
    });
  }

  var cancelMockBtn = detailEl.querySelector('.ai-req-cancel-mock-btn');
  if (cancelMockBtn) {
    cancelMockBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      removeMockRule(req);
    });
  }

  var replayBtn = detailEl.querySelector('.ai-req-replay-btn');
  if (replayBtn) {
    replayBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      replayRequest(req.id);
    });
  }

  var mcpGenBtn = detailEl.querySelector('.ai-req-mcp-gen-btn');
  if (mcpGenBtn) {
    mcpGenBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var mReqId = this.getAttribute('data-req-id');
      var mReq = null;
      for (var mi = 0; mi < state.requestRecords.length; mi++) {
        if (state.requestRecords[mi].id === mReqId) {
          mReq = state.requestRecords[mi];
          break;
        }
      }
      if (!mReq) return;
      var mTool = generateMcpToolFromRecord(mReq);
      var map = state.mcpTools || (state.mcpTools = {});
      if (shouldSkipApplyingGeneratedMcpTool(mTool, map)) {
        var exNm = findExistingMcpToolNameByConflictKey(mTool, map);
        showToast(exNm ? '\u5DF2\u6709\u76F8\u540C\u7AEF\u70B9\u5DE5\u5177: ' + exNm : '\u540C\u540D\u6216\u91CD\u590D\uFF0C\u672A\u5199\u5165');
        return;
      }
      map[mTool.name] = mTool;
      saveMcpTools();
      chrome.runtime.sendMessage({ type: 'MCP_SYNC_TOOLS' });
      showToast('MCP \u5DE5\u5177\u5DF2\u751F\u6210: ' + mTool.name);
    });
  }
}

function renderRequestDetail(reqId) {
  var req = findRequestById(reqId);
  if (!req || !state.mainPanel) return;
  ensureMainUiState();
  state.ui.requestTable.selectedId = reqId;
  state.ui.requestTable.detailOpen = true;
  state.expandedReqId = reqId;
  state.selectedReqId = reqId;
  renderRequestInspector(req, getActiveListKeyword());
  syncRequestInspectorVisibility();
  var items = state.mainPanel.querySelectorAll('.ai-req-request-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('ai-req-request-selected', items[i].getAttribute('data-id') === reqId);
  }
}

function openJsonEditor(data) {
  var editor = state.jsonEditor;
  var overlay = editor.querySelector('.ai-req-json-editor-overlay');
  var textarea = editor.querySelector('.ai-req-json-editor-textarea');
  textarea.value = formatJson(data);
  overlay.style.display = 'flex';
}

function closeJsonEditor() {
  var editor = state.jsonEditor;
  var overlay = editor.querySelector('.ai-req-json-editor-overlay');
  overlay.style.display = 'none';
}

function parseJsonObjectInput(value, label) {
  var text = (value || '').trim();
  if (!text) return {};
  var parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(label + '必须是JSON对象');
  }
  return parsed;
}

function parseJsonAnyInput(value, label) {
  var text = (value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(label + '不是有效JSON: ' + e.message);
  }
}

function stringifyRemoveList(list) {
  return (list || []).join('\n');
}

function createJsonEditor() {
  var editor = document.createElement('div');
  var overlay = document.createElement('div');
  overlay.className = 'ai-req-json-editor-overlay';

  var modal = document.createElement('div');
  modal.className = 'ai-req-json-editor-modal';

  var title = document.createElement('div');
  title.className = 'ai-req-json-editor-title';
  title.textContent = '编辑响应数据 (Mock)';

  var textarea = document.createElement('textarea');
  textarea.className = 'ai-req-json-editor-textarea';

  var actions = document.createElement('div');
  actions.className = 'ai-req-json-editor-actions';

  var formatBtn = document.createElement('button');
  formatBtn.className = 'ai-req-btn ai-req-btn-secondary';
  formatBtn.textContent = '格式化';
  formatBtn.addEventListener('click', function () {
    try {
      var obj = JSON.parse(textarea.value);
      textarea.value = JSON.stringify(obj, null, 2);
    } catch (e) {
      alert('JSON格式错误: ' + e.message);
    }
  });

  var confirmBtn = document.createElement('button');
  confirmBtn.className = 'ai-req-btn ai-req-btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.addEventListener('click', function () {
    try {
      var data = JSON.parse(textarea.value);
      applyMockData(data);
      closeJsonEditor();
    } catch (e) {
      alert('JSON格式错误: ' + e.message);
    }
  });

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'ai-req-btn ai-req-btn-secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', function () {
    closeJsonEditor();
  });

  actions.appendChild(formatBtn);
  actions.appendChild(confirmBtn);
  actions.appendChild(cancelBtn);

  modal.appendChild(title);
  modal.appendChild(textarea);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  editor.appendChild(overlay);

  safeAppendChild(editor);
  state.jsonEditor = editor;
}

function findJsonPathPositionInFormattedText(jsonText, jsonPath, valueHint) {
  if (!jsonText || !jsonPath || typeof parseJsonPathSegments !== 'function') return null;
  var segments = parseJsonPathSegments(jsonPath);
  if (!segments || !segments.length) return null;
  var last = segments[segments.length - 1];
  if (typeof last === 'number') {
    var bracket = '[' + last + ']';
    var bIdx = jsonText.indexOf(bracket);
    if (bIdx < 0) return null;
    return { start: bIdx, end: bIdx + bracket.length };
  }
  var keyPattern = '"' + last + '"';
  var valStr = valueHint !== null && typeof valueHint !== 'undefined' ? primitiveToMatchString(valueHint) : '';
  var patterns = [];
  if (valStr !== '') {
    patterns.push(keyPattern + ': "' + valStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
    patterns.push(keyPattern + ': "' + valStr + '"');
    if (typeof valueHint === 'number' || typeof valueHint === 'boolean') {
      patterns.push(keyPattern + ': ' + String(valueHint));
    }
  }
  patterns.push(keyPattern + ':');
  for (var i = 0; i < patterns.length; i++) {
    var idx = jsonText.indexOf(patterns[i]);
    if (idx >= 0) {
      var lineStart = jsonText.lastIndexOf('\n', idx - 1) + 1;
      var lineEnd = jsonText.indexOf('\n', idx);
      if (lineEnd < 0) lineEnd = jsonText.length;
      return { start: lineStart, end: lineEnd };
    }
  }
  var keyIdx = jsonText.indexOf(keyPattern);
  if (keyIdx < 0) return null;
  return { start: keyIdx, end: keyIdx + keyPattern.length };
}

function focusRewriteBodyAtJsonPath(textarea, jsonText, jsonPath, valueHint) {
  if (!textarea) return false;
  var pos = findJsonPathPositionInFormattedText(jsonText, jsonPath, valueHint);
  if (!pos) return false;
  var textBefore = jsonText.slice(0, pos.start);
  var lineNumber = textBefore.split('\n').length;
  var lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight, 10) || 18;
  var scrollTop = Math.max(0, (lineNumber - 4) * lineHeight);
  function applyFocus() {
    textarea.focus();
    textarea.scrollTop = scrollTop;
    textarea.setSelectionRange(pos.start, pos.end);
  }
  applyFocus();
  setTimeout(applyFocus, 60);
  setTimeout(applyFocus, 180);
  textarea.classList.remove('ai-req-rewrite-body-located');
  void textarea.offsetWidth;
  textarea.classList.add('ai-req-rewrite-body-located');
  setTimeout(function () {
    textarea.classList.remove('ai-req-rewrite-body-located');
  }, 1600);
  return true;
}

function fillRewriteEditorContext(editor, req) {
  if (!editor || !req) return;
  var methodEl = editor.querySelector('.ai-req-rewrite-origin-method');
  var urlEl = editor.querySelector('.ai-req-rewrite-origin-url');
  var statusEl = editor.querySelector('.ai-req-rewrite-origin-status');
  var reqHeadersEl = editor.querySelector('.ai-req-rewrite-origin-req-headers');
  var resHeadersEl = editor.querySelector('.ai-req-rewrite-origin-res-headers');
  var subtitleEl = editor.querySelector('.ai-req-rewrite-subtitle');
  if (methodEl) methodEl.textContent = (req.method || 'GET').toUpperCase();
  if (urlEl) urlEl.textContent = req.originalUrl || req.url || '—';
  if (statusEl) statusEl.textContent = String(req.responseStatus != null ? req.responseStatus : '—');
  if (reqHeadersEl) reqHeadersEl.textContent = formatJson(req.requestHeaders || {});
  if (resHeadersEl) resHeadersEl.textContent = formatJson(req.responseHeaders || {});
  if (subtitleEl) {
    subtitleEl.textContent = extractRequestPath(req.originalUrl || req.url || '') + ' · HTTP ' + (req.responseStatus || '—');
  }
}

function normalizeHeaderNameForCompare(name) {
  return String(name || '').trim().toLowerCase();
}

function isUnsafeRequestHeaderForRewrite(name) {
  var lower = normalizeHeaderNameForCompare(name);
  return /^(host|cookie|cookie2|origin|referer|connection|content-length|accept-encoding|sec-|proxy-|upgrade|keep-alive|te|trailer|transfer-encoding)$/.test(lower);
}

function isUnsafeResponseHeaderForRewrite(name) {
  var lower = normalizeHeaderNameForCompare(name);
  return /^(content-encoding|content-length|transfer-encoding|connection|set-cookie|set-cookie2|keep-alive|proxy-|trailer|upgrade)$/i.test(lower);
}

function mergeRewriteDraftHeaders(baseHeaders, overrideHeaders) {
  var merged = Object.assign({}, baseHeaders || {});
  Object.keys(overrideHeaders || {}).forEach(function (name) {
    merged[name] = overrideHeaders[name];
  });
  return merged;
}

function buildHeaderOverrideDiff(draftHeaders, originalHeaders, kind) {
  var originalByLower = {};
  Object.keys(originalHeaders || {}).forEach(function (name) {
    originalByLower[normalizeHeaderNameForCompare(name)] = String(originalHeaders[name]);
  });
  var diff = {};
  Object.keys(draftHeaders || {}).forEach(function (name) {
    if (kind === 'request' && isUnsafeRequestHeaderForRewrite(name)) return;
    if (kind === 'response' && isUnsafeResponseHeaderForRewrite(name)) return;
    var lower = normalizeHeaderNameForCompare(name);
    var value = draftHeaders[name];
    if (String(value) !== originalByLower[lower]) diff[name] = value;
  });
  return diff;
}

function openRewriteEditor(req, options) {
  options = options || {};
  state.selectedRewriteReqId = req.id;
  var editor = state.rewriteEditor;
  var overlay = editor.querySelector('.ai-req-rewrite-editor-overlay');
  var key = getMockKey(req.originalUrl || req.url);
  var hasExistingRule = !!state.mockRules[key];
  var rule = hasExistingRule ? normalizeRule(state.mockRules[key], key, req.method) : normalizeRule({
    __aiReqRule: true,
    enabled: true,
    once: false,
    match: { pathname: key, method: (req.method || '').toUpperCase() },
    request: { url: '', headersSet: {}, headersRemove: [] },
    response: {
      status: req.responseStatus || 200,
      statusText: 'OK',
      headersSet: {},
      headersRemove: [],
      bodyEnabled: false,
      body: req.responseBody
    }
  }, key, req.method);

  editor.querySelector('.ai-req-rewrite-enabled').value = rule.enabled ? 'true' : 'false';
  editor.querySelector('.ai-req-rewrite-once').value = rule.once ? 'true' : 'false';
  editor.querySelector('.ai-req-rewrite-method').value = rule.match.method || (req.method || '').toUpperCase();
  editor.querySelector('.ai-req-rewrite-url').value = rule.request.url || req.originalUrl || req.url || '';
  editor.querySelector('.ai-req-rewrite-req-headers-set').value = formatJson(
    mergeRewriteDraftHeaders(req.requestHeaders || {}, hasExistingRule ? rule.request.headersSet : {})
  );
  editor.querySelector('.ai-req-rewrite-status').value = rule.response.status || 200;
  editor.querySelector('.ai-req-rewrite-status-text').value = rule.response.statusText || 'OK';
  editor.querySelector('.ai-req-rewrite-res-headers-set').value = formatJson(
    mergeRewriteDraftHeaders(req.responseHeaders || {}, hasExistingRule ? rule.response.headersSet : {})
  );
  var bodyEnabled = options.enableBodyMock === true ? true : rule.response.bodyEnabled;
  editor.querySelector('.ai-req-rewrite-body-enabled').value = bodyEnabled ? 'true' : 'false';
  var bodySource = rule.response.body !== undefined && rule.response.body !== null
    ? rule.response.body
    : req.responseBody;
  var bodyText = formatJson(bodySource);
  editor.querySelector('.ai-req-rewrite-body').value = bodyText;
  fillRewriteEditorContext(editor, req);
  overlay.style.display = 'flex';
  if (options.focusJsonPath) {
    requestAnimationFrame(function () {
      var bodyEl = editor.querySelector('.ai-req-rewrite-body');
      var focused = focusRewriteBodyAtJsonPath(bodyEl, bodyText, options.focusJsonPath, options.focusValue);
      if (!focused) {
        if (bodyEl) bodyEl.focus();
        showToast('已打开高级改写，但未能定位到字段', 2500, 'warn');
      }
    });
  }
}

function closeRewriteEditor() {
  var editor = state.rewriteEditor;
  var overlay = editor.querySelector('.ai-req-rewrite-editor-overlay');
  overlay.style.display = 'none';
}

function applyRewriteRuleFromEditor() {
  if (!state.selectedRewriteReqId) return;
  var req = null;
  for (var i = 0; i < state.requestRecords.length; i++) {
    if (state.requestRecords[i].id === state.selectedRewriteReqId) {
      req = state.requestRecords[i];
      break;
    }
  }
  if (!req) return;

  var editor = state.rewriteEditor;
  var key = getMockKey(req.originalUrl || req.url);
  var existingRule = state.mockRules[key] ? normalizeRule(state.mockRules[key], key, req.method) : null;
  var bodyEnabled = editor.querySelector('.ai-req-rewrite-body-enabled').value === 'true';
  var originalUrl = req.originalUrl || req.url || '';
  var draftUrl = editor.querySelector('.ai-req-rewrite-url').value.trim();
  var draftReqHeaders = normalizeHeaders(parseJsonObjectInput(editor.querySelector('.ai-req-rewrite-req-headers-set').value, '请求头'));
  var draftResHeaders = normalizeHeaders(parseJsonObjectInput(editor.querySelector('.ai-req-rewrite-res-headers-set').value, '响应头'));
  var rule = {
    __aiReqRule: true,
    enabled: editor.querySelector('.ai-req-rewrite-enabled').value === 'true',
    once: editor.querySelector('.ai-req-rewrite-once').value === 'true',
    match: {
      pathname: key,
      method: editor.querySelector('.ai-req-rewrite-method').value.trim().toUpperCase()
    },
    request: {
      url: draftUrl === originalUrl ? '' : draftUrl,
      headersSet: buildHeaderOverrideDiff(draftReqHeaders, req.requestHeaders || {}, 'request'),
      headersRemove: []
    },
    response: {
      status: parseInt(editor.querySelector('.ai-req-rewrite-status').value, 10) || 200,
      statusText: editor.querySelector('.ai-req-rewrite-status-text').value.trim() || 'OK',
      headersSet: buildHeaderOverrideDiff(draftResHeaders, req.responseHeaders || {}, 'response'),
      headersRemove: [],
      bodyEnabled: bodyEnabled,
      body: bodyEnabled ? parseJsonAnyInput(editor.querySelector('.ai-req-rewrite-body').value, '响应体') : null,
      patches: existingRule ? (existingRule.response.patches || []) : []
    }
  };

  state.mockRules[key] = normalizeRule(rule, key, req.method);
  saveMockRules();
  req.debugRule = state.mockRules[key];
  req.isMocked = hasResponseBodyMock(req.debugRule);
  req.mockData = req.isMocked ? req.debugRule.response.body : null;
  refreshRequestList();
  closeRewriteEditor();
  showToast(rule.once ? '高级改写已保存，仅下一次生效' : '高级改写已保存，刷新或下次请求生效');
}

function createRewriteEditor() {
  var editor = document.createElement('div');
  var overlay = document.createElement('div');
  overlay.className = 'ai-req-rewrite-editor-overlay';

  var modal = document.createElement('div');
  modal.className = 'ai-req-rewrite-editor-modal';
  modal.innerHTML = [
    '<div class="ai-req-rewrite-header">',
    '  <div class="ai-req-rewrite-header-main">',
    '    <div class="ai-req-rewrite-editor-title">高级改写</div>',
    '    <div class="ai-req-rewrite-subtitle">—</div>',
    '  </div>',
    '  <button type="button" class="ai-req-rewrite-close" aria-label="关闭">×</button>',
    '</div>',
    '<div class="ai-req-rewrite-toolbar">',
    '  <div class="ai-req-rewrite-toolbar-field">',
    '    <label class="ai-req-rewrite-label">启用</label>',
    '    <select class="ai-req-rewrite-select ai-req-rewrite-enabled"><option value="true">启用</option><option value="false">暂停</option></select>',
    '  </div>',
    '  <div class="ai-req-rewrite-toolbar-field">',
    '    <label class="ai-req-rewrite-label">生效</label>',
    '    <select class="ai-req-rewrite-select ai-req-rewrite-once"><option value="false">持久</option><option value="true">仅一次</option></select>',
    '  </div>',
    '  <div class="ai-req-rewrite-toolbar-field">',
    '    <label class="ai-req-rewrite-label">匹配方法</label>',
    '    <input class="ai-req-rewrite-input ai-req-rewrite-method" placeholder="GET">',
    '  </div>',
    '</div>',
    '<div class="ai-req-rewrite-editor-body">',
    '  <section class="ai-req-rewrite-section">',
    '    <div class="ai-req-rewrite-section-head">',
    '      <span class="ai-req-rewrite-section-title">请求改写</span>',
    '      <span class="ai-req-rewrite-section-hint">已回填真实请求，可直接编辑草稿</span>',
    '    </div>',
    '    <div class="ai-req-rewrite-grid">',
    '      <div class="ai-req-rewrite-field ai-req-rewrite-full">',
    '        <label class="ai-req-rewrite-label">请求地址</label>',
    '        <input class="ai-req-rewrite-input ai-req-rewrite-url" placeholder="真实请求地址">',
    '        <div class="ai-req-rewrite-help">默认回填真实 URL；保存时若未修改，会自动视为“不改写请求地址”。跨域地址可能触发 CORS 限制。</div>',
    '      </div>',
    '      <div class="ai-req-rewrite-field ai-req-rewrite-full">',
    '        <label class="ai-req-rewrite-label">请求头 JSON</label>',
    '        <textarea class="ai-req-rewrite-textarea ai-req-rewrite-req-headers-set ai-req-rewrite-header-editor"></textarea>',
    '        <div class="ai-req-rewrite-help">默认回填真实请求头。删除某个 key 即表示不再覆盖该 header。</div>',
    '      </div>',
    '    </div>',
    '  </section>',
    '  <section class="ai-req-rewrite-section ai-req-rewrite-section-response">',
    '    <div class="ai-req-rewrite-section-head"><span class="ai-req-rewrite-section-title">响应改写</span></div>',
    '    <div class="ai-req-rewrite-grid">',
    '      <div class="ai-req-rewrite-field">',
    '        <label class="ai-req-rewrite-label">状态码</label>',
    '        <input class="ai-req-rewrite-input ai-req-rewrite-status" type="number" min="100" max="599">',
    '      </div>',
    '      <div class="ai-req-rewrite-field">',
    '        <label class="ai-req-rewrite-label">状态文本</label>',
    '        <input class="ai-req-rewrite-input ai-req-rewrite-status-text" placeholder="OK">',
    '      </div>',
    '      <div class="ai-req-rewrite-field">',
    '        <label class="ai-req-rewrite-label">响应体</label>',
    '        <select class="ai-req-rewrite-select ai-req-rewrite-body-enabled"><option value="true">Mock 响应体</option><option value="false">不改写</option></select>',
    '      </div>',
    '      <div class="ai-req-rewrite-field ai-req-rewrite-full">',
    '        <label class="ai-req-rewrite-label">响应头 JSON</label>',
    '        <textarea class="ai-req-rewrite-textarea ai-req-rewrite-res-headers-set ai-req-rewrite-header-editor"></textarea>',
    '        <div class="ai-req-rewrite-help">默认回填真实响应头。删除某个 key 即表示不再覆盖该 header。</div>',
    '      </div>',
    '      <div class="ai-req-rewrite-field ai-req-rewrite-full ai-req-rewrite-body-field">',
    '        <label class="ai-req-rewrite-label">响应体 JSON</label>',
    '        <textarea class="ai-req-rewrite-textarea ai-req-rewrite-body ai-req-rewrite-body-editor"></textarea>',
    '      </div>',
    '    </div>',
    '  </section>',
    '</div>',
    '<div class="ai-req-rewrite-actions">',
    '  <button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-rewrite-cancel">取消</button>',
    '  <button type="button" class="ai-req-btn ai-req-btn-primary ai-req-rewrite-save">保存规则</button>',
    '</div>'
  ].join('');

  overlay.appendChild(modal);
  editor.appendChild(overlay);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeRewriteEditor();
  });
  modal.querySelector('.ai-req-rewrite-close').addEventListener('click', closeRewriteEditor);
  modal.querySelector('.ai-req-rewrite-cancel').addEventListener('click', closeRewriteEditor);
  modal.querySelector('.ai-req-rewrite-save').addEventListener('click', function () {
    try {
      applyRewriteRuleFromEditor();
    } catch (e) {
      alert(e.message);
    }
  });

  safeAppendChild(editor);
  state.rewriteEditor = editor;
}

function showToast(msg, duration, type) {
  duration = duration || 2500;
  type = type || 'success';
  var existing = document.querySelector('.ai-req-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'ai-req-toast ai-req-toast-' + type;
  toast.textContent = msg;
  safeAppendChild(toast);
  requestAnimationFrame(function () {
    toast.classList.add('ai-req-toast-show');
  });
  setTimeout(function () {
    toast.classList.remove('ai-req-toast-show');
    setTimeout(function () { toast.remove(); }, 300);
  }, duration);
}

function confirmDangerAction(opts) {
  opts = opts || {};
  var existingOverlays = document.querySelectorAll('.ai-req-confirm-overlay');
  for (var ei = 0; ei < existingOverlays.length; ei++) {
    existingOverlays[ei].remove();
  }
  return new Promise(function (resolve) {
    var settled = false;
    var overlay = document.createElement('div');
    overlay.className = 'ai-req-confirm-overlay';
    var modal = document.createElement('div');
    modal.className = 'ai-req-confirm-modal ai-req-confirm-danger';
    var titleEl = document.createElement('div');
    titleEl.className = 'ai-req-confirm-title';
    titleEl.textContent = opts.title || '确认危险操作';
    var bodyEl = document.createElement('div');
    bodyEl.className = 'ai-req-confirm-body';
    bodyEl.textContent = opts.message || '';
    var actions = document.createElement('div');
    actions.className = 'ai-req-confirm-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ai-req-btn ai-req-btn-secondary ai-req-confirm-cancel';
    cancelBtn.textContent = opts.cancelLabel || '取消';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'ai-req-btn ai-req-btn-danger ai-req-confirm-ok';
    okBtn.textContent = opts.confirmLabel || '确认执行';
    function closeModal(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    }
    cancelBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeModal(false);
    });
    okBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeModal(true);
    });
    modal.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal(false);
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    modal.appendChild(titleEl);
    modal.appendChild(bodyEl);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    mountConfirmOverlay(overlay);
    requestAnimationFrame(function () {
      okBtn.focus();
    });
  });
}

function replayRequest(reqId) {
  var req = null;
  for (var i = 0; i < state.requestRecords.length; i++) {
    if (state.requestRecords[i].id === reqId) {
      req = state.requestRecords[i];
      break;
    }
  }
  if (!req) return;
  if (confirm('Mock规则已保存，需要刷新页面才能让页面代码使用Mock数据。\n\n是否立即刷新页面？')) {
    location.reload();
  }
}

function applyMockData(mockData) {
  if (!state.selectedReqId) return;
  var req = null;
  for (var i = 0; i < state.requestRecords.length; i++) {
    if (state.requestRecords[i].id === state.selectedReqId) {
      req = state.requestRecords[i];
      break;
    }
  }
  if (!req) return;

  var key = getMockKey(req.originalUrl || req.url);
  state.mockRules[key] = buildSimpleMockRule(req, mockData);
  saveMockRules();

  req.isMocked = true;
  req.mockData = mockData;
  req.debugRule = state.mockRules[key];

  refreshRequestList();
  showToast('Mock已保存，刷新页面后生效');

  setTimeout(function () {
    if (confirm('Mock规则已保存！\n页面刷新后，该接口将返回Mock数据。\n\n是否立即刷新页面？')) {
      location.reload();
    }
  }, 500);
}

function removeMockRule(req) {
  var key = getMockKey(req.originalUrl || req.url);
  delete state.mockRules[key];
  saveMockRules();

  req.isMocked = false;
  req.mockData = null;
  req.debugRule = null;

  refreshRequestList();
}

function clearAllMockRules() {
  var mockCount = Object.keys(state.mockRules || {}).length;
  if (mockCount === 0) {
    showToast('当前没有调试规则', 2500, 'info');
    return;
  }
  var host = typeof location !== 'undefined' ? location.hostname : '当前站点';
  confirmDangerAction({
    title: '清除全部调试规则',
    message: '将清除「' + host + '」下全部 ' + mockCount + ' 条 Mock/改写规则。所有已配置的响应替换与高级改写将失效，且不可撤销。',
    confirmLabel: '清除 ' + mockCount + ' 条规则'
  }).then(function (ok) {
    if (!ok) return;
    state.mockRules = {};
    saveMockRules();
    state.requestRecords.forEach(function (req) {
      req.isMocked = false;
      req.mockData = null;
      req.debugRule = null;
    });
    refreshRequestList();
    showToast('已清除全部调试规则', 2500, 'success');
  });
}

function openConfigPanel() {
  var panel = state.configPanel;
  var overlay = panel.querySelector('.ai-req-config-overlay');

  panel.querySelector('.ai-req-config-apikey').value = state.config.apiKey;
  panel.querySelector('.ai-req-config-baseurl').value = state.config.baseURL;
  panel.querySelector('.ai-req-config-model').value = state.config.model;
  panel.querySelector('.ai-req-config-mcp-port').value = state.config.mcpPort || 9527;
  panel.querySelector('.ai-req-config-mcp-token').value = state.config.mcpToken || '';
  panel.querySelector('.ai-req-config-mcp-auto-sync').checked = !!state.config.mcpAutoSync;
  var exportPathEl = panel.querySelector('.ai-req-config-mcp-export-path');
  if (exportPathEl) exportPathEl.value = state.config.mcpExportPath || '';
  var namingEl = panel.querySelector('.ai-req-config-mcp-tool-naming');
  if (namingEl) namingEl.value = state.config.mcpToolNaming === 'compact' ? 'compact' : 'full';

  overlay.style.display = 'flex';
}

function closeConfigPanel() {
  var panel = state.configPanel;
  var overlay = panel.querySelector('.ai-req-config-overlay');
  overlay.style.display = 'none';
}

function createConfigPanel() {
  var panel = document.createElement('div');

  var overlay = document.createElement('div');
  overlay.className = 'ai-req-config-overlay';

  var modal = document.createElement('div');
  modal.className = 'ai-req-config-modal';

  var dragHandle = document.createElement('div');
  dragHandle.className = 'ai-req-config-drag-handle';
  dragHandle.textContent = '\u2500\u2500\u2500';

  var title = document.createElement('div');
  title.className = 'ai-req-config-title';
  title.textContent = '\u914D\u7F6E';

  var apiKeyField = document.createElement('div');
  apiKeyField.className = 'ai-req-config-field';
  apiKeyField.innerHTML = '<label class="ai-req-config-label">API Key</label><input type="password" class="ai-req-config-input ai-req-config-apikey" placeholder="\u8F93\u5165API Key">';

  var baseURLField = document.createElement('div');
  baseURLField.className = 'ai-req-config-field';
  baseURLField.innerHTML = '<label class="ai-req-config-label">Base URL</label><input type="text" class="ai-req-config-input ai-req-config-baseurl" value="https://api.moonshot.cn/v1">';

  var modelField = document.createElement('div');
  modelField.className = 'ai-req-config-field';
  modelField.innerHTML = '<label class="ai-req-config-label">\u6A21\u578B\u540D\u79F0</label><input type="text" class="ai-req-config-input ai-req-config-model" value="kimi-k2.6">';

  var mcpDivider = document.createElement('div');
  mcpDivider.className = 'ai-req-config-divider';
  mcpDivider.textContent = 'MCP Server \u914D\u7F6E';

  var mcpPortField = document.createElement('div');
  mcpPortField.className = 'ai-req-config-field';
  mcpPortField.innerHTML = '<label class="ai-req-config-label">MCP \u7AEF\u53E3</label><input type="number" class="ai-req-config-input ai-req-config-mcp-port" placeholder="9527" min="1" max="65535">';

  var mcpTokenField = document.createElement('div');
  mcpTokenField.className = 'ai-req-config-field';
  mcpTokenField.innerHTML = '<label class="ai-req-config-label">\u9274\u6743 Token</label><input type="password" class="ai-req-config-input ai-req-config-mcp-token" placeholder="\u53EF\u9009\uFF0C\u7528\u4E8E MCP \u8FDE\u63A5\u9274\u6743">';

  var mcpNamingField = document.createElement('div');
  mcpNamingField.className = 'ai-req-config-field';
  mcpNamingField.innerHTML = '<label class="ai-req-config-label">MCP \u5DE5\u5177\u547D\u540D</label><select class="ai-req-config-input ai-req-config-mcp-tool-naming"><option value="full">\u5B8C\u6574\u8DEF\u5F84\uFF08\u9ED8\u8BA4\uFF09</option><option value="compact">\u7D27\u51D8\uFF08\u672B\u6BB5+\u54C8\u5E0C\uFF09</option></select>';

  var mcpAutoSyncField = document.createElement('div');
  mcpAutoSyncField.className = 'ai-req-config-field';
  mcpAutoSyncField.innerHTML = '<label class="ai-req-config-label">\u81EA\u52A8\u540C\u6B65</label><label class="ai-req-config-checkbox-label"><input type="checkbox" class="ai-req-config-mcp-auto-sync"> \u542F\u52A8\u65F6\u81EA\u52A8\u540C\u6B65\u5DE5\u5177\u5217\u8868</label>';

  var mcpExportPathField = document.createElement('div');
  mcpExportPathField.className = 'ai-req-config-field';
  mcpExportPathField.innerHTML =
    '<label class="ai-req-config-label">MCP \u5BFC\u51FA\u76EE\u5F55\uFF08\u672C\u673A\uFF09</label>' +
    '<input type="text" class="ai-req-config-input ai-req-config-mcp-export-path" placeholder="D:\\\\exports\\\\mcp \u6216 /home/user/mcp-export">' +
    '<div class="ai-req-config-hint">\u300C\u5168\u90E8/\u5DF2\u9009\u5BFC\u51FA\u300D\u5728\u672C\u5B57\u6BB5\u975E\u7A7A\u4E14 MCP \u52A9\u624B\u5DF2\u542F\u52A8\u65F6\u4F1A\u5199\u5165\u8BE5\u76EE\u5F55\uFF1B\u5426\u5219\u8D70\u6D4F\u89C8\u5668\u9ED8\u8BA4\u4E0B\u8F7D\u5939\u3002\u300C\u8BFB\u53D6\u672C\u5730\u5DE5\u5177\u5217\u8868\u300DTAB \u9700\u52A9\u624B\u5217\u76EE\u5F55\u5185 JSON\u3002</div>';

  var actions = document.createElement('div');
  actions.className = 'ai-req-config-actions';

  var saveBtn = document.createElement('button');
  saveBtn.className = 'ai-req-btn ai-req-btn-primary';
  saveBtn.textContent = '\u4FDD\u5B58';
  saveBtn.addEventListener('click', function () {
    state.config.apiKey = modal.querySelector('.ai-req-config-apikey').value.trim();
    state.config.baseURL = modal.querySelector('.ai-req-config-baseurl').value.trim();
    state.config.model = modal.querySelector('.ai-req-config-model').value.trim();
    var mcpPortVal = parseInt(modal.querySelector('.ai-req-config-mcp-port').value, 10);
    state.config.mcpPort = (mcpPortVal > 0 && mcpPortVal <= 65535) ? mcpPortVal : 9527;
    state.config.mcpToken = modal.querySelector('.ai-req-config-mcp-token').value.trim();
    state.config.mcpAutoSync = modal.querySelector('.ai-req-config-mcp-auto-sync').checked;
    var namingSel = modal.querySelector('.ai-req-config-mcp-tool-naming');
    state.config.mcpToolNaming = (namingSel && namingSel.value === 'compact') ? 'compact' : 'full';
    var exportPathInput = modal.querySelector('.ai-req-config-mcp-export-path');
    state.config.mcpExportPath = exportPathInput ? exportPathInput.value.trim() : '';
    saveConfig();
    closeConfigPanel();
  });

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'ai-req-btn ai-req-btn-secondary';
  cancelBtn.textContent = '\u53D6\u6D88';
  cancelBtn.addEventListener('click', function () {
    closeConfigPanel();
  });

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  modal.appendChild(dragHandle);
  modal.appendChild(title);
  modal.appendChild(apiKeyField);
  modal.appendChild(baseURLField);
  modal.appendChild(modelField);
  modal.appendChild(mcpDivider);
  modal.appendChild(mcpPortField);
  modal.appendChild(mcpTokenField);
  modal.appendChild(mcpNamingField);
  modal.appendChild(mcpAutoSyncField);
  modal.appendChild(mcpExportPathField);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  makeDraggable(modal, dragHandle);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) {
      closeConfigPanel();
    }
  });

  panel.appendChild(overlay);
  safeAppendChild(panel);
  state.configPanel = panel;
}

function updateAnalyzeProgress() {
  if (!state.mainPanel) return;
  var fill = state.mainPanel.querySelector('.ai-req-progress-fill');
  var countEl = state.mainPanel.querySelector('.ai-req-req-count');
  var taskStrip = state.mainPanel.querySelector('.ai-req-task-strip');
  var progressBar = state.mainPanel.querySelector('.ai-req-progress-bar');
  if (state.isAnalyzing) {
    var pct = state.analyzeProgress.total > 0 ? (state.analyzeProgress.done / state.analyzeProgress.total * 100) : 0;
    if (fill) fill.style.width = pct + '%';
    if (progressBar) progressBar.classList.add('ai-req-progress-active');
    if (taskStrip) {
      taskStrip.style.display = 'block';
      taskStrip.textContent = 'AI 批量分析中 ' + state.analyzeProgress.done + ' / ' + state.analyzeProgress.total;
    }
    if (countEl) countEl.textContent = '分析中 ' + state.analyzeProgress.done + '/' + state.analyzeProgress.total;
  } else {
    if (fill) fill.style.width = '0%';
    if (progressBar) progressBar.classList.remove('ai-req-progress-active');
    if (taskStrip) {
      taskStrip.style.display = 'none';
      taskStrip.textContent = '';
    }
    if (countEl) {
      var filtered = filterRequestRecords(state.requestRecords, getActiveListKeyword());
      countEl.textContent = filtered.length + ' 请求';
    }
  }
  syncShellChrome();
}

var provenanceTriggerEl = null;
var provenanceSelectionTimer = null;
var provenanceDialogEl = null;
var provenanceSelectedCandidate = null;

function setupPageSelectionProvenance() {
  if (state.provenanceSelectionReady) return;
  state.provenanceSelectionReady = true;
  document.addEventListener('mouseup', onProvenanceMouseUp);
  document.addEventListener('mousedown', onProvenanceMouseDown);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideProvenanceTrigger();
      closeFieldProvenanceDialog();
    }
  });
}

function onProvenanceMouseDown(e) {
  if (provenanceTriggerEl && e.target && provenanceTriggerEl.contains(e.target)) return;
  if (provenanceDialogEl && e.target && provenanceDialogEl.contains(e.target)) return;
  hideProvenanceTrigger();
}

function onProvenanceMouseUp(e) {
  if (provenanceSelectionTimer) clearTimeout(provenanceSelectionTimer);
  provenanceSelectionTimer = setTimeout(function () {
    updateProvenanceTriggerFromSelection(e);
  }, 120);
}

function updateProvenanceTriggerFromSelection(e) {
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    hideProvenanceTrigger();
    return;
  }
  var text = (sel.toString() || '').trim();
  if (!text) {
    hideProvenanceTrigger();
    return;
  }
  if (e && e.target && isInsideAiReqUi(e.target)) {
    hideProvenanceTrigger();
    return;
  }
  var anchorNode = sel.anchorNode;
  var anchorEl = anchorNode && anchorNode.nodeType === 3 ? anchorNode.parentNode : anchorNode;
  if (anchorEl && isInsideAiReqUi(anchorEl)) {
    hideProvenanceTrigger();
    return;
  }
  var range = sel.getRangeAt(0);
  var rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideProvenanceTrigger();
    return;
  }
  showProvenanceTrigger(rect, text);
}

function showProvenanceTrigger(rect, text) {
  hideProvenanceTrigger();
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-req-provenance-trigger';
  btn.textContent = '查来源';
  btn.setAttribute('data-selected-text', text);
  var top = window.scrollY + rect.top - 36;
  var left = window.scrollX + rect.left + Math.max(0, rect.width / 2 - 36);
  if (top < window.scrollY + 8) top = window.scrollY + rect.bottom + 8;
  btn.style.top = Math.max(8, top) + 'px';
  btn.style.left = Math.max(8, left) + 'px';
  btn.addEventListener('mousedown', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  });
  btn.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    var selected = btn.getAttribute('data-selected-text') || '';
    hideProvenanceTrigger();
    openFieldProvenanceForSelection(selected);
  });
  safeAppendChild(btn);
  provenanceTriggerEl = btn;
}

function hideProvenanceTrigger() {
  if (provenanceTriggerEl) {
    provenanceTriggerEl.remove();
    provenanceTriggerEl = null;
  }
}

function openFieldProvenanceForSelection(selectedText) {
  if (typeof findFieldSourceCandidates !== 'function') {
    showToast('溯源模块未加载', 2500, 'error');
    return;
  }
  function runSearch() {
    var result = findFieldSourceCandidates(selectedText);
    openFieldProvenanceDialog(selectedText, result);
  }
  if (typeof ensureFlowRecordsLoadedForProvenance === 'function') {
    ensureFlowRecordsLoadedForProvenance(function () {
      runSearch();
    });
    return;
  }
  runSearch();
}

function closeFieldProvenanceDialog() {
  if (provenanceDialogEl) {
    provenanceDialogEl.remove();
    provenanceDialogEl = null;
  }
  provenanceSelectedCandidate = null;
}

function provenanceConfidenceLabel(level) {
  if (level === 'high') return '高';
  if (level === 'medium') return '中';
  return '低';
}

function openFieldProvenanceDialog(selectedText, searchResult) {
  closeFieldProvenanceDialog();
  searchResult = searchResult || {
    selectedText: selectedText,
    candidates: [],
    partialSearch: false,
    truncatedSelection: false
  };
  provenanceSelectedCandidate = null;

  var overlay = document.createElement('div');
  overlay.className = 'ai-req-provenance-overlay';
  var modal = document.createElement('div');
  modal.className = 'ai-req-provenance-modal';

  var header = document.createElement('div');
  header.className = 'ai-req-provenance-header';
  header.innerHTML =
    '<div class="ai-req-provenance-title">候选来源</div>' +
    '<div class="ai-req-provenance-header-actions">' +
    '  <button type="button" class="ai-req-btn ai-req-btn-danger ai-req-provenance-clear-mocks">清除所有 Mock</button>' +
    '  <button type="button" class="ai-req-provenance-close" aria-label="关闭">×</button>' +
    '</div>';

  var summary = document.createElement('div');
  summary.className = 'ai-req-provenance-summary';
  var summaryText = '选中文本：「' + escapeHtml(searchResult.selectedText || selectedText || '') + '」';
  summaryText += ' · 候选 ' + (searchResult.candidates ? searchResult.candidates.length : 0) + ' 条';
  if (searchResult.truncatedSelection) summaryText += ' · 文本已截断';
  summary.innerHTML = summaryText +
    '<div class="ai-req-provenance-disclaimer">以下为候选 JSON 字段，不保证唯一正确来源。</div>';

  if (searchResult.partialSearch) {
    var warn = document.createElement('div');
    warn.className = 'ai-req-provenance-warn';
    warn.textContent = '响应体较大，部分节点未扫描，候选可能不完整。';
    summary.appendChild(warn);
  }

  var body = document.createElement('div');
  body.className = 'ai-req-provenance-body';

  var listWrap = document.createElement('div');
  listWrap.className = 'ai-req-provenance-list';

  var editorWrap = document.createElement('div');
  editorWrap.className = 'ai-req-provenance-editor';
  editorWrap.innerHTML = '<div class="ai-req-provenance-editor-empty">选择一条候选以编辑字段 Mock</div>';

  if (!searchResult.candidates || !searchResult.candidates.length) {
    listWrap.innerHTML =
      '<div class="ai-req-provenance-empty">' +
      '未找到匹配的 JSON 字段。可尝试选中更短的文本，或先触发相关接口请求。' +
      '<div class="ai-req-provenance-empty-actions">' +
      '<button type="button" class="ai-req-btn ai-req-btn-secondary ai-req-provenance-open-requests">打开请求列表</button>' +
      '</div></div>';
  } else {
    renderFieldProvenanceCandidates(listWrap, searchResult.candidates, function (candidate) {
      provenanceSelectedCandidate = candidate;
      renderFieldMockEditor(editorWrap, candidate, searchResult.selectedText || selectedText);
    });
  }

  body.appendChild(listWrap);
  body.appendChild(editorWrap);
  modal.appendChild(header);
  modal.appendChild(summary);
  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeFieldProvenanceDialog();
  });
  header.querySelector('.ai-req-provenance-close').addEventListener('click', closeFieldProvenanceDialog);
  header.querySelector('.ai-req-provenance-clear-mocks').addEventListener('click', function (e) {
    e.stopPropagation();
    closeFieldProvenanceDialog();
    setTimeout(clearAllMockRules, 0);
  });

  var openReqBtn = listWrap.querySelector('.ai-req-provenance-open-requests');
  if (openReqBtn) {
    openReqBtn.addEventListener('click', function () {
      closeFieldProvenanceDialog();
      if (!state.isPanelOpen) toggleMainPanel();
      setMainWorkbenchTab('requests');
    });
  }

  safeAppendChild(overlay);
  provenanceDialogEl = overlay;
}

function renderFieldProvenanceCandidates(listEl, candidates, onSelect) {
  listEl.innerHTML = '';
  for (var i = 0; i < candidates.length; i++) {
    (function (candidate) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'ai-req-provenance-candidate';
      var pathLine = extractRequestPath(candidate.originalUrl || candidate.url || '');
      var flowLine = candidate.flowName
        ? (candidate.flowName + (candidate.flowStepTitle ? ' / ' + candidate.flowStepTitle : ''))
        : '—';
      var reasons = (candidate.matchReasons || []).join(' · ');
      item.innerHTML =
        '<div class="ai-req-provenance-candidate-top">' +
        '<span class="ai-req-method-badge ai-req-method-' + escapeHtml((candidate.method || 'GET').toLowerCase()) + '">' + escapeHtml((candidate.method || 'GET').toUpperCase()) + '</span>' +
        '<span class="ai-req-provenance-candidate-path" title="' + escapeHtml(candidate.originalUrl || candidate.url || '') + '">' + escapeHtml(pathLine) + '</span>' +
        '<span class="ai-req-provenance-confidence ai-req-provenance-confidence-' + escapeHtml(candidate.confidenceLevel || 'low') + '">' + escapeHtml(provenanceConfidenceLabel(candidate.confidenceLevel)) + '</span>' +
        '</div>' +
        '<div class="ai-req-provenance-candidate-pathline">' + escapeHtml(candidate.jsonPath || '') + '</div>' +
        '<div class="ai-req-provenance-candidate-value">当前值：' + escapeHtml(candidate.valuePreview || '') + '</div>' +
        '<div class="ai-req-provenance-candidate-meta">Flow：' + escapeHtml(flowLine) + '</div>' +
        '<div class="ai-req-provenance-candidate-reasons">' + escapeHtml(reasons) + '</div>';
      item.addEventListener('click', function () {
        var all = listEl.querySelectorAll('.ai-req-provenance-candidate');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('ai-req-provenance-candidate-selected');
        item.classList.add('ai-req-provenance-candidate-selected');
        onSelect(candidate);
      });
      listEl.appendChild(item);
    })(candidates[i]);
  }
  if (candidates.length > 0) {
    var first = listEl.querySelector('.ai-req-provenance-candidate');
    if (first) first.classList.add('ai-req-provenance-candidate-selected');
    onSelect(candidates[0]);
  }
}

function renderFieldMockEditor(panelEl, candidate, selectedText) {
  if (!candidate) return;
  var valueType = inferValueTypeFromPrimitive(candidate.value);
  var hasFullMock = false;
  try {
    var existingRule = state.mockRules[candidate.mockKey];
    if (existingRule) {
      var normalized = normalizeRule(existingRule, candidate.mockKey, candidate.method);
      hasFullMock = hasResponseBodyMock(normalized);
    }
  } catch (eRule) {}

  panelEl.innerHTML = '';
  var title = document.createElement('div');
  title.className = 'ai-req-provenance-editor-title';
  title.textContent = '字段 Mock';
  panelEl.appendChild(title);

  if (hasFullMock) {
    var hint = document.createElement('div');
    hint.className = 'ai-req-provenance-warn';
    hint.textContent = '该接口已有整响应 Mock，字段 patch 将叠加在其 body 上。';
    panelEl.appendChild(hint);
  }

  var origField = document.createElement('div');
  origField.className = 'ai-req-provenance-field';
  origField.innerHTML = '<label>原值</label><div class="ai-req-provenance-readonly">' + escapeHtml(primitiveToMatchString(candidate.value)) + '</div>';
  panelEl.appendChild(origField);

  var typeField = document.createElement('div');
  typeField.className = 'ai-req-provenance-field';
  typeField.innerHTML =
    '<label>类型</label>' +
    '<select class="ai-req-provenance-value-type">' +
    '<option value="string">string</option>' +
    '<option value="number">number</option>' +
    '<option value="integer">integer</option>' +
    '<option value="boolean">boolean</option>' +
    '<option value="null">null</option>' +
    '<option value="object">object</option>' +
    '<option value="array">array</option>' +
    '</select>';
  panelEl.appendChild(typeField);
  var typeSel = typeField.querySelector('.ai-req-provenance-value-type');
  typeSel.value = valueType;

  var valueField = document.createElement('div');
  valueField.className = 'ai-req-provenance-field ai-req-provenance-value-field';
  panelEl.appendChild(valueField);

  function renderValueInput() {
    var t = typeSel.value;
    if (t === 'object' || t === 'array') {
      valueField.innerHTML = '<label>新值 (JSON)</label><textarea class="ai-req-provenance-value-input ai-req-provenance-value-json"></textarea>';
      var ta = valueField.querySelector('.ai-req-provenance-value-json');
      ta.value = t === 'array'
        ? (Array.isArray(candidate.value) ? JSON.stringify(candidate.value, null, 2) : '[]')
        : (candidate.value && typeof candidate.value === 'object' ? JSON.stringify(candidate.value, null, 2) : '{}');
    } else if (t === 'boolean') {
      valueField.innerHTML =
        '<label>新值</label>' +
        '<select class="ai-req-provenance-value-input ai-req-provenance-value-bool">' +
        '<option value="true">true</option><option value="false">false</option></select>';
      var boolSel = valueField.querySelector('.ai-req-provenance-value-bool');
      boolSel.value = candidate.value === true ? 'true' : 'false';
    } else if (t === 'null') {
      valueField.innerHTML = '<label>新值</label><div class="ai-req-provenance-readonly">null</div>';
    } else {
      valueField.innerHTML = '<label>新值</label><input type="text" class="ai-req-provenance-value-input ai-req-provenance-value-text">';
      var inp = valueField.querySelector('.ai-req-provenance-value-text');
      inp.value = primitiveToMatchString(candidate.value);
    }
  }
  renderValueInput();
  typeSel.addEventListener('change', renderValueInput);

  var modeField = document.createElement('div');
  modeField.className = 'ai-req-provenance-field ai-req-provenance-mode-field';
  modeField.innerHTML =
    '<label class="ai-req-provenance-once-label"><input type="checkbox" class="ai-req-provenance-once"> 仅下一次请求生效</label>';
  panelEl.appendChild(modeField);

  var actions = document.createElement('div');
  actions.className = 'ai-req-provenance-editor-actions';
  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ai-req-btn ai-req-btn-primary';
  saveBtn.textContent = '保存字段 Mock';
  var jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.className = 'ai-req-btn ai-req-btn-secondary';
  jumpBtn.textContent = '打开高级改写';
  actions.appendChild(saveBtn);
  actions.appendChild(jumpBtn);
  panelEl.appendChild(actions);

  saveBtn.addEventListener('click', function () {
    try {
      var vt = typeSel.value;
      var rawVal;
      if (vt === 'object' || vt === 'array') {
        rawVal = valueField.querySelector('.ai-req-provenance-value-json').value;
      } else if (vt === 'boolean') {
        rawVal = valueField.querySelector('.ai-req-provenance-value-bool').value;
      } else if (vt === 'null') {
        rawVal = null;
      } else {
        rawVal = valueField.querySelector('.ai-req-provenance-value-text').value;
      }
      var once = !!panelEl.querySelector('.ai-req-provenance-once').checked;
      saveFieldMockFromCandidate(candidate, selectedText, rawVal, vt, once);
      showToast('字段 Mock 已保存（已固化完整响应），刷新或重放请求验证', 3000, 'success');
      closeFieldProvenanceDialog();
    } catch (eSave) {
      showToast(eSave.message || '保存失败', 3000, 'error');
    }
  });

  jumpBtn.addEventListener('click', function () {
    openRewriteEditorFromProvenance(candidate);
  });
}

function openRewriteEditorFromProvenance(candidate) {
  if (!candidate || !candidate.requestId) {
    showToast('候选无效', 2500, 'error');
    return;
  }
  var req = findRequestById(candidate.requestId);
  if (!req) {
    showToast('无法找到对应请求', 2500, 'error');
    return;
  }
  closeFieldProvenanceDialog();
  hideProvenanceTrigger();
  openRewriteEditor(req, {
    focusJsonPath: candidate.jsonPath,
    focusValue: candidate.value,
    enableBodyMock: true
  });
}

function jumpToRequestFromProvenance(reqId) {
  closeFieldProvenanceDialog();
  hideProvenanceTrigger();
  if (!state.isPanelOpen) toggleMainPanel();
  setMainWorkbenchTab('requests');
  refreshRequestList(undefined, true);
  renderRequestDetail(reqId);
  var row = state.mainPanel && state.mainPanel.querySelector('.ai-req-request-item[data-id="' + reqId + '"]');
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function testEnvReplayForRequest(method, pathname, query, reqRecord) {
  var prodOrigin = getEnvReplayProdOrigin();
  if (!prodOrigin) {
    showToast('请先在设置页配置正式环境域名', 2800, 'warn');
    return;
  }
  if (String(method || '').toUpperCase() !== 'GET') {
    showToast('跨环境测试仅支持 GET', 2500, 'warn');
    return;
  }
  // 默认沿用测试请求的请求头
  var baseReqHeaders = {};
  if (reqRecord && reqRecord.requestHeaders && typeof reqRecord.requestHeaders === 'object') {
    baseReqHeaders = Object.assign({}, reqRecord.requestHeaders);
  }
  // 设置页配置的 prodHeaders 覆盖合并
  var overrideHeaders = getEnvReplayProdHeaders() || {};
  var mergedReqHeaders = Object.assign({}, baseReqHeaders, overrideHeaders);
  openEnvReplayTestDialog(method, pathname, query, null);
  try {
    chrome.runtime.sendMessage({
      type: 'ENV_REPLAY_FETCH',
      payload: {
        prodOrigin: prodOrigin,
        pathname: pathname,
        query: query,
        method: 'GET',
        tokenStorageKey: getEnvReplayTokenStorageKey(),
        manualToken: getEnvReplayManualToken(),
        reqHeaders: mergedReqHeaders,
        overrideHeaders: overrideHeaders
      }
    }, function (result) {
      if (chrome.runtime.lastError) {
        result = { ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR', error: chrome.runtime.lastError.message };
      }
      openEnvReplayTestDialog(method, pathname, query, result || { ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR' });
    });
  } catch (e) {
    openEnvReplayTestDialog(method, pathname, query, { ok: false, errorCode: 'PROD_FETCH_NETWORK_ERROR', error: e.message });
  }
}

var envReplayTestDialogEl = null;

function closeEnvReplayTestDialog() {
  if (envReplayTestDialogEl) {
    envReplayTestDialogEl.remove();
    envReplayTestDialogEl = null;
  }
}

function appendEnvReplayCollapsible(parent, label, content) {
  var wrap = document.createElement('div');
  wrap.className = 'ai-req-collapsible-wrap ai-req-envreplay-test-collapsible';
  var head = document.createElement('div');
  head.className = 'ai-req-collapsible-header';
  head.innerHTML = '<span class="ai-req-collapsible-arrow ai-req-collapsed">\u25BC</span> ' + escapeHtml(label);
  var body = document.createElement('div');
  body.className = 'ai-req-collapsible-content';
  body.style.display = 'none';
  var code = document.createElement('div');
  code.className = 'ai-req-code-block';
  code.textContent = content || '(空)';
  body.appendChild(code);
  head.addEventListener('click', function () {
    var isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    var arrow = head.querySelector('.ai-req-collapsible-arrow');
    if (arrow) arrow.classList.toggle('ai-req-collapsed', isOpen);
  });
  wrap.appendChild(head);
  wrap.appendChild(body);
  parent.appendChild(wrap);
}

function openEnvReplayTestDialog(method, pathname, query, result) {
  closeEnvReplayTestDialog();
  var prodOrigin = getEnvReplayProdOrigin();
  var prodHost = envReplayHostnameFromOrigin(prodOrigin);
  var prodUrl = String(prodOrigin).replace(/\/$/, '') + pathname + (query ? '?' + query : '');

  var overlay = document.createElement('div');
  overlay.className = 'ai-req-envreplay-test-overlay';
  var modal = document.createElement('div');
  modal.className = 'ai-req-envreplay-test-modal';

  var header = document.createElement('div');
  header.className = 'ai-req-envreplay-test-header';
  var titleWrap = document.createElement('div');
  titleWrap.className = 'ai-req-envreplay-test-title-wrap';
  var title = document.createElement('div');
  title.className = 'ai-req-envreplay-test-title';
  title.textContent = '跨环境测试';
  var subtitle = document.createElement('div');
  subtitle.className = 'ai-req-envreplay-test-subtitle';
  subtitle.textContent = method + ' ' + pathname;
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);
  header.appendChild(titleWrap);
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-req-envreplay-test-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.addEventListener('click', closeEnvReplayTestDialog);
  header.appendChild(closeBtn);

  var meta = document.createElement('div');
  meta.className = 'ai-req-envreplay-test-meta';
  meta.innerHTML =
    '<div><span class="ai-req-envreplay-test-meta-label">正式环境</span><span class="ai-req-envreplay-test-meta-value">' + escapeHtml(prodHost || prodOrigin) + '</span></div>' +
    '<div><span class="ai-req-envreplay-test-meta-label">正式 URL</span><span class="ai-req-envreplay-test-meta-value ai-req-envreplay-test-url" title="' + escapeHtml(prodUrl) + '">' + escapeHtml(prodUrl) + '</span></div>';

  var bodyWrap = document.createElement('div');
  bodyWrap.className = 'ai-req-envreplay-test-body-wrap';

  if (result === null) {
    bodyWrap.innerHTML = '<div class="ai-req-envreplay-test-loading"><span class="ai-req-envreplay-test-spinner"></span>正在向正式环境拉取…</div>';
  } else {
    // 公共：请求信息折叠区（成功和失败都显示，便于排查）
    if (result.reqInfo) {
      var viaMode = result.reqInfo.viaTab ? '页面注入（同源）' : 'service worker（跨源，可能被拒）';
      appendEnvReplayCollapsible(bodyWrap, '请求方式', viaMode + (result.reqInfo.fallbackReason ? ' · 回退：无正式环境 tab' : ''));
      appendEnvReplayCollapsible(bodyWrap, '请求头', formatJson(result.reqInfo.headers));
      appendEnvReplayCollapsible(bodyWrap, '请求体', result.reqInfo.body == null ? '(GET 请求无请求体)' : formatJson(result.reqInfo.body));
    }

    if (!result.ok) {
      var errMap = {
        PROD_ORIGIN_NOT_CONFIGURED: '未配置正式域名',
        PROD_FETCH_NETWORK_ERROR: '网络错误：' + (result.error || ''),
        PROD_FETCH_TIMEOUT: '正式环境请求超时（8s）',
        PROD_AUTH_FAILED: '正式环境未登录或 Cookie 已过期',
        PROD_RESPONSE_TOO_LARGE: '响应体过大（>2MB）',
        METHOD_NOT_ALLOWED: '仅支持 GET'
      };
      var errText = errMap[result.errorCode] || result.errorCode || '未知错误';
      var errBox = document.createElement('div');
      errBox.className = 'ai-req-envreplay-test-error';
      errBox.innerHTML = '<div class="ai-req-envreplay-test-error-code">' + escapeHtml(result.errorCode || 'ERROR') + '</div><div class="ai-req-envreplay-test-error-msg">' + escapeHtml(errText) + '</div>';
      bodyWrap.appendChild(errBox);
    } else {
      var statusBadge = document.createElement('div');
      statusBadge.className = 'ai-req-envreplay-test-status';
      statusBadge.textContent = 'HTTP ' + result.status + (result.warnings && result.warnings.length ? ' · ' + result.warnings.join(',') : '');
      bodyWrap.appendChild(statusBadge);

      // 检测应用层鉴权失败（HTTP 200 但 body 内 code=401/403）
      var appAuthFail = false;
      if (typeof result.body === 'object' && result.body) {
        var code = result.body.code != null ? result.body.code : result.body.status;
        if (code === 401 || code === 403) appAuthFail = true;
      }
      if (appAuthFail || (result.warnings && result.warnings.indexOf('NO_TOKEN_ATTACHED') >= 0)) {
        var tip = document.createElement('div');
        tip.className = 'ai-req-envreplay-test-tip';
        tip.innerHTML = '⚠ 正式环境鉴权未通过。请检查：<br>1) 在浏览器打开正式环境页面并登录，<b>保持该 tab 不关</b>（请求会在该 tab 内发出以保证同源）；或<br>2) 在设置页「Bearer Token（手动）」粘贴 token；或<br>3) 确认「Token 存储 Key」与正式环境 localStorage 键名一致。<br>4) 若仍失败，可能服务器有额外头校验，在设置页「正式环境请求头（JSON）」补充需要的头。';
        bodyWrap.appendChild(tip);
      }

      // 响应头折叠区
      if (result.headers) {
        appendEnvReplayCollapsible(bodyWrap, '响应头', formatJson(result.headers));
      }

      // 响应体（默认展开）
      var bodyText = typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2);
      var respLabel = document.createElement('div');
      respLabel.className = 'ai-req-envreplay-test-section-label';
      respLabel.textContent = '响应体';
      bodyWrap.appendChild(respLabel);
      var bodyPre = document.createElement('pre');
      bodyPre.className = 'ai-req-envreplay-test-body';
      bodyPre.textContent = bodyText;
      bodyWrap.appendChild(bodyPre);

      var actions = document.createElement('div');
      actions.className = 'ai-req-envreplay-test-actions';
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ai-req-btn ai-req-btn-secondary';
      copyBtn.textContent = '复制响应';
      copyBtn.addEventListener('click', function () {
        copyTextToClipboard(bodyText, function () {
          showToast('已复制到剪贴板', 2000, 'success');
        });
      });
      actions.appendChild(copyBtn);
      bodyWrap.appendChild(actions);
    }
  }

  modal.appendChild(header);
  modal.appendChild(meta);
  modal.appendChild(bodyWrap);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeEnvReplayTestDialog();
  });
  safeAppendChild(overlay);
  envReplayTestDialogEl = overlay;
}

var envReplayConfigDialogEl = null;

function closeEnvReplayConfigDialog() {
  if (envReplayConfigDialogEl) {
    envReplayConfigDialogEl.remove();
    envReplayConfigDialogEl = null;
  }
}

function openEnvReplayConfigDialog() {
  closeEnvReplayConfigDialog();
  var cfg = state.envReplayConfig || {};
  var prodOrigin = cfg.prodOrigin || '';
  var tokenKey = cfg.tokenStorageKey || 'token';
  var manualToken = cfg.manualToken || '';
  var prodHeadersJson = cfg.prodHeaders ? JSON.stringify(cfg.prodHeaders, null, 2) : '';

  var overlay = document.createElement('div');
  overlay.className = 'ai-req-envreplay-cfg-overlay';
  var modal = document.createElement('div');
  modal.className = 'ai-req-envreplay-cfg-modal';

  var header = document.createElement('div');
  header.className = 'ai-req-envreplay-cfg-header';
  var titleWrap = document.createElement('div');
  titleWrap.className = 'ai-req-envreplay-cfg-title-wrap';
  var title = document.createElement('div');
  title.className = 'ai-req-envreplay-cfg-title';
  title.textContent = '跨环境 Mock（当前站点）';
  var subtitle = document.createElement('div');
  subtitle.className = 'ai-req-envreplay-cfg-subtitle';
  subtitle.textContent = '测试站点：' + location.hostname + '。下面配置只保存到该站点，不会影响其他测试站点。';
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);
  header.appendChild(titleWrap);
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-req-envreplay-cfg-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.addEventListener('click', closeEnvReplayConfigDialog);
  header.appendChild(closeBtn);

  var body = document.createElement('div');
  body.className = 'ai-req-envreplay-cfg-body';

  function field(labelText, inputEl) {
    var f = document.createElement('label');
    f.className = 'ai-req-settings-field';
    var sp = document.createElement('span');
    sp.textContent = labelText;
    f.appendChild(sp);
    f.appendChild(inputEl);
    return f;
  }

  var prodInput = document.createElement('input');
  prodInput.type = 'text';
  prodInput.className = 'ai-req-settings-input ai-req-envreplay-cfg-prod';
  prodInput.value = prodOrigin;
  prodInput.placeholder = 'https://prod.admin.com 或 prod.admin.com';
  body.appendChild(field('正式环境域名', prodInput));

  var tokenKeyInput = document.createElement('input');
  tokenKeyInput.type = 'text';
  tokenKeyInput.className = 'ai-req-settings-input ai-req-envreplay-cfg-token-key';
  tokenKeyInput.value = tokenKey;
  tokenKeyInput.placeholder = 'token（localStorage 中的键名）';
  body.appendChild(field('Token 存储 Key', tokenKeyInput));

  var manualTokenInput = document.createElement('input');
  manualTokenInput.type = 'text';
  manualTokenInput.className = 'ai-req-settings-input ai-req-envreplay-cfg-manual-token';
  manualTokenInput.value = manualToken;
  manualTokenInput.placeholder = '留空则自动从正式环境 tab 读取';
  body.appendChild(field('Bearer Token（手动）', manualTokenInput));

  var prodHeadersTextarea = document.createElement('textarea');
  prodHeadersTextarea.className = 'ai-req-settings-input ai-req-envreplay-cfg-prod-headers';
  prodHeadersTextarea.rows = 3;
  prodHeadersTextarea.value = prodHeadersJson;
  prodHeadersTextarea.placeholder = '{"X-Tenant":"888"} 留空则沿用测试请求头';
  body.appendChild(field('正式环境请求头（JSON）', prodHeadersTextarea));

  var hint = document.createElement('div');
  hint.className = 'ai-req-settings-hint';
  hint.textContent = '配置后可在请求页勾选接口，自动拉取该站点对应正式环境的数据回放。请求头默认沿用测试请求头，上方 JSON 会合并覆盖。需在同一浏览器登录过正式环境，或填写 Bearer Token。仅支持 GET。';
  body.appendChild(hint);

  var actions = document.createElement('div');
  actions.className = 'ai-req-envreplay-cfg-actions';
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ai-req-btn ai-req-btn-secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeEnvReplayConfigDialog);
  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ai-req-btn ai-req-btn-primary';
  saveBtn.textContent = '保存配置';
  saveBtn.addEventListener('click', function () {
    var newProd = prodInput.value.trim();
    var newTokenKey = tokenKeyInput.value.trim();
    var newManual = manualTokenInput.value.trim();
    var newHeadersRaw = prodHeadersTextarea.value.trim();
    if (newHeadersRaw) {
      try {
        var parsed = JSON.parse(newHeadersRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          showToast('正式环境请求头 JSON 格式不正确', 2800, 'warn');
          return;
        }
      } catch (e) {
        showToast('正式环境请求头 JSON 解析失败：' + e.message, 3000, 'warn');
        return;
      }
    }
    saveEnvReplayConfig(newProd, newTokenKey, newManual, newHeadersRaw);
    // 同步回设置页输入框（若已渲染）
    try {
      var root = state.mainPanel;
      if (root) {
        var sProd = root.querySelector('.ai-req-settings-env-replay-prod');
        if (sProd) sProd.value = (state.envReplayConfig && state.envReplayConfig.prodOrigin) || '';
        var sTk = root.querySelector('.ai-req-settings-env-replay-token-key');
        if (sTk) sTk.value = (state.envReplayConfig && state.envReplayConfig.tokenStorageKey) || 'token';
        var sMt = root.querySelector('.ai-req-settings-env-replay-manual-token');
        if (sMt) sMt.value = (state.envReplayConfig && state.envReplayConfig.manualToken) || '';
        var sHd = root.querySelector('.ai-req-settings-env-replay-prod-headers');
        if (sHd) sHd.value = (state.envReplayConfig && state.envReplayConfig.prodHeaders) ? JSON.stringify(state.envReplayConfig.prodHeaders, null, 2) : '';
      }
    } catch (eSync) {}
    showToast('跨环境配置已保存', 2500, 'success');
    closeEnvReplayConfigDialog();
    try {
      refreshMainWorkbench();
    } catch (eR) {}
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeEnvReplayConfigDialog();
  });
  safeAppendChild(overlay);
  envReplayConfigDialogEl = overlay;
}

var envReplayModeMenuEl = null;

function closeEnvReplayModeMenu() {
  if (envReplayModeMenuEl) {
    envReplayModeMenuEl.remove();
    envReplayModeMenuEl = null;
  }
  document.removeEventListener('mousedown', handleEnvReplayModeMenuOutside, true);
  document.removeEventListener('keydown', handleEnvReplayModeMenuEsc, true);
}

function handleEnvReplayModeMenuOutside(e) {
  if (envReplayModeMenuEl && !envReplayModeMenuEl.contains(e.target)) {
    closeEnvReplayModeMenu();
  }
}

function handleEnvReplayModeMenuEsc(e) {
  if (e.key === 'Escape') closeEnvReplayModeMenu();
}

function openEnvReplayModeMenu(anchorEl, onPick) {
  closeEnvReplayModeMenu();
  var menu = document.createElement('div');
  menu.className = 'ai-req-envreplay-mode-menu';

  var title = document.createElement('div');
  title.className = 'ai-req-envreplay-mode-menu-title';
  title.textContent = '选择生效模式';
  menu.appendChild(title);

  function addItem(mode, label, desc) {
    var item = document.createElement('div');
    item.className = 'ai-req-envreplay-mode-menu-item';
    item.setAttribute('data-mode', mode);
    var name = document.createElement('div');
    name.className = 'ai-req-envreplay-mode-menu-item-name';
    name.textContent = label;
    var hint = document.createElement('div');
    hint.className = 'ai-req-envreplay-mode-menu-item-hint';
    hint.textContent = desc;
    item.appendChild(name);
    item.appendChild(hint);
    item.addEventListener('click', function () {
      closeEnvReplayModeMenu();
      if (typeof onPick === 'function') onPick(mode);
    });
    menu.appendChild(item);
  }

  addItem('next', '仅下一次', '命中一次后自动取消勾选');
  addItem('persistent', '持续', '保持启用，每次命中都回放正式数据');

  // 定位到锚点下方
  var rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.zIndex = '2147483647';

  safeAppendChild(menu);
  envReplayModeMenuEl = menu;

  // 边界修正：超出视口右/下则翻转
  setTimeout(function () {
    if (!envReplayModeMenuEl) return;
    var mRect = menu.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (mRect.right > vw - 8) {
      menu.style.left = Math.max(8, vw - mRect.width - 8) + 'px';
    }
    if (mRect.bottom > vh - 8) {
      menu.style.top = Math.max(8, rect.top - mRect.height - 4) + 'px';
    }
  }, 0);

  document.addEventListener('mousedown', handleEnvReplayModeMenuOutside, true);
  document.addEventListener('keydown', handleEnvReplayModeMenuEsc, true);
}
