# deepseek-web-bridge

OpenAI 兼容的本地网关：用 **PHP** 做接入层，用 **Playwright sidecar** 驱动 DeepSeek 网页会话，让任意 OpenAI SDK / 客户端（OpenCode、Continue、LobeChat 等）直接对话。

> 仅支持 **DeepSeek**（`deepseek-chat`）。特性：流式 / 非流式、**工具调用（含原生 DSML 兼容）**、**图片输入（多模态）**、原始 markdown 保真、`usage` token / 缓存命中统计、多账号号池。

## 免责声明（Disclaimer）

1. 本项目**仅供学习、研究与技术交流**使用，请勿用于任何违法违规用途。
2. 使用本项目产生的一切行为与后果（包括账号、数据、服务条款相关风险）**由使用者自行承担**；作者与贡献者**不承担任何责任**。
3. 本项目通过浏览器自动化访问网页版服务，**必须遵守**目标网站的《服务条款》《隐私政策》及所在地法律法规；若相关条款禁止自动化访问，请立即停止使用。
4. 本项目与 DeepSeek 及其关联公司**无任何官方合作、授权或背书**；商标与内容版权归其权利人所有。
5. 本软件按 **Apache License 2.0**「原样」提供，**不附带任何明示或默示担保**（详见 `LICENSE` 与免责声明条款）。
6. 请勿将默认 `API_KEY` 暴露到公网；因弱口令、错误绑定导致的泄露风险由使用者自负。

## 架构

```
客户端 (OpenAI SDK / OpenCode / curl)
    │  HTTP  (Bearer API_KEY)
    ▼
PHP 网关 :8080
    │  鉴权 · 路由 · SSE · 工具调用协议 · prompt 拼接
    │  HTTP
    ▼
Playwright sidecar :8090
    │  号池：多账号会话全部后台在线（默认无头、不占窗口）
    │  空闲槽位分配 · 排队等待 · 共用 1 个登录窗口逐个换号登录
    ▼
https://chat.deepseek.com/  (真实网页会话，每账号独立登录态)
```

### 无状态会话策略

1. `extract_prompt` 把请求里**全部** `messages` 拼成完整上下文  
2. **发送前** `freshChat` 开启新对话 → 注入全量 prompt（每次请求独立会话）  
3. 轮询等待 answer 稳定后返回  
4. **输出完成后** 再次 `freshChat`，为下次请求准备空白会话  
5. 上下文压缩 / 整理类请求走同一路径，无需特殊分支  

对客户端完全无状态：任意 OpenAI 兼容客户端每次带上完整历史即可。

### 输出保真（Markdown）

网页版把回答渲染成 HTML 后，`innerText` 只剩纯文本——表格被拆成 tab 分隔、`**加粗**` 消失、代码块丢掉围栏。网关改为从 React fiber 的 `markdown` 属性读**渲染前的原始 markdown 源码**（网页「复制」按钮拷的也是它）：

- 表格 `|---|`、`**加粗**`、列表、代码围栏等语法原样返回，流式 / 非流式一致
- 思考过程是纯文本节点（`.ds-think-content`），仍按纯文本读取
- 联网搜索的引用占位 `[reference:N]` **直接剥掉**，API 不输出引用链接

### 图片输入（多模态）

消息内容支持 OpenAI 多模态格式（`content: [{"type":"text"},{"type":"image_url","image_url":{"url":"..."}}]`）：

- 图片可为 `data:image/...;base64,...` 或 http(s) 链接；每次最多取 4 张（单张 >6MB 跳过）
- 发送前 sidecar 会把图片注入网页输入框（自动等待上传预览完成后）再连同文字发送，模型直接“看到”图片
- 无状态会话：历史里的图片在后续每轮都会重新提取并上传，客户端无需特殊处理
- 只发图片不写文字也可以（不会报 `no message content`）

### 工具调用（Tools）

- 请求带 `tools` 时，网关把工具定义与调用协议注入 prompt；模型可用两种格式发起调用：
  - 网关协议：`<tool_calls>[{"name":"...","arguments":{...}}]</tool_calls>`（允许前面带一句说明文字）
  - DeepSeek 原生 **DSML** 格式：`<｜｜DSML｜｜ calls> … <｜｜DSML｜｜ invoke name="..."> …`
- 两种格式都会解析为标准 OpenAI `tool_calls` 返回；流式过程中标记不会明文泄漏给客户端，说明文字作为 `content` 保留
- 工具结果（`role:"tool"`）按 OpenAI 规范拼回上下文；`tool_choice` 支持 `auto` / `required` / `none` / 指定函数
- 回归测试：`php scripts/test-toolcalling.php`（37 项）

### 用量统计（usage）

响应包含 OpenAI `usage` 对象（估算值，CJK 感知）：

- `prompt_tokens` / `completion_tokens` / `total_tokens`
- `completion_tokens_details.reasoning_tokens`（深度思考计入 completion）
- `prompt_tokens_details.cached_tokens`，以及 DeepSeek 风格的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（按“前缀缓存”估算：除最后一条外的历史视为命中）
- 流式：finish 分片带 `usage`；请求带 `stream_options.include_usage` 时额外补一条标准 usage-only 分片
- 推理 token 多别名输出（`completion_tokens_details.reasoning_tokens`、`output_tokens_details.reasoning_tokens`、顶层 `reasoning_tokens`），兼容不同客户端版本的显示

### 成本与节省（对齐官方价）

- 按 **DeepSeek-V4.1-Flash** 官方价（CNY / 1M tokens）折算：缓存命中 **0.04(高峰)/0.02(空闲)**、未命中 **2/1**、输出 **8/4**；高峰时段为北京时间 **9:00-12:00、14:00-18:00**（其余时间空闲，价格减半）
- 每次请求的 `usage` 附带 `cost_cny` / `cost_usd`；USD 按 `USD_CNY_RATE`（默认 7.2，环境变量可覆盖）换算
- 网关自动累计「**已帮您节省**」（网页会话免费，按官方 API 价折算）：`/login` 页面与桌面应用均显示；`GET /savings` 返回累计 JSON（cny / usd / requests / prompt_tokens / completion_tokens / reasoning_tokens）
- 累计文件 `savings.json`（网关目录，已 gitignore）

### 完成判定（防截断）

- **停止按钮硬信号**：生成中输入区的实心圆按钮是「停止方块」，回「发送箭头」才认为生成结束——页面渲染卡顿再久也不会提前收尾
- 文本稳定后再进入 `completionGraceMs`（默认 3000ms）宽限期作为兜底；停止信号常亮但文本 90 秒无变化按卡死放行
- 可在 `node/providers.js` 调整 `completionGraceMs` / `completionStablePolls`

### 流式输出（防重写错位）

- 网页在生成中会**改写已有内容**（典型是表格：先出半截表头再补全）。若把改写前后两版都发给客户端，追加式 SSE 的客户端会出现叠字/错位
- 网关采用**尾部暂扣**：只发送到「最后一个空行」或至少扣住尾部 300 字符，改写中的半成品不外发
- 收尾时按最长公共前缀一次性补齐；实测流式拼接结果与最终文本逐字一致（`concat == done.answer`）

### 联网搜索与深度思考

每次发送前 `ensureModes` 校正输入框开关：**联网搜索默认强制关闭**，**深度思考保持开启**。按钮按文本识别（日志 `[modes]`），开关未变化时不产生额外等待。

### 性能

- 页面状态**增量读取**：只回新增片段，避免每次轮询全量取文本（轮询间隔 200ms）
- **快进路径**：确认刚 freshChat 过的干净会话跳过 idle / fresh 等待；开关无变化不 sleep
- 固定等待已全部移除，单请求注入开销约几毫秒；耗时大头是 DeepSeek 服务端首字延迟（约 6s）

### 号池（Account Pool）

单账号单会话无法并发：一条 chat 占用页面时，其他请求只能排队。号池用**多账号**解决：

- 配置：`/login` 页面直接**增删账号**（写入 `node/accounts.json` 并热加载，无需重启）；文件在 gitignore，模板见 `node/accounts.example.json`  
- **后台在线**：每个已登录账号一个独立浏览器上下文（登录态隔离），默认**无头运行、不占窗口**；启动时自动预热已登录账号，掉线自动重连（自愈轮询 30s）  
- **登录**：全池共用**一个可见窗口**。点某账号「登录此账号」→ 窗口自动清掉上个会话并打开登录页 → 登录成功后自动保存并转入后台在线 → 继续点下一个账号，在同一窗口换号继续。无需每个账号开一个窗口；点「关闭登录窗口」可收掉窗口（不影响后台会话）  
- 策略：`least_busy`（默认，选最闲）或 `round_robin`（改 `accounts.json` 的 `strategy` 后重启 sidecar）  
- **封号/禁言识别**：页面出现「账号已被禁言/封禁」等提示时，该账号标记为**已封号**——不再计为已登录（如 2/2 → 1/2）、登录页显示红色「已封号」、**接收请求时自动跳过**；提示消失后自动恢复（自愈）  
- 并发：请求按 `accountId` 分配空闲槽位；全忙时**排队等待**，槽位释放即接管，超时返回 504  
- 无头被站点风控时可用环境变量 `POOL_HEADLESS=0` 切回有窗口调试模式再排查  
- 并发上限还取决于 PHP 网关：`manage.ps1` 启动时默认设置 `PHP_CLI_SERVER_WORKERS=8`（PHP 内置服务器单线程会卡住并发）  

```powershell
# 也可走 HTTP 直接管理（与页面同源）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/accounts `
  -ContentType 'application/json' -Body '{"id":"acc2","label":"账号2"}'
Invoke-RestMethod -Uri http://127.0.0.1:8080/accounts
Invoke-RestMethod -Method Delete -Uri 'http://127.0.0.1:8080/accounts?id=acc2'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/login/close   # 关闭共用登录窗口
```

## 桌面版（Windows 安装程序）

不想装 PHP / Node / 浏览器？从 [Releases](../../releases) 下载Windows安装包，一键安装（当前用户、免管理员）：

- **内置完整运行时**：官方 PHP NTS + 官方 Node（构建时从官网下载并校验 SHA256）+ Playwright Chromium，全程离线可用；**不读不写系统环境变量**
- **应用内页面视图**：网关 `/login` 登录页显示在应用窗口里，**不会弹外部浏览器**
- **控制面板**：启动 / 停止服务、网关与 sidecar 在线状态、账号在线数；「设置」页可改网关 / sidecar 端口、`API_KEY`、超时、PHP 路径、附加环境变量（改动需重启服务生效）；「日志」页实时输出两侧进程日志
- 数据目录：`%APPDATA%\DeepSeek Web Bridge\settings.json`

```powershell
# 从源码构建安装程序（需本机 Node + npm；运行时与浏览器由脚本自动下载）
cd desktop
npm install
npm run dist     # -> desktop/dist/DeepSeekWebBridge-Setup-x.y.z.exe
```

仓库里有**两份源码**：根目录是开发用的第一份（`manage.ps1` 流程，保持不动）；`desktop/` 是第二份——`npm run dist` 时 `sync-gateway.ps1` 把根目录源码同步进 `desktop/resources/gateway` 作为打包载荷，安装包里的网关永远来自根目录的当前代码。

## 环境要求（最低）

| 组件 | 最低版本 | 说明 |
|------|----------|------|
| PHP | 8.1 | 需 `curl` 扩展；`post_max_size ≥ 8M` 建议 |
| Node.js | 18 | sidecar 运行时 |
| npm | 随 Node | 安装依赖 |
| 浏览器 | Chrome / Edge / Chromium | 或 `playwright install chromium` |
| 网络 | 可访问 chat.deepseek.com | 首次需完成网页登录 |

路径不要求一致：脚本自动探测 `php` / `node` / 浏览器，可用环境变量覆盖。

## 快速开始（仅一个脚本）

```powershell
# 交互菜单（推荐）
.\scripts\manage.ps1

# 或直接动作
.\scripts\manage.ps1 -Action check    # 环境检测
.\scripts\manage.ps1 -Action setup    # 安装 / 升级 / 补依赖
.\scripts\manage.ps1 -Action start    # 一键启动（默认 8080/8090）
.\scripts\manage.ps1 -Action start -GatewayPort 8180 -SidecarPort 8190
.\scripts\manage.ps1 -Action stop     # 一键停止
```

菜单项：

1. 环境检测（最低要求 + 语法）  
2. 安装·升级·补依赖（`npm install` + `npm run check`）  
3. 一键启动（可自定义网关 / sidecar 端口，写入 `scripts/.run/state.json`）  
4. 一键停止  
5. 打开登录页  
0. 退出  

启动后浏览器打开：

```
http://127.0.0.1:8080/login
```

完成 DeepSeek 网页登录后即可调用 API。

### 调用示例

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/v1/models -H "Authorization: Bearer sk-test-local-proxy-key"

curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test-local-proxy-key" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

### OpenCode 配置片段

```jsonc
{
  "provider": {
    "deepseek-web-bridge": {
      "name": "DeepSeek Web Bridge",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1",
        "apiKey": "sk-test-local-proxy-key"
      },
      "models": {
        "deepseek-chat": { "name": "DeepSeek" }
      }
    }
  }
}
```

> `baseURL` 必须指向**网关端口**（默认 8080），不要写 sidecar 端口（默认 8090）。

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `PHP_BIN` | 自动探测 | PHP 可执行文件 |
| `NODE_BIN` | 自动探测 | Node 可执行文件 |
| `CHROME_PATH` | 自动探测 | 浏览器可执行文件 |
| `GATEWAY_PORT` | `8080` | 网关端口（`config.php` / 启动共用） |
| `SIDECAR_PORT` | `8090` | sidecar 端口 |
| `GATEWAY_BIND` | `0.0.0.0` | 监听地址（`127.0.0.1` 仅本机） |
| `API_KEY` | 见 `config.php` | 覆盖鉴权 Key |
| `CHAT_TIMEOUT_SEC` | `120` | 单次 chat 超时 |
| `PHP_CLI_SERVER_WORKERS` | `8` | PHP 内置服务器并发 worker（号池并发关键） |
| `POOL_HEADLESS` | `1` | `0` = 工作会话改有窗口（调试风控问题用） |

自定义端口时，**`GATEWAY_PORT` / `SIDECAR_PORT` 必须一致**传给 PHP 进程与 sidecar；`manage.ps1 -Action start` 会自动写入状态并导出环境变量，改端口请**停止后重新启动**。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含号池 busy / loggedIn） |
| GET | `/login` | 账号池登录页（增删账号 + 逐个登录） |
| POST | `/login/open` | 共用登录窗口：打开/切换账号 `{"provider":"deepseek","accountId":"acc1"}` |
| POST | `/login/close` | 关闭共用登录窗口（后台会话不受影响） |
| GET | `/login/status` | 账号池状态 JSON（按 accountId 键控） |
| GET/POST/DELETE | `/accounts` | 账号池增删查（POST `{"id","label"}`；DELETE `?id=`；写入 accounts.json 热加载） |
| GET | `/v1/models` | 模型列表（任一账号已登录即 available；声明 `vision` / `input_modalities` 支持图片） |
| GET | `/savings` | 累计「已帮您节省」金额与 token 统计（公开，无需鉴权） |
| POST | `/v1/chat/completions` | OpenAI 兼容 chat（stream / non-stream / tools / 多模态图片；响应含 `usage`） |
| GET | `/accounts`（sidecar :8090） | sidecar 直连：同上（仅 PHP 内部 / 本机调试用） |

鉴权：除 health / login 相关 / 账号池（`/accounts`）路径外，需 `Authorization: Bearer <API_KEY>`，与 `config.php` 中 `API_KEY` 全等。

## 目录结构

```
deepseek-web-bridge/
├── index.php              # 主入口：路由 / 鉴权 / SSE / chat
├── config.php             # 配置：API_KEY、端口、超时、upstream
├── lib/
│   ├── Helpers.php        # JSON / SSE / extract_prompt / 日志
│   ├── ToolCalling.php    # 工具调用协议注入与解析
│   └── WebDriver.php      # sidecar HTTP 客户端 + model→provider
├── node/
│   ├── package.json       # playwright 依赖
│   ├── sidecar.js         # HTTP sidecar：/login /chat /health /accounts
│   ├── pool.js            # 号池：AccountPool 分配 / 排队 / 热加载
│   ├── accounts.example.json  # 号池配置模板（复制为 accounts.json）
│   ├── test-pool.js       # 号池单测
│   ├── providers.js       # DeepSeek 选择器与自动化配置
│   ├── bridge.js          # 页面状态读取 / send / freshChat
│   ├── webdriver.js       # chat 状态机
│   └── profiles/          # 每账号 storageState（已 gitignore）
├── scripts/
│   ├── manage.ps1         # 唯一管理脚本：检测/依赖/启动/停止菜单
│   └── test-toolcalling.php  # 工具调用解析回归测试（37 项）
├── desktop/               # 桌面版（第二份源码）：Electron 壳 + 打包脚本
│   ├── src/               # main/preload/renderer（内嵌页面 + 设置 + 日志）
│   ├── build/             # download-env / sync-gateway / prepare-payload
│   └── package.json       # electron-builder NSIS 配置
├── test.html              # 本地调试页
├── LICENSE                # Apache-2.0
├── NOTICE
└── README.md
```

## 配置说明（config.php）

| 常量 | 默认 | 说明 |
|------|------|------|
| `API_KEY` | `sk-test-local-proxy-key` | **上线前必改** |
| `LISTEN_PORT` | `8080` | 网关端口（`GATEWAY_PORT`） |
| `SIDECAR_PORT` | `8090` | sidecar 端口 |
| `BIND_LAN` | `true` | `true`=0.0.0.0，`false`=127.0.0.1 |
| `CHAT_TIMEOUT_SEC` | `120` | 单次 chat 超时 |
| `MAX_BODY_BYTES` | `8388608` | 请求体上限 8MB |

同时建议 `php.ini`：

```ini
post_max_size = 8M
max_execution_time = 0
```

## 常见问题

**Q: chat 返回 `503 gateway busy` / `provider_unavailable`**  
A: sidecar 未启动，或 DeepSeek 未登录。先 `manage.ps1 -Action start`，再打开 `/login` 登录。

**Q: `401 invalid api key`**  
A: 客户端 Bearer 与 `API_KEY` 不一致。

**Q: `413 payload too large`**  
A: 调大 `MAX_BODY_BYTES` 与 `php.ini` 的 `post_max_size`（≥ 8M）。

**Q: 找不到 php / node / Chrome**  
A: `manage.ps1 -Action check` 查看探测结果；设置 `PHP_BIN` / `NODE_BIN` / `CHROME_PATH`。

**Q: 改端口**  
A: `manage.ps1 -Action start -GatewayPort xxx -SidecarPort yyy`，并停止旧实例；客户端 `baseURL` 同步改端口。

**Q: 页面改版选择器失效**  
A: 更新 `node/providers.js` 中 `selectors`。

**Q: 想开联网搜索**  
A: 网关每次发送前会强制关闭「联网搜索」（保留「深度思考」）。需要联网时改 `node/bridge.js` 的 `ENSURE_MODES_SCRIPT` 里对 `isSearch` 的分支。

**Q: 回答写一半就“完成”了（截断）**  
A: 完成判定以网页「停止」按钮为准（见上文「完成判定」），文本稳定仅作兜底；若仍遇到，检查 sidecar 日志 `[perf]` 的 `tail` 时长与页面是否改版（停止按钮图标变化）。

**Q: 客户端提示“当前模型不支持图片” / 图片发了但模型说没看到**  
A: 客户端（如 DSH/OpenCode）需要在模型配置里声明图片输入（pi-ai 系写 `input: [text, image]`，DeepSeek 系写 `inputModalities: [text, image]`）；网关侧已支持 `image_url` 多模态并自动上传网页。日志 `chat_start … images=N` 可确认图片是否被提取。

**Q: 流式回复缺字漏字**  
A: 旧版曾在 TCP 粘包时丢块，现已按行缓冲修复；确保使用最新版本（`lib/WebDriver.php` 含“按行缓冲”注释）。

**Q: 回答里的表格 / 加粗变成纯文本了**  
A: 网关读的是 React fiber 的原始 markdown 源码，正常应原样返回；若出现此问题说明页面结构改版，检查 `node/bridge.js` 的 `fiberMarkdown`。

## 安全注意

- 仅在本机或可信网络使用；需要只绑本机时设 `GATEWAY_BIND=127.0.0.1`（或 `BIND_LAN=0`）
- **务必修改默认 `API_KEY`**
- `node/profiles/` 含登录 Cookie，已被 `.gitignore` 排除，勿提交
- 遵守目标网站服务条款与当地法律

## License

Apache License 2.0 — 见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。

**Copyright 2026 deepseek-web-bridge contributors**
