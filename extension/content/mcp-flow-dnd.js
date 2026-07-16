var mcpFlowDnDState = {
  toolNames: [],
  sourceFlowId: null,
  activeDropEl: null
};

function getMcpDragToolNames(primaryToolName) {
  var selected = typeof getSelectedMcpToolNamesOrdered === 'function'
    ? getSelectedMcpToolNamesOrdered()
    : [];
  if (selected.length && selected.indexOf(primaryToolName) >= 0) return selected.slice();
  return [primaryToolName];
}

function resolveMcpFlowDropTarget(el) {
  if (!el || !el.closest) return null;
  var header = el.closest('.ai-req-mcp-flow-group-header');
  if (header) {
    return {
      type: 'header',
      el: header,
      groupKey: header.getAttribute('data-flow-group-key'),
      flowId: header.getAttribute('data-flow-id')
    };
  }
  var row = el.closest('.ai-req-mcp-tool-row');
  if (row) {
    return {
      type: 'row',
      el: row,
      toolName: row.getAttribute('data-tool-name'),
      flowId: row.getAttribute('data-flow-id')
    };
  }
  return null;
}

function canDropToolsOnTarget(target, toolNames) {
  if (!target || !toolNames || !toolNames.length) return false;
  if (target.groupKey === '__system__') return false;
  if (target.groupKey === '__other__') {
    var i;
    for (i = 0; i < toolNames.length; i++) {
      var loaded = loadToolForMembership(toolNames[i]);
      if (loaded.tool && loaded.tool._meta && loaded.tool._meta.flow && loaded.tool._meta.flow.flowId) {
        return true;
      }
    }
    return false;
  }
  if (target.flowId) {
    var flow = getFlowById(target.flowId);
    if (!flow) return false;
    var ni;
    for (ni = 0; ni < toolNames.length; ni++) {
      var ld = loadToolForMembership(toolNames[ni]);
      if (!ld.tool) continue;
      if (!canAssignToolToFlow(flow, ld.host)) return false;
    }
    return true;
  }
  return false;
}

function clearMcpFlowDropHighlight() {
  if (mcpFlowDnDState.activeDropEl) {
    mcpFlowDnDState.activeDropEl.classList.remove('ai-req-mcp-drop-ok');
    mcpFlowDnDState.activeDropEl.classList.remove('ai-req-mcp-drop-forbidden');
    mcpFlowDnDState.activeDropEl = null;
  }
}

function setMcpFlowDropHighlight(el, ok) {
  clearMcpFlowDropHighlight();
  if (!el) return;
  mcpFlowDnDState.activeDropEl = el;
  el.classList.add(ok ? 'ai-req-mcp-drop-ok' : 'ai-req-mcp-drop-forbidden');
}

function handleMcpFlowDrop(mcpContent, target, dragNames, sourceFlowId) {
  if (!target || !dragNames || !dragNames.length) return;
  function refreshList() {
    if (!mcpContent || !mcpContent.querySelector) return;
    if (!mcpContent.querySelector('.ai-req-mcp-tool-list')) {
      var panel = document.querySelector('.ai-req-mcp-content');
      if (panel) mcpContent = panel;
    }
    refreshMcpToolListViewLocal(mcpContent);
  }
  if (target.type === 'header') {
    if (target.groupKey === '__system__') return;
    if (target.groupKey === '__other__') {
      var ur = unassignToolsFromFlow(dragNames);
      refreshList();
      if (typeof showToast === 'function') {
        showToast('已移出 ' + ur.moved + ' 个工具', 2500, 'success');
      }
      return;
    }
    if (target.flowId) {
      var ar = assignToolsToFlow(dragNames, target.flowId);
      refreshList();
      if (typeof showToast === 'function') {
        if (ar.rejected > 0) {
          showToast('该流程仅支持同站点工具', 3000, 'error');
        } else if (ar.moved > 0) {
          var tf = getFlowById(target.flowId);
          showToast('已移入「' + (tf && tf.name ? tf.name : target.flowId) + '」', 2500, 'success');
        }
      }
    }
    return;
  }
  if (target.type === 'row' && target.flowId && target.toolName) {
    var flowId = target.flowId;
    if (sourceFlowId === flowId) {
      var flow = getFlowById(flowId);
      if (!flow) return;
      var newOrder = insertToolsInFlowOrder(flow, dragNames, target.toolName);
      reorderToolsInFlow(flowId, newOrder);
      refreshList();
      if (typeof showToast === 'function') {
        showToast('已更新顺序（' + dragNames.length + ' 个工具）', 2500, 'success');
      }
      return;
    }
    var assignResult = assignToolsToFlow(dragNames, flowId);
    if (assignResult.rejected > 0) {
      if (typeof showToast === 'function') showToast('该流程仅支持同站点工具', 3000, 'error');
      refreshList();
      return;
    }
    var updatedFlow = getFlowById(flowId);
    if (updatedFlow) {
      var ordered = insertToolsInFlowOrder(updatedFlow, dragNames, target.toolName);
      reorderToolsInFlow(flowId, ordered);
    }
    refreshList();
    if (typeof showToast === 'function' && assignResult.moved > 0) {
      showToast('已移入「' + (updatedFlow && updatedFlow.name ? updatedFlow.name : flowId) + '」', 2500, 'success');
    }
  }
}

function initMcpFlowDnD(mcpContent) {
  if (!mcpContent || mcpContent._mcpFlowDnDBound) return;
  mcpContent._mcpFlowDnDBound = true;

  mcpContent.addEventListener('dragstart', function (ev) {
    var handle = ev.target && ev.target.closest ? ev.target.closest('.ai-req-mcp-drag-handle') : null;
    if (!handle) return;
    var row = handle.closest('.ai-req-mcp-tool-row');
    if (!row) return;
    var toolName = row.getAttribute('data-tool-name');
    if (!toolName) return;
    var names = getMcpDragToolNames(toolName);
    mcpFlowDnDState.toolNames = names;
    mcpFlowDnDState.sourceFlowId = row.getAttribute('data-flow-id') || null;
    row.classList.add('ai-req-mcp-row-dragging');
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('text/plain', toolName);
      ev.dataTransfer.effectAllowed = 'move';
    }
  });

  mcpContent.addEventListener('dragend', function () {
    mcpFlowDnDState.toolNames = [];
    mcpFlowDnDState.sourceFlowId = null;
    clearMcpFlowDropHighlight();
    var dragging = mcpContent.querySelectorAll('.ai-req-mcp-row-dragging');
    var di;
    for (di = 0; di < dragging.length; di++) {
      dragging[di].classList.remove('ai-req-mcp-row-dragging');
    }
  });

  mcpContent.addEventListener('dragover', function (ev) {
    if (!mcpFlowDnDState.toolNames.length) return;
    var target = resolveMcpFlowDropTarget(ev.target);
    if (!target || !target.el) return;
    var ok = canDropToolsOnTarget(target, mcpFlowDnDState.toolNames);
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = ok ? 'move' : 'none';
    setMcpFlowDropHighlight(target.el, ok);
  });

  mcpContent.addEventListener('dragleave', function (ev) {
    var related = ev.relatedTarget;
    if (related && mcpContent.contains(related)) return;
    clearMcpFlowDropHighlight();
  });

  mcpContent.addEventListener('drop', function (ev) {
    if (!mcpFlowDnDState.toolNames.length) return;
    ev.preventDefault();
    var target = resolveMcpFlowDropTarget(ev.target);
    clearMcpFlowDropHighlight();
    if (!target || !canDropToolsOnTarget(target, mcpFlowDnDState.toolNames)) return;
    handleMcpFlowDrop(
      mcpContent,
      target,
      mcpFlowDnDState.toolNames.slice(),
      mcpFlowDnDState.sourceFlowId
    );
    mcpFlowDnDState.toolNames = [];
    mcpFlowDnDState.sourceFlowId = null;
  });
}
