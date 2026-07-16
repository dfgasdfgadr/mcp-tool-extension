/**
 * One-shot: reads ../ai-request-analyzer.user.js, writes page-hook.js, content.css, isolated.js
 * Run from extension folder: node scripts/generate-from-userscript.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const userJsPath = path.join(root, 'ai-request-analyzer.user.js');
const extRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(userJsPath, 'utf8');

function extractGMAddStyleCss(s) {
  const m = s.match(/GM_addStyle\((\[[\s\S]*?\])\s*\.join\('\\n'\)\)/);
  if (!m) throw new Error('GM_addStyle block not found');
  const arr = new Function('return ' + m[1])();
  if (!Array.isArray(arr)) throw new Error('GM_addStyle array parse failed');
  return arr.join('\n');
}

function extractPageHookIifeBody(s) {
  const startMarker = `script.textContent = '(' + function (initialMockRules, recordMsgType, mockRulesMsgType, ruleConsumedMsgType) {`;
  const start = s.indexOf(startMarker);
  if (start === -1) throw new Error('page hook start not found');
  const bodyStart = start + startMarker.length;
  const endMarker = "} + ')(' + JSON.stringify(state.mockRules || {})";
  const end = s.indexOf(endMarker, bodyStart);
  if (end === -1) throw new Error('page hook end not found');
  return s.slice(bodyStart, end).trimEnd();
}

const pageHookInner = extractPageHookIifeBody(src);
const pageHookFile = `'use strict';
(function pageHookBootstrap(initialMockRules, recordMsgType, mockRulesMsgType, ruleConsumedMsgType) {
${pageHookInner}
})({}, 'AI_REQ_ANALYZER_PAGE_RECORD', 'AI_REQ_ANALYZER_MOCK_RULES', 'AI_REQ_ANALYZER_RULE_CONSUMED');
`;

const css = extractGMAddStyleCss(src);

const headerRe = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*\r?\n/;

let isolated = src.replace(headerRe, '');

const storageBlock = `
  var STORAGE_CACHE = {};

  function storageGet(key, defVal) {
    if (Object.prototype.hasOwnProperty.call(STORAGE_CACHE, key)) return STORAGE_CACHE[key];
    return defVal;
  }

  function storageSet(key, val) {
    if (val === null || typeof val === 'undefined') {
      delete STORAGE_CACHE[key];
      chrome.storage.local.remove(key);
      return;
    }
    STORAGE_CACHE[key] = val;
    var o = {};
    o[key] = val;
    chrome.storage.local.set(o);
  }

  function storageHydrateThen(cb) {
    chrome.storage.local.get(null, function (items) {
      if (chrome.runtime.lastError) {
        cb();
        return;
      }
      if (items) Object.assign(STORAGE_CACHE, items);
      cb();
    });
  }

`;

isolated = isolated.replace(
  /\(function \(\) {\r?\n  var DEFAULT_CONFIG/s,
  '(function () {\n' + storageBlock + '  var DEFAULT_CONFIG'
);

isolated = isolated.replace(/GM_getValue\(/g, 'storageGet(');
isolated = isolated.replace(/GM_setValue\(/g, 'storageSet(');

const callAISnippet = `
  function callAI(messages) {
    return new Promise(function (resolve, reject) {
      if (!state.config.apiKey) {
        reject(new Error('未配置API Key'));
        return;
      }
      var url = state.config.baseURL.replace(/\\/$/, '') + '/chat/completions';
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
`;

const callAIRe = /\n  function callAI\(messages\) {\r?\n    return new Promise\(function \(resolve, reject\) {\r?\n[\s\S]*?\n      \}\);\r?\n    \}\);\r?\n  \}/;

if (!callAIRe.test(isolated)) throw new Error('callAI replace failed');

isolated = isolated.replace(callAIRe, '\n  ' + callAISnippet.trim());

const newSetupPage = `
  function setupPageContextInterception() {
    window.addEventListener('message', function (event) {
      var data = event.data || {};
      if (!data) return;
      if (data.type === PAGE_RECORD_MSG && data.record) {
        addRequestRecord(data.record);
      } else if (data.type === PAGE_RULE_CONSUMED_MSG && data.key) {
        consumeOnceRuleByKey(data.key);
      }
    });

    chrome.runtime.sendMessage({ type: 'INJECT_PAGE_HOOK' }, function (res) {
      if (chrome.runtime.lastError) {
        console.warn('[AI_REQ_ANALYZER] inject MAIN:', chrome.runtime.lastError.message);
        return;
      }
      if (!res || !res.ok) {
        console.warn('[AI_REQ_ANALYZER] inject MAIN:', res && res.error ? res.error : 'unknown');
        return;
      }
      syncMockRulesToPage();
    });
  }
`;

/** 必须用 syncMockRulesToPage 锚定：`defineMockXhrResponse` 在内联 Hook 里也有一份，否则会误匹配并删掉 syncMockRulesToPage。 */
const setupPageOldRe =
  /\n  function setupPageContextInterception\(\) {\r?\n[\s\S]*?\r?\n  }\r?\n(?=\r?\n  function syncMockRulesToPage\(\) {)/;

if (!setupPageOldRe.test(isolated)) throw new Error('setupPageContextInterception replace failed');

isolated = isolated.replace(setupPageOldRe, '\n  ' + newSetupPage.trim());

const injectStub = `
  function injectStyles() {
    /* Styles loaded via manifest content_scripts css: content/content.css */
  }
`;

const injectOldRe =
  /\n  function injectStyles\(\) {\r?\n    GM_addStyle\(\[\r?\n[\s\S]*?\]\.join\('\\n'\)\);\r?\n  \}/;
if (!injectOldRe.test(isolated)) throw new Error('injectStyles replace failed');
isolated = isolated.replace(injectOldRe, '\n  ' + injectStub.trim());

const menuBlock = `
  function setupMenuCommands() {
    if (state.menuReady) return;
    state.menuReady = true;

    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg || msg.type !== 'AI_REQ_ANALYZER_MENU') return;

      if (msg.action === 'diagnostics') {
        chrome.runtime.sendMessage({ type: 'READ_PAGE_HOOK_INSTALLED' }, function (r) {
          var pageHooked = false;
          if (!chrome.runtime.lastError && r && r.hooked === true) {
            pageHooked = true;
          }
          alert(
            'AI请求分析助手状态：\\n' +
              'URL: ' + location.href + '\\n' +
              'UI: ' + (state.uiReady ? '已初始化' : '未初始化') + '\\n' +
              '悬浮球: ' +
              (state.floatingBall && document.contains(state.floatingBall) ? '已挂载' : '未挂载') +
              '\\n' +
              '请求数: ' + state.requestRecords.length + '\\n' +
              '页面Hook: ' +
              (pageHooked ? '已注入' : '未知/注入失败或被阻止')
          );
          sendResponse({ ok: true });
        });
        return true;
      }

      switch (msg.action) {
        case 'open_panel':
          if (!state.uiReady) onDOMContentLoaded();
          if (!state.isPanelOpen) toggleMainPanel();
          break;
        case 'open_config':
          if (!state.uiReady) onDOMContentLoaded();
          openConfigPanel();
          break;
        case 'reset_positions':
          storageSet(getScopedStorageKey('ai_req_ball_position'), null);
          storageSet(getScopedStorageKey('ai_req_panel_position'), null);
          if (state.floatingBall) {
            state.floatingBall.style.left = 'auto';
            state.floatingBall.style.top = 'auto';
            state.floatingBall.style.right = '20px';
            state.floatingBall.style.bottom = '20px';
          }
          if (state.mainPanel) {
            state.mainPanel.style.left = 'auto';
            state.mainPanel.style.top = 'auto';
            state.mainPanel.style.right = '90px';
            state.mainPanel.style.bottom = '20px';
          }
          showToast('悬浮窗位置已重置');
          break;
        default:
          break;
      }
      sendResponse({ ok: true });
      return false;
    });
  }
`;

const menuOldRe =
  /\n  function setupMenuCommands\(\) {\r?\n[\s\S]*?\n  }\r?\n\r?\n  function escapeHtml/;
if (!menuOldRe.test(isolated)) throw new Error('setupMenuCommands replace failed');
isolated = isolated.replace(menuOldRe, '\n  ' + menuBlock.trim() + '\n\n  function escapeHtml');

const newInit = `
  function init() {
    storageHydrateThen(function () {
      loadConfig();
      loadMockRules();
      setupMenuCommands();
      setupRequestInterception();
    });
  }
`;
const oldInitRe =
  /\n  function init\(\) {\r?\n    loadConfig\(\);\r?\n    loadMockRules\(\);\r?\n    setupMenuCommands\(\);\r?\n    setupRequestInterception\(\);\r?\n  }/;
if (!oldInitRe.test(isolated)) throw new Error('init replace failed');
isolated = isolated.replace(oldInitRe, newInit.replace(/^\n/, '\n'));

fs.mkdirSync(path.join(extRoot, 'content'), { recursive: true });
fs.writeFileSync(path.join(extRoot, 'content', 'page-hook.js'), pageHookFile, 'utf8');
fs.writeFileSync(path.join(extRoot, 'content', 'content.css'), css, 'utf8');
fs.writeFileSync(path.join(extRoot, 'content', 'isolated.js'), isolated.trimEnd() + '\n', 'utf8');
console.log('Wrote content/page-hook.js, content/content.css, content/isolated.js');