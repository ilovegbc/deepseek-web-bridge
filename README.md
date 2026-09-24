# deepseek-web-bridge

OpenAI 兼容的本地网关：用 **PHP** 做接入层，用 **Playwright sidecar** 驱动 DeepSeek 网页会话，让任意 OpenAI SDK / 客户端（OpenCode、Continue、LobeChat 等）直接对话。

> 仅支持 **DeepSeek**（`deepseek-chat`）。

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
    │  单并发队列 · 登录态 · 页面自动化
    ▼
https://chat.deepseek.com/  (真实网页会话)
```

### 无状态会话策略

1. `extract_prompt` 把请求里**全部** `messages` 拼成完整上下文  
2. **发送前** `freshChat` 开启新对话 → 注入全量 prompt（每次请求独立会话）  
3. 轮询等待 answer 稳定后返回  
4. **输出完成后** 再次 `freshChat`，为下次请求准备空白会话  
5. 上下文压缩 / 整理类请求走同一路径，无需特殊分支  

对客户端完全无状态：任意 OpenAI 兼容客户端每次带上完整历史即可。

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

自定义端口时，**`GATEWAY_PORT` / `SIDECAR_PORT` 必须一致**传给 PHP 进程与 sidecar；`manage.ps1 -Action start` 会自动写入状态并导出环境变量，改端口请**停止后重新启动**。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/login` | 网页登录页 |
| POST | `/login/open` | 打开有头浏览器登录窗口 `{"provider":"deepseek"}` |
| GET | `/login/status` | 登录状态 JSON |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI 兼容 chat（stream / non-stream / tools） |

鉴权：除 health / login 相关路径外，需 `Authorization: Bearer <API_KEY>`，与 `config.php` 中 `API_KEY` 全等。

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
│   ├── sidecar.js         # HTTP sidecar：/login /chat /health
│   ├── providers.js       # DeepSeek 选择器与自动化配置
│   ├── bridge.js          # 页面状态读取 / send / freshChat
│   ├── webdriver.js       # chat 状态机
│   └── profiles/          # 登录 storageState（已 gitignore）
├── scripts/
│   └── manage.ps1         # 唯一管理脚本：检测/依赖/启动/停止菜单
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

## 安全注意

- 仅在本机或可信网络使用；需要只绑本机时设 `GATEWAY_BIND=127.0.0.1`（或 `BIND_LAN=0`）
- **务必修改默认 `API_KEY`**
- `node/profiles/` 含登录 Cookie，已被 `.gitignore` 排除，勿提交
- 遵守目标网站服务条款与当地法律

## License

Apache License 2.0 — 见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。

**Copyright 2026 deepseek-web-bridge contributors**
