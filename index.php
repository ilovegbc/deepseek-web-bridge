<?php
/**
 * deepseek-web-bridge — OpenAI 兼容本地网关
 *
 * 客户端 -> PHP (鉴权/路由/SSE/工具调用) -> Playwright sidecar -> DeepSeek 网页会话
 *
 * 端点:
 *   GET  /health
 *   GET  /login
 *   POST /login/open
 *   GET  /login/status
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *
 * 启动: .\scripts\manage.ps1 -Action start
 */

require __DIR__.'/config.php';
require __DIR__.'/lib/Helpers.php';
require __DIR__.'/lib/ToolCalling.php';
require __DIR__.'/lib/WebDriver.php';

if (($_SERVER['REQUEST_METHOD'] ?? '')==='OPTIONS') cors_preflight();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?? '/';
$path = rtrim($path,'/') ?: '/';

$rawBody = file_get_contents('php://input') ?: '';
if (strlen($rawBody) > MAX_BODY_BYTES) {
    log_line("Router","$method $path body=".strlen($rawBody)." REJECT_413 ip=".($_SERVER['REMOTE_ADDR']??''));
    header("HTTP/1.1 413 Payload Too Large");
    header("Content-Type: application/json");
    echo json_error("payload too large");
    exit;
}
if (count((function_exists('getallheaders')?getallheaders():[])) > MAX_HEADERS_COUNT) {
    header("HTTP/1.1 431 Request Header Fields Too Large");
    header("Content-Type: application/json");
    echo json_error("too many headers");
    exit;
}

log_line("Router","$method $path body=".strlen($rawBody)." ip=".($_SERVER['REMOTE_ADDR']??''));

if ($method==='GET' && ($path==='__tunnel_probe' || $path==='/_tunnel_probe')) {
    header("Content-Type: application/json");
    header("Access-Control-Allow-Origin: *");
    echo '{"probe":"392125113473d61e8aaba950e010d41453ceb63597a7b047"}';
    exit;
}

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: *");
header("Access-Control-Allow-Methods: *");

if ($path==='/health' || $path==='/_tunnel_probe' || $path==='/__tunnel_probe'
    || $path==='/' || $path==='/index.php'
    || $path==='/login' || $path==='/login.php' || $path==='/login/status'
    || $path==='/login/open') {
    // public routes
} else {
    if (API_KEY !== '') {
        $token = get_bearer_token();
        if ($token !== API_KEY) {
            header("HTTP/1.1 401 Unauthorized");
            header("Content-Type: application/json");
            echo json_error("invalid api key");
            exit;
        }
    }
}

if ($method==='GET' && ($path==='/health' || $path==='/api/health')) {
    header("Content-Type: application/json");
    echo '{"ok":true}';
    exit;
}

if ($method==='GET' && ($path==='/login' || $path==='/login.php')) {
    header("Content-Type: text/html; charset=utf-8");
    $status = sidecar_login_status();
    $all = $status['ok'] && is_array($status['data']) ? $status['data'] : [];
    $gwBase = 'http://127.0.0.1:' . LISTEN_PORT . '/v1';
    $pid = 'deepseek';
    $st = $all[$pid] ?? null;
    $home = $UPSTREAM_MAP[$pid]['url'] ?? '';
    $model = $UPSTREAM_MAP[$pid]['model'] ?? '';
    $loggedIn = !empty($st['loggedIn']);
    $running = !empty($st['running']);
    $badge = $loggedIn ? '<span class="ok">已登录</span>'
          : ($running ? '<span class="warn">未登录</span>' : '<span class="muted">未启动</span>');
    $rows = '<tr><td><strong>'.$pid.'</strong></td><td><a href="'.htmlspecialchars($home).'" target="_blank">'.htmlspecialchars($home).'</a></td><td><code>'.$model.'</code></td><td>'.$badge.'</td>'
          .'<td><button class="btn" onclick="openLogin(\''.$pid.'\')">打开登录窗口</button></td></tr>';
    $opc = json_encode([
        'provider' => [
            'deepseek-web-bridge' => [
                'name' => 'DeepSeek Web Bridge',
                'npm' => '@ai-sdk/openai-compatible',
                'options' => ['baseURL' => $gwBase, 'apiKey' => API_KEY],
                'models' => [
                    'deepseek-chat' => ['name' => 'DeepSeek'],
                ],
            ],
        ],
    ], JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES);
    $k = htmlspecialchars(API_KEY);
    $curlSample = 'curl '.$gwBase.'/models -H "Authorization: Bearer '.$k.'"'."\n"
      .'curl '.$gwBase.'/chat/completions \\'."\n"
      .'  -H "Authorization: Bearer '.$k.'" \\'."\n"
      .'  -H "Content-Type: application/json" \\'."\n"
      .'  -d \'{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}\'';
    echo '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      .'<title>deepseek-web-bridge — 登录与接入</title>'
      .'<style>
      :root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--fg:#e8eaed;--mut:#9aa0a6;--acc:#4c8dff;--ok:#3ddc84;--warn:#ffb020}
      *{box-sizing:border-box}
      body{margin:0;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
      .wrap{max-width:1040px;margin:0 auto;padding:28px 18px 48px}
      h1{font-size:1.45rem;margin:0 0 6px}
      .sub{color:var(--mut);margin:0 0 22px;font-size:.95rem}
      .grid{display:grid;gap:16px;grid-template-columns:1fr 1fr}
      @media(max-width:760px){.grid{grid-template-columns:1fr}}
      .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0}
      .card h2{font-size:1rem;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
      .full{grid-column:1/-1}
      .label{color:var(--mut);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;margin:12px 0 4px}
      code,kbd{font-family:ui-monospace,Consolas,monospace;font-size:.9rem}
      code{background:#0c0e12;border:1px solid var(--line);padding:.15rem .4rem;border-radius:6px;word-break:break-all}
      .big{display:block;font-size:1.05rem;padding:.55rem .7rem;background:#0c0e12;border:1px solid var(--acc);border-radius:8px;color:#cfe0ff;word-break:break-all}
      .hint{color:var(--mut);font-size:.85rem;margin:6px 0 0}
      .ports{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
      .chip{border:1px solid var(--line);border-radius:999px;padding:.25rem .7rem;font-size:.85rem;color:var(--mut)}
      .chip b{color:var(--fg);font-weight:600}
      .chip.api{border-color:var(--acc);color:#cfe0ff}
      .tablewrap{overflow-x:auto;margin-top:8px}
      table{border-collapse:collapse;width:100%;font-size:.92rem;min-width:640px}
      th,td{border-bottom:1px solid var(--line);padding:.55rem .5rem;text-align:left;vertical-align:middle}
      th{color:var(--mut);font-weight:600;font-size:.8rem;white-space:nowrap}
      td a{word-break:break-all}
      .ok{color:var(--ok);font-weight:600;white-space:nowrap}
      .warn{color:var(--warn);font-weight:600;white-space:nowrap}
      .muted{color:var(--mut);white-space:nowrap}
      .btn{cursor:pointer;padding:.4rem .8rem;border-radius:8px;border:1px solid var(--line);background:#1e2430;color:var(--fg);white-space:nowrap}
      .btn:hover{border-color:var(--acc)}
      a{color:var(--acc)}
      pre{background:#0c0e12;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:.82rem;margin:8px 0 0;white-space:pre-wrap;word-break:break-word}
      .prehead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
      .prehead .label{margin:0}
      .copy{font-size:.75rem;padding:.2rem .5rem;flex-shrink:0}
      .warnbox{background:#2a2110;border:1px solid #6b4e12;color:#ffd68a;border-radius:8px;padding:10px 12px;font-size:.9rem;margin-top:10px}
      </style></head><body><div class="wrap">'
      .'<h1>deepseek-web-bridge — 登录与接入</h1>'
      .'<p class="sub">先完成 DeepSeek 网页登录，再把客户端 baseURL 指到 <strong>网关端口</strong>（默认 8080，不是 sidecar 8090）。仅供学习交流。</p>'
      .'<div class="grid">'
      .'<div class="card full"><h2>客户端接入（OpenCode / 任意 OpenAI 兼容客户端）</h2>'
        .'<div class="label">baseURL — 必须用这个</div>'
        .'<code class="big" id="baseurl">'.$gwBase.'</code>'
        .'<p class="hint">请求会变成 <code>'.$gwBase.'/models</code>、<code>'.$gwBase.'/chat/completions</code>。'
        .'若写成 sidecar 端口会返回 not found。</p>'
        .'<div class="label">API Key（Authorization: Bearer）</div>'
        .'<code class="big" id="apikey">'.htmlspecialchars(API_KEY).'</code>'
        .'<p class="hint">与 config.php 的 API_KEY 全等，否则 401。上线前请修改 API_KEY。</p>'
        .'<div class="ports">'
          .'<span class="chip api"><b>'.LISTEN_PORT.'</b> = OpenAI API 网关（客户端用这个）</span>'
          .'<span class="chip"><b>'.SIDECAR_PORT.'</b> = Playwright Sidecar（仅 PHP 内部调用）</span>'
        .'</div>'
        .'<div class="prehead"><div class="label">OpenCode 配置片段（opencode.jsonc）</div>'
        .'<button class="btn copy" onclick="navigator.clipboard.writeText(document.getElementById(\'opc\').textContent);this.textContent=\'已复制\'">复制</button></div>'
        .'<pre id="opc">'.htmlspecialchars($opc).'</pre>'
      .'</div>'
      .'<div class="card full"><h2>网页账号登录</h2>'
        .'<p class="hint">点「打开登录窗口」会弹出本机浏览器加载 homeUrl；登录成功后自动保存 storageState。未登录时 chat 返回 503 provider_unavailable。</p>'
        .'<p class="hint">Sidecar 状态: <code>'.SIDECAR_URL.'</code> — <span id="sc">'.($status['ok']?'在线':'离线 (先运行 scripts\\manage.ps1 -Action start)').'</span> '
        .'· 状态接口 <code>GET /login/status</code></p>'
        .'<div class="tablewrap"><table><tr><th>Provider</th><th>homeUrl</th><th>model</th><th>状态</th><th>操作</th></tr>'.$rows.'</table></div>'
        .'<div class="warnbox" id="loginMsg" style="display:none"></div>'
      .'</div>'
      .'<div class="card"><h2>可用模型（已登录）</h2><ul>'
        .'<li><code>deepseek-chat</code> — DeepSeek（图片 / 推理 / 工具 / 大上下文）</li>'
      .'</ul><p class="hint">列表接口: <code>GET '.$gwBase.'/models</code></p></div>'
      .'<div class="card"><h2>快速自检</h2><pre>'.$curlSample.'</pre>'
        .'<p class="hint">调试页: <a href="/test.html">/test.html</a> · 网关信息: <a href="/">/</a></p></div>'
      .'</div></div>'
      .'<script>async function openLogin(p){const msg=document.getElementById("loginMsg");msg.style.display="block";msg.textContent="正在打开 "+p+" 登录窗口...";try{const r=await fetch("/login/open",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:p})});const j=await r.json();msg.textContent=p+": "+JSON.stringify(j);setTimeout(()=>location.reload(),1500);}catch(e){msg.textContent=p+" 打开失败: "+e;}}'
      .'setInterval(async()=>{try{const r=await fetch("/login/status");const j=await r.json();document.getElementById("sc").textContent=(j&&Object.keys(j).length)?"在线":"离线";}catch(e){document.getElementById("sc").textContent="离线";}},3000);</script>'
      .'</body></html>';
    exit;
}
if ($method==='POST' && $path==='/login/open') {
    header("Content-Type: application/json");
    $body = json_decode($rawBody, true) ?: [];
    $pid = $body['provider'] ?? 'deepseek';
    $r = sidecar_open_login($pid);
    http_response_code($r['ok'] ? 200 : 502);
    echo json_encode($r['ok'] ? ($r['data'] ?: ['ok'=>true]) : ['error'=>['message'=>$r['error'] ?: 'sidecar open failed']], JSON_UNESCAPED_UNICODE);
    exit;
}
if ($method==='GET' && $path==='/login/status') {
    header("Content-Type: application/json");
    $pid = $_GET['provider'] ?? null;
    $r = sidecar_login_status($pid);
    http_response_code($r['ok'] ? 200 : 502);
    echo json_encode($r['ok'] ? ($r['data'] ?: []) : ['error'=>['message'=>$r['error'] ?: 'sidecar status failed']], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($method==='GET' && ($path==='/v1/models' || $path==='/models')) {
    header("Content-Type: application/json");
    $st = sidecar_login_status();
    $statusMap = ($st['ok'] && is_array($st['data'])) ? $st['data'] : [];
    $online = !empty($statusMap['deepseek']['loggedIn']);
    $meta = [
        'id'=>'deepseek-chat', 'owned_by'=>'deepseek', 'provider'=>'deepseek',
        'description'=>'DeepSeek Chat (web reverse-proxy). 支持图片输入、深度思考/推理、工具调用。',
        'context_window'=>1000000, 'max_output_tokens'=>65536,
        'vision'=>true, 'reasoning'=>true, 'tools'=>true,
    ];
    $models = [];
    if ($online) {
        $models[] = [
            'id'=>$meta['id'],
            'object'=>'model',
            'created'=>time(),
            'owned_by'=>$meta['owned_by'],
            'description'=>$meta['description'],
            'provider'=>$meta['provider'],
            'context_window'=>$meta['context_window'],
            'max_context_length'=>$meta['context_window'],
            'max_tokens'=>$meta['max_output_tokens'],
            'max_output_tokens'=>$meta['max_output_tokens'],
            'modalities'=>['input'=>['text','image'],'output'=>['text']],
            'input_modalities'=>['text','image'],
            'output_modalities'=>['text'],
            'capabilities'=>[
                'vision'=>true,'image'=>true,'reasoning'=>true,'thinking'=>true,
                'function_calling'=>true,'tool_call'=>true,'tools'=>true,'stream'=>true,
            ],
            'supports'=>[
                'vision'=>true,'reasoning'=>true,'tools'=>true,'stream'=>true,
            ],
            'supported_parameters'=>['messages','model','stream','temperature','top_p','max_tokens','tools','tool_choice','stop','presence_penalty','frequency_penalty'],
            'available'=>true,
        ];
    } else {
        $models[] = [
            'id'=>$meta['id'], 'object'=>'model', 'created'=>time(),
            'owned_by'=>$meta['owned_by'], 'description'=>$meta['description'],
            'context_window'=>$meta['context_window'], 'max_context_length'=>$meta['context_window'],
            'max_tokens'=>$meta['max_output_tokens'],
            'modalities'=>['input'=>['text','image'],'output'=>['text']],
            'capabilities'=>[
                'vision'=>true,'image'=>true,'reasoning'=>true,'thinking'=>true,
                'function_calling'=>true,'tool_call'=>true,'tools'=>true,'stream'=>true,
            ],
            'available'=>false,
        ];
    }
    echo json_encode(['object'=>'list','data'=>$models,'available'=>$online?['deepseek-chat']:[]], JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE);
    exit;
}

if ($method==='GET' && ($path==='/' || $path==='/index.php')) {
    header("Content-Type: application/json");
    echo json_encode([
        'name'=>'deepseek-web-bridge',
        'version'=>'1.0.0',
        'license'=>'Apache-2.0',
        'port'=>LISTEN_PORT,
        'bind'=>BIND_LAN?'0.0.0.0':'127.0.0.1',
        'model'=>DEFAULT_MODEL,
        'endpoints'=>[
            'GET /health',
            'GET /login (网页登录页)',
            'POST /login/open {provider} (打开有头登录窗口)',
            'GET /login/status[?provider=] (登录状态)',
            'GET /v1/models',
            'POST /v1/chat/completions (stream / non-stream, tools)',
        ],
        'provider'=>'https://chat.deepseek.com',
        'sidecar'=>SIDECAR_URL,
        'note'=>'先运行 .\\scripts\\manage.ps1 -Action start；访问 /login 完成 DeepSeek 网页登录',
        'disclaimer'=>'仅供学习交流使用，使用者自行承担风险'
    ], JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT);
    exit;
}

if ($path==='/v1/chat/completions' || $path==='/chat/completions' || $path==='/v1/completions') {
    if (function_exists('set_time_limit')) { @set_time_limit(0); }
    if (function_exists('ignore_user_abort')) { @ignore_user_abort(true); }
    if ($method !== 'POST') {
        header("HTTP/1.1 405 Method Not Allowed");
        header("Allow: POST");
        header("Content-Type: application/json");
        echo json_error("method not allowed; use POST");
        exit;
    }
    $body = json_decode($rawBody, true);
    if (json_last_error()!==JSON_ERROR_NONE) {
        header("HTTP/1.1 400 Bad Request");
        header("Content-Type: application/json");
        echo json_error("invalid JSON body");
        exit;
    }

    $modelReq = (string)($body['model'] ?? DEFAULT_MODEL);
    if ($modelReq === '') $modelReq = DEFAULT_MODEL;
    $providerId = model_to_provider($modelReq);
    global $UPSTREAM_MAP;
    $upstream = $UPSTREAM_MAP[$providerId] ?? null;
    if ($providerId === 'default' || $upstream === null || empty($upstream['url'])) {
        header("HTTP/1.1 400 Bad Request");
        header("Content-Type: application/json");
        echo json_encode([
            'error' => [
                'message' => "The model `{$modelReq}` does not exist. Available: deepseek-chat",
                'type' => 'invalid_request_error',
                'param' => 'model',
                'code' => 'model_not_found',
            ]
        ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        exit;
    }

    $loginSt = sidecar_login_status($providerId);
    $isLoggedIn = !empty($loginSt['ok']) && !empty($loginSt['data']['loggedIn']);
    if (!$isLoggedIn) {
        header("HTTP/1.1 503 Service Unavailable");
        header("Content-Type: application/json");
        echo json_encode([
            'error' => [
                'message' => "gateway busy: model `{$modelReq}` unavailable; open /login and sign in DeepSeek",
                'type' => 'server_error',
                'code' => 'provider_unavailable',
                'provider' => $providerId,
            ]
        ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        exit;
    }
    if (!empty($body['upstream_url'])) $upstream['url']=$body['upstream_url'];

    $err = provider_request_error($providerId, $body);
    if ($err) {
        header("HTTP/1.1 400 Bad Request");
        header("Content-Type: application/json");
        echo json_error($err);
        exit;
    }

    $prompt = extract_prompt($body);
    if ($prompt==='') {
        header("HTTP/1.1 400 Bad Request");
        header("Content-Type: application/json");
        echo json_error("no message content");
        exit;
    }

    $plan = ToolCalling::createPlan($body, $prompt);
    if ($plan['error']) {
        header("HTTP/1.1 400 Bad Request");
        header("Content-Type: application/json");
        echo json_error($plan['error']);
        exit;
    }

    $isStream = !empty($body['stream']);
    $traceId = substr(base_convert((string)hrtime(true),10,36),-8);
    log_line("Gateway","chat_start id=$traceId stream=".($isStream?'true':'false')." model=$modelReq provider=$providerId promptChars=".strlen($prompt)." tools=".count($plan['tools']));

    if (!$isStream) {
        $result = webdriver_chat($providerId, $plan['prompt'], false, $traceId);
        if (empty($result['ok'])) {
            $msg = $result['error'] ?? 'gateway busy';
            $code = ($result['code'] ?? 0) === 429 ? 429 : 503;
            if (($result['code'] ?? 0) === 504) $code = 504;
            header("HTTP/1.1 $code ".($code===429?'Too Many Requests':($code===504?'Gateway Timeout':'Service Unavailable')));
            header("Content-Type: application/json");
            echo json_error($msg);
            exit;
        }
        $answerText = $result['answer'];
        $thinkingText = $result['thinking'];
        $toolOut = ToolCalling::parse($answerText, $plan);
        if (!empty($toolOut['attemptedToolCall']) && empty($toolOut['calls'])) {
            header("HTTP/1.1 502 Bad Gateway");
            header("Content-Type: application/json");
            echo json_error("model produced an invalid tool call");
            exit;
        }
        if (!empty($plan['required']) && empty($toolOut['calls'])) {
            header("HTTP/1.1 502 Bad Gateway");
            header("Content-Type: application/json");
            echo json_error("model did not produce a valid required tool call");
            exit;
        }
        if (empty($toolOut['calls']) && $toolOut['content']==='') {
            header("HTTP/1.1 502 Bad Gateway");
            header("Content-Type: application/json");
            echo json_error("no reply");
            exit;
        }
        $msg = ['role'=>'assistant'];
        if (empty($toolOut['calls'])) {
            $msg['content'] = $toolOut['content'];
            $finish = 'stop';
        } else {
            $msg['content'] = null;
            $msg['tool_calls'] = array_map(function($c){
                return ['id'=>$c['id'],'type'=>'function','function'=>['name'=>$c['name'],'arguments'=>$c['arguments']]];
            }, $toolOut['calls']);
            $finish = 'tool_calls';
        }
        if ($thinkingText !== '' && $thinkingText !== null) $msg['reasoning_content'] = $thinkingText;
        $resp = [
            'id'=>'chatcmpl-'.time(),
            'object'=>'chat.completion',
            'created'=>time(),
            'model'=>$modelReq,
            'choices'=>[['index'=>0,'message'=>$msg,'finish_reason'=>$finish]],
        ];
        log_line("Gateway","chat_done id=$traceId stream=false answerChars=".strlen($answerText));
        header("Content-Type: application/json");
        echo json_encode($resp, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        exit;
    }

    $health = sidecar_health();
    if (!$health['ok']) {
        header("HTTP/1.1 503 Service Unavailable");
        header("Content-Type: application/json");
        echo json_error("gateway busy");
        exit;
    }

    header("Content-Type: text/event-stream; charset=utf-8");
    header("Cache-Control: no-cache, no-transform");
    header("X-Accel-Buffering: no");
    header("Access-Control-Allow-Origin: *");
    header("Connection: close");
    if (function_exists('ob_implicit_flush')) { ob_implicit_flush(true); }

    $id = 'chatcmpl-'.time();
    $created = time();
    $answerBuf = '';
    $thinkingBuf = '';
    $toolBuf = '';
    $toolMode = $plan['enabled'] ? ToolCalling::streamMode('', !empty($plan['required'])) : 'CONTENT';

    $emit = function(string $data) {
        echo "data: $data\n\n";
        if (function_exists('flush')) flush();
    };

    $emit(sse_chunk($id, $created, 'answer', '', true, $modelReq));

    $onChunk = function(string $kind, string $chunk) use (&$answerBuf, &$thinkingBuf, &$toolMode, &$toolBuf, &$plan, $emit, $id, $created, $modelReq) {
        if ($kind === 'thinking') {
            $thinkingBuf .= $chunk;
            $emit(sse_chunk($id, $created, 'thinking', $chunk, false, $modelReq));
            return;
        }
        if (!$plan['enabled']) {
            $answerBuf .= $chunk;
            $emit(sse_chunk($id, $created, 'answer', $chunk, false, $modelReq));
            return;
        }
        if ($toolMode === 'WAIT') {
            $toolBuf .= $chunk;
            $toolMode = ToolCalling::streamMode($toolBuf, !empty($plan['required']));
            if ($toolMode === 'CONTENT') {
                $answerBuf .= $toolBuf;
                $emit(sse_chunk($id, $created, 'answer', $toolBuf, false, $modelReq));
                $toolBuf = '';
            }
            return;
        }
        if ($toolMode === 'TOOL') {
            $answerBuf .= $chunk;
            return;
        }
        $answerBuf .= $chunk;
        $emit(sse_chunk($id, $created, 'answer', $chunk, false, $modelReq));
    };

    $streamResult = webdriver_chat($providerId, $plan['prompt'], true, $traceId, $onChunk);

    if (empty($streamResult['ok'])) {
        $emit(json_error($streamResult['error'] ?? 'gateway busy'));
        echo "data: [DONE]\n\n";
        if (function_exists('flush')) flush();
        log_line("Gateway","chat_failed id=$traceId reason=".($streamResult['error']??'stream'));
        exit;
    }

    $finalAnswer = $streamResult['answer'] !== '' ? $streamResult['answer'] : $answerBuf;
    $toolOut = ToolCalling::parse($finalAnswer, $plan);
    if ($plan['enabled']) {
        if (!empty($toolOut['attemptedToolCall']) && empty($toolOut['calls'])) {
            $emit(json_error("model produced an invalid tool call"));
            echo "data: [DONE]\n\n"; exit;
        }
        if (!empty($plan['required']) && empty($toolOut['calls'])) {
            $emit(json_error("model did not produce a valid required tool call"));
            echo "data: [DONE]\n\n"; exit;
        }
    }

    if (!empty($toolOut['calls'])) {
        $emit(sse_tool_chunk($id, $created, $toolOut['calls'], false, $modelReq));
        $finish = 'tool_calls';
    } else {
        if ($plan['enabled'] && ($toolMode === 'WAIT' || $toolMode === 'TOOL') && $finalAnswer !== '' && $answerBuf === '') {
            $emit(sse_chunk($id, $created, 'answer', $finalAnswer, false, $modelReq));
        }
        $finish = 'stop';
    }
    $emit(sse_done($id, $created, $finish, $modelReq));
    echo "data: [DONE]\n\n";
    if (function_exists('flush')) flush();
    log_line("Gateway","chat_done id=$traceId stream=true answerChars=".strlen($finalAnswer));
    exit;
}

header("HTTP/1.1 404 Not Found");
header("Content-Type: application/json");
echo json_encode([
    'error' => [
        'message' => "not found: {$method} {$path}",
        'type' => 'invalid_request_error',
        'code' => 'not_found',
        'hint' => 'Use GET /v1/models and POST /v1/chat/completions',
    ]
], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
