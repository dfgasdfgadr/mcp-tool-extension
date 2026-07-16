# AI 请求智能分析助手 (mcp-tool-extension)

> 这是一个浏览器扩展程序，用于在真实业务页面上拦截并分析 Fetch/XHR 请求，录制业务流程，并一键生成 MCP (Model Context Protocol) 工具，供 Cursor、Claude 等 AI 客户端直接调用。

---

## 🌟 核心功能

1. **接口拦截与分析**：在业务页面上拦截 Fetch/XHR 请求，通过 AI 智能分析接口用途及字段含义（需配置 AI API Key）。
2. **业务流程录制 (FLOW)**：按真实业务顺序录制操作路径，自动识别关联的 API 请求，并分类为“核心”、“支撑”、“噪音”等，一键生成可靠的 MCP 工具。
3. **安全快捷的登录态复用**：AI 调用接口时直接复用浏览器当前的登录会话（Cookie 或页面实时 Token），无需手抄或硬编码凭据。
4. **Mock 与回放**：支持 Mock 规则、字段改写、跨环境响应回放（如将生产环境响应应用到测试环境验证 UI）。
5. **本地 MCP 服务**：通过 Native Messaging 与本地 Helper 连接，在本地启动 HTTP MCP 服务。

---

## 🛠️ 安装与配置

### 1. 加载浏览器扩展
1. 打开 Chrome 浏览器，访问 `chrome://extensions/`（Edge 浏览器访问 `edge://extensions/`）。
2. 开启右上角的 **「开发者模式」**。
3. 点击 **「加载已解压的扩展程序」**，选择本仓库的 `extension` 目录。
4. 加载完成后，**记下扩展 ID**（在卡片上显示，形如 `abcdefghijklmnopqrstuvwxyz`）。

### 2. 按站点开启扩展
> **注意**：默认情况下扩展在所有站点关闭，不会主动拦截请求。
1. 打开您的目标业务网站（支持 `http` / `https`）。
2. 点击浏览器工具栏上的本扩展图标，开启当前站点的拦截（开启后页面上会出现绿色悬浮球）。
3. 再次点击图标可关闭当前站点。

### 3. 注册 Native Messaging Host（MCP 必做）
为使扩展能与本地客户端通信，需要注册本地 Helper：
```bash
cd extension/mcp-helper
node install.mjs <您的扩展ID>
```

**注册行为摘要：**
* **Windows**：编译 launcher exe，写入 `com.aireq.mcp_helper.json` 并注册到注册表。
* **macOS**：写入 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。
* **Linux**：写入 `~/.config/google-chrome/NativeMessagingHosts/`。

> [!IMPORTANT]
> **注册完成后，必须完全关闭并重启浏览器！**

### 4. 配置 AI 引擎（可选）
1. 在已开启的网站上打开悬浮球，点击 **「设置」**（或右键菜单中选择「配置」）。
2. 配置您的 AI API Key（支持 OpenAI 兼容接口，默认支持 Kimi 等）。
3. 按需更改 Base URL 和 Model。

---

## 🚀 推荐上手路径（5分钟）

1. **安装扩展**：加载 `extension` 目录，并在终端运行 `node install.mjs <扩展ID>` 注册 Native Host，然后**重启浏览器**。
2. **开启站点**：打开您的业务网站，**点击工具栏图标开启本站拦截**。
3. **录制 Flow**：进入悬浮面板的 **「流程 / FLOW」** 页面，点击“开始录制”，在页面上操作几步业务，结束后点击“已验证生成 MCP”。
4. **启动服务**：在“MCP 工具”页面点击状态栏的 **「启动」**，服务将运行在 `http://127.0.0.1:9527`。
5. **配置客户端**：在 Cursor 配置文件 `mcp.json`（Windows 通常在 `%USERPROFILE%\.cursor\mcp.json`）中添加以下配置：
   ```json
   {
     "mcpServers": {
       "ai-request-analyzer": {
         "url": "http://127.0.0.1:9527/mcp"
       }
     }
   }
   ```
6. **验证调用**：在 Cursor Chat 中向 AI 提问（例如：`列出可用的 mcp 工具`），并尝试调用其中一个只读接口进行测试。

---

## 📖 核心功能详解

### 1. 抓包与 AI 分析
* 正常操作业务页面，在悬浮球面板中点击展开请求详情。
* 支持多选、过滤静态资源，可将选中的请求批量发送给 AI 进行字段和功能分析。

### 2. 字段 Mock 与数据溯源
1. 在页面上选中某个文本，点击附近的 **「查来源」** 气泡。
2. 系统会智能推断可能返回此文本的 API 及对应的 JSON Path。
3. 您可以修改该字段的值，并点击 **「保存字段 Mock」**。刷新页面后即可看到 Mock 效果。

### 3. 跨环境响应回放 (ProdFetch)
1. 在设置中配置「跨环境正式域名」。
2. 对测试环境中的 GET 请求启用「跨环境回放」。
3. 扩展将自动调用生产环境接口拉取真实响应，在测试环境展示，方便联调（需在同浏览器登录过生产环境）。

### 4. 运行时鉴权保障
* AI 客户端在调用接口时，**不会**使用录制时静态保存的凭据。
* 始终通过 Native Messaging 实时派发到当前浏览器页签进行 fetch。
* **使用建议**：在 AI 调用工具前，请保持目标站点在浏览器中至少有一个已登录的标签页。

---

## ⚙️ 配置项速查

| 配置项 | 位置 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **站点开关** | 工具栏图标 | 关 | 按 Hostname 启用拦截 |
| **API Key / Base URL** | 扩展设置 | Kimi 兼容默认 | 用于接口的 AI 翻译和字段推断 |
| **MCP 端口** | 扩展设置 | `9527` | 本地 Helper 的监听端口 |
| **MCP Token** | 扩展设置 / 环境变量 | 空 | 用于客户端调用的安全鉴权 (空为不鉴权) |
| **跨环境正式域名** | 扩展设置（按站点） | 空 | 跨环境回放所需的生产域名 |
| **MCP 工具命名** | 扩展设置 | `full` | 生成的工具函数命名风格 (`full`/`compact`) |

---

## 🛠️ 工作原理

```
MCP 客户端 (Cursor / Claude Desktop 等)
    │  HTTP MCP / JSON-RPC
    ▼
MCP Helper (Node.js 服务, Windows 下由 Launcher Exe 桥接)
    │  Native Messaging (标准输入输出)
    ▼
浏览器扩展 Background
    │  匹配对应标签页与运行时鉴权
    ▼
Content Script ──► 页面上下文 fetch (使用当前会话) ──► 站点 API
```

---

## ❓ 常见问题

* **Q：为什么页面上没有出现悬浮球？**
  * A：默认对所有站点关闭。请在目标站点页面，点击浏览器右上角的扩展图标，将开关切换至“开启”状态。
* **Q：本地 MCP 启动失败？**
  * 1. 确保已运行 `node install.mjs` 并完全重启了浏览器。
  * 2. 检查 `node -v` 是否正常可用。
  * 3. 检查扩展的 Service Worker 控制台，确认是否与 Native Host 正常连接，以及扩展 ID 是否已正确写入 `allowed_origins` 中。
* **Q：AI 调用提示未登录或越权？**
  * A：本扩展依靠页面当前登录会话。请确保浏览器中至少开启了一个该站点的已登录页签。