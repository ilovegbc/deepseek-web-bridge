<?php
/**
 * deepseek-web-bridge 配置
 * 本地 OpenAI 兼容网关：PHP 接入层 + Playwright sidecar 驱动 DeepSeek 网页会话
 *
 * 端口可用环境变量覆盖（与 scripts/manage.ps1 一键启动一致）：
 *   GATEWAY_PORT  网关端口，默认 8080
 *   SIDECAR_PORT  sidecar 端口，默认 8090
 *   BIND_LAN      1=0.0.0.0 / 0=127.0.0.1，默认 1
 */

define('BIND_LAN', (bool)(getenv('BIND_LAN') !== false && getenv('BIND_LAN') !== '' ? (int)getenv('BIND_LAN') : 1));
define('LISTEN_PORT', (int)(getenv('GATEWAY_PORT') ?: 8080));
define('SIDECAR_PORT', (int)(getenv('SIDECAR_PORT') ?: 8090));

// API 鉴权 Key（空字符串表示不校验）— 上线前务必修改
define('API_KEY', getenv('API_KEY') !== false && getenv('API_KEY') !== '' ? (string)getenv('API_KEY') : 'sk-test-local-proxy-key');

define('DEFAULT_MODEL', 'deepseek-chat');

$UPSTREAM_MAP = [
    'deepseek' => [
        'url' => 'https://chat.deepseek.com/',
        'model' => 'deepseek-chat',
    ],
    'default' => [
        'url' => '',
        'model' => DEFAULT_MODEL,
    ],
];

define('MAX_BODY_BYTES', 8388608);
define('MAX_HEADERS_COUNT', 64);
define('MAX_LINE_BYTES', 8192);
define('SO_TIMEOUT_MS', 60000);
define('CHAT_TIMEOUT_SEC', (int)(getenv('CHAT_TIMEOUT_SEC') ?: 120));
define('CONTROLLER_TIMEOUT_SEC', 200);
define('SSE_HEARTBEAT_MS', 2000);

define('SIDECAR_URL', 'http://127.0.0.1:' . SIDECAR_PORT);
define('SIDECAR_TIMEOUT_SEC', max(CHAT_TIMEOUT_SEC + 10, 130));

define('ENABLE_LOG', true);
define('LOG_FILE', __DIR__ . '/gateway.log');
