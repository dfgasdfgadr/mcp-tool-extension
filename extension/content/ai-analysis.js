function callAI(messages) {
  return new Promise(function (resolve, reject) {
    if (!state.config.apiKey) {
      reject(new Error('未配置API Key'));
      return;
    }
    var url = state.config.baseURL.replace(/\/$/, '') + '/chat/completions';
    chrome.runtime.sendMessage(
      {
        type: 'AI_CHAT_COMPLETIONS',
        payload: {
          url: url,
          apiKey: state.config.apiKey,
          model: state.config.model,
          messages: messages,
          temperature: 1
        }
      },
      function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (res && res.ok && typeof res.content === 'string') {
          resolve(res.content);
        } else {
          reject(new Error((res && res.error) || 'AI请求失败'));
        }
      }
    );
  });
}

function analyzeRequest(reqId) {
  if (!state.config.apiKey) {
    alert('请先配置API Key');
    return Promise.reject(new Error('未配置API Key'));
  }
  var req = null;
  for (var i = 0; i < state.requestRecords.length; i++) {
    if (state.requestRecords[i].id === reqId) {
      req = state.requestRecords[i];
      break;
    }
  }
  if (!req) return Promise.reject(new Error('请求不存在'));

  var messages = [
    {
      role: 'system',
      content: '你是一个HTTP请求分析专家。用户会给你一个HTTP请求的详细信息（URL、方法、请求体、响应体），请分析：1）这个请求的作用是什么 2）响应体中每个字段的含义。请用简洁清晰的中文回复。'
    },
    {
      role: 'user',
      content: '请分析以下请求：\n方法: ' + req.method + '\nURL: ' + req.url + '\n请求体: ' + truncateBody(formatJson(req.requestBody)) + '\n响应体: ' + truncateBody(formatJson(req.responseBody))
    }
  ];

  return callAI(messages).then(function (result) {
    req.aiAnalysis = result;
    if (state.expandedReqId === reqId || (state.ui && state.ui.requestTable && state.ui.requestTable.selectedId === reqId)) {
      renderRequestDetail(reqId);
    }
    refreshRequestList();
    return result;
  }).catch(function (err) {
    alert('AI分析失败: ' + err.message);
    throw err;
  });
}

function analyzeRequestsSequential(ids) {
  if (!ids || !ids.length) {
    showToast('\u672A\u9009\u4E2D\u8BF7\u6C42');
    return Promise.resolve();
  }
  if (!state.config.apiKey) {
    alert('请先配置API Key');
    return Promise.reject(new Error('未配置API Key'));
  }
  var uniqueIds = [];
  var seenId = {};
  for (var u = 0; u < ids.length; u++) {
    var id = ids[u];
    if (!id || seenId[id]) continue;
    seenId[id] = true;
    uniqueIds.push(id);
  }
  var need = [];
  for (var n = 0; n < uniqueIds.length; n++) {
    var req = null;
    for (var i = 0; i < state.requestRecords.length; i++) {
      if (state.requestRecords[i].id === uniqueIds[n]) {
        req = state.requestRecords[i];
        break;
      }
    }
    if (req && req.aiAnalysis == null) need.push(uniqueIds[n]);
  }
  if (need.length === 0) {
    showToast('\u6240\u9009\u8BF7\u6C42\u5DF2\u5168\u90E8\u5206\u6790\u8FC7');
    return Promise.resolve();
  }
  state.isAnalyzing = true;
  state.analyzeProgress = { total: need.length, done: 0 };
  updateAnalyzeProgress();
  var chain = Promise.resolve();
  need.forEach(function (reqId) {
    chain = chain.then(function () {
      return analyzeRequest(reqId).then(function () {
        state.analyzeProgress.done++;
        updateAnalyzeProgress();
      }).catch(function () {
        state.analyzeProgress.done++;
        updateAnalyzeProgress();
      });
    });
  });
  return chain.then(function () {
    state.isAnalyzing = false;
    updateAnalyzeProgress();
    showToast('\u6279\u91CF AI \u5206\u6790\u5B8C\u6210');
    if (typeof refreshRequestList === 'function') refreshRequestList(undefined, false);
  }).catch(function () {
    state.isAnalyzing = false;
    updateAnalyzeProgress();
  });
}

function analyzeAllRequests() {
  if (state.isAnalyzing) return;
  var unanalyzed = state.requestRecords.filter(function (r) { return r.aiAnalysis === null; });
  if (unanalyzed.length === 0) {
    alert('没有需要分析的请求');
    return;
  }
  state.isAnalyzing = true;
  state.analyzeProgress = { total: unanalyzed.length, done: 0 };
  updateAnalyzeProgress();

  var chain = Promise.resolve();
  unanalyzed.forEach(function (req) {
    chain = chain.then(function () {
      return analyzeRequest(req.id).then(function () {
        state.analyzeProgress.done++;
        updateAnalyzeProgress();
      }).catch(function () {
        state.analyzeProgress.done++;
        updateAnalyzeProgress();
      });
    });
  });

  chain.then(function () {
    state.isAnalyzing = false;
    updateAnalyzeProgress();
  }).catch(function () {
    state.isAnalyzing = false;
    updateAnalyzeProgress();
  });
}

function chatModify(userMessage) {
  if (!state.config.apiKey) {
    alert('请先配置API Key');
    return Promise.reject(new Error('未配置API Key'));
  }

  var summary = state.requestRecords.map(function (r, i) {
    try {
      return (i + 1) + '. ' + (r && r.method ? r.method : '-') + ' ' + getMockKey(r && r.url != null ? r.url : '');
    } catch (e) {
      return (i + 1) + '. (本条 URL 摘要失败)';
    }
  }).join('\n');

  var messages = [
    {
      role: 'system',
      content: '你是一个HTTP响应数据修改助手。用户会告诉你想修改哪个请求的响应数据以及如何修改。请生成修改后的完整JSON响应数据，用```json代码块包裹。只输出JSON，不要其他解释。'
    },
    {
      role: 'user',
      content: userMessage + '\n\n当前请求列表摘要：\n' + summary
    }
  ];

  return callAI(messages).then(function (result) {
    var jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (e) {
        alert('AI返回的JSON解析失败: ' + e.message);
        return null;
      }
    } else {
      alert('AI未返回有效的JSON代码块');
      return null;
    }
  }).catch(function (err) {
    alert('AI对话失败: ' + err.message);
    return null;
  });
}
