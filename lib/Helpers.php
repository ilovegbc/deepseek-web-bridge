<?php
// JSON / SSE / prompt 提取 / 日志 / 鉴权

function json_error(string $msg): string {
    return json_encode(['error'=>['message'=>$msg]], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}

function http_build_response(int $code, string $body, array $extraHeaders=[]): string {
    $texts = [200=>'OK',201=>'Created',400=>'Bad Request',401=>'Unauthorized',404=>'Not Found',413=>'Payload Too Large',429=>'Too Many Requests',500=>'Internal Server Error',502=>'Bad Gateway',504=>'Gateway Timeout'];
    $text = $texts[$code] ?? 'OK';
    $headers = [
        "HTTP/1.1 $code $text",
        "Content-Type: application/json; charset=utf-8",
        "Content-Length: ".strlen($body),
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Headers: *",
        "Access-Control-Allow-Methods: *",
        "Connection: close",
    ];
    foreach($extraHeaders as $k=>$v) $headers[]="$k: $v";
    return implode("\r\n", $headers)."\r\n\r\n".$body;
}

function sse_chunk(string $id, int $created, string $kind, string $chunk, bool $first, string $model = ''): string {
    $delta = [];
    if ($first) $delta['role']='assistant';
    if ($kind==='thinking') $delta['reasoning_content']=$chunk;
    else $delta['content']=$chunk;
    $obj = [
        'id'=>$id,
        'object'=>'chat.completion.chunk',
        'created'=>$created,
        'model'=>$model !== '' ? $model : DEFAULT_MODEL,
        'choices'=>[['index'=>0,'delta'=>$delta,'finish_reason'=>null]]
    ];
    return json_encode($obj, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}

function sse_tool_chunk(string $id, int $created, array $calls, bool $first, string $model = ''): string {
    $delta=[];
    if ($first) $delta['role']='assistant';
    $delta['content']=null;
    $toolCalls=[];
    foreach($calls as $idx=>$c){
        $toolCalls[]=[
            'id'=>$c['id'],
            'type'=>'function',
            'function'=>['name'=>$c['name'],'arguments'=>$c['arguments']]
        ];
    }
    $delta['tool_calls']=$toolCalls;
    return json_encode([
        'id'=>$id,
        'object'=>'chat.completion.chunk',
        'created'=>$created,
        'model'=>$model !== '' ? $model : DEFAULT_MODEL,
        'choices'=>[['index'=>0,'delta'=>$delta,'finish_reason'=>null]]
    ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}

function sse_done(string $id, int $created, string $finish, string $model = '', ?array $usage = null): string {
    // delta must be {} not []
    $obj = [
        'id'=>$id,
        'object'=>'chat.completion.chunk',
        'created'=>$created,
        'model'=>$model !== '' ? $model : DEFAULT_MODEL,
        'choices'=>[['index'=>0,'delta'=>(object)[],'finish_reason'=>$finish]]
    ];
    if ($usage !== null) $obj['usage'] = $usage;
    return json_encode($obj, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}

function sse_usage(string $id, int $created, array $usage, string $model = ''): string {
    return json_encode([
        'id'=>$id,
        'object'=>'chat.completion.chunk',
        'created'=>$created,
        'model'=>$model !== '' ? $model : DEFAULT_MODEL,
        'choices'=>[],
        'usage'=>$usage,
    ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}

// 粗略 token 估算：CJK/全角字符 ≈ 1 token，其余字符 ≈ 4 字符/token
function estimate_tokens(string $text): int {
    if ($text === '') return 0;
    $cjk = (int)preg_match_all('/[\x{2E80}-\x{9FFF}\x{3000}-\x{303F}\x{FF00}-\x{FFEF}\x{AC00}-\x{D7AF}]/u', $text);
    $chars = function_exists('mb_strlen') ? (int)mb_strlen($text, 'UTF-8') : strlen($text);
    $other = max(0, $chars - $cjk);
    return $cjk + (int)ceil($other / 4);
}

function chat_usage(string $prompt, string $answer, string $thinking = '', int $cached = 0): array {
    $pt = estimate_tokens($prompt);
    $rt = estimate_tokens($thinking);
    $ct = estimate_tokens($answer) + $rt;
    $cached = max(0, min($cached, $pt));
    return [
        'prompt_tokens'=>$pt,
        'completion_tokens'=>$ct,
        'total_tokens'=>$pt + $ct,
        'prompt_tokens_details'=>['cached_tokens'=>$cached],
        'completion_tokens_details'=>['reasoning_tokens'=>$rt],
        'prompt_cache_hit_tokens'=>$cached,
        'prompt_cache_miss_tokens'=>$pt - $cached,
    ];
}

// 前缀缓存估算：除最后一条消息外的历史（含系统提示）视为命中缓存
function cached_prefix_tokens(array $body): int {
    if (!isset($body['messages']) || !is_array($body['messages']) || count($body['messages']) < 2) return 0;
    $msgs = $body['messages'];
    array_pop($msgs);
    return estimate_tokens(extract_prompt(['messages'=>$msgs]));
}

function content_text($content): string {
    if ($content === null) return '';
    if (is_string($content)) return $content;
    if (is_array($content)) {
        $sb = '';
        foreach ($content as $part) {
            if (is_array($part)) {
                if (($part['type'] ?? '') === 'text') $sb .= (string)($part['text'] ?? '');
            } elseif (is_string($part)) {
                $sb .= $part;
            }
        }
        return $sb;
    }
    if ($content instanceof stdClass) {
        $j = json_encode($content, JSON_UNESCAPED_UNICODE);
        return $j === false ? '' : $j;
    }
    return (string)$content;
}

function assistant_tool_calls_text(array $message): string {
    if (!isset($message['tool_calls']) || !is_array($message['tool_calls'])) return '';
    $lines = [];
    foreach ($message['tool_calls'] as $tc) {
        if (!is_array($tc)) continue;
        $fn = $tc['function'] ?? null;
        if (!is_array($fn)) continue;
        $name = (string)($fn['name'] ?? '');
        if ($name === '') continue;
        $args = $fn['arguments'] ?? null;
        if ($args === null) $args = '{}';
        elseif (!is_string($args)) {
            $enc = json_encode($args, JSON_UNESCAPED_UNICODE);
            $args = $enc === false ? '{}' : $enc;
        }
        $id = (string)($tc['id'] ?? 'unknown');
        $lines[] = "助手请求调用工具（name={$name}, id={$id}）：{$args}";
    }
    return implode("\n", $lines);
}

function extract_prompt(array $body): string {
    if (isset($body['prompt']) && is_string($body['prompt'])) return trim($body['prompt']);
    if (!isset($body['messages']) || !is_array($body['messages'])) return '';
    $parts = [];
    foreach ($body['messages'] as $m) {
        if (!is_array($m)) continue;
        $role = (string)($m['role'] ?? '');
        $text = content_text($m['content'] ?? null);
        $line = '';
        if ($role === 'system') {
            if ($text !== '') $line = "[系统]\n" . $text;
        } elseif ($role === 'developer') {
            if ($text !== '') $line = "[开发者]\n" . $text;
        } elseif ($role === 'tool') {
            $name = (string)($m['name'] ?? 'unknown');
            $id = (string)($m['tool_call_id'] ?? 'unknown');
            $line = "工具返回（name={$name}, id={$id}）：\n" . $text;
        } elseif ($role === 'assistant') {
            $tc = assistant_tool_calls_text($m);
            $seg = [];
            if ($text !== '') $seg[] = "助手：" . $text;
            if ($tc !== '') $seg[] = $tc;
            $line = implode("\n", $seg);
        } else {
            if ($text !== '') $line = "用户：" . $text;
        }
        if ($line !== '') $parts[] = $line;
    }
    return implode("\n\n", $parts);
}

function download_image_data_url(string $url): ?string {
    if (str_starts_with($url, 'data:image/')) return $url;
    if (!preg_match('#^https?://#i', $url)) return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ]);
    $body = curl_exec($ch);
    $type = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200 || !is_string($body) || $body === '' || strlen($body) > 5 * 1024 * 1024) return null;
    if ($type === '' || !str_starts_with($type, 'image/')) return null;
    return 'data:' . explode(';', $type)[0] . ';base64,' . base64_encode($body);
}

// 提取 OpenAI 多模态消息里的图片（data URL 或 http(s) 链接），最多 4 张
function extract_images(array $body): array {
    $out = [];
    if (!isset($body['messages']) || !is_array($body['messages'])) return $out;
    foreach ($body['messages'] as $m) {
        if (!is_array($m)) continue;
        $c = $m['content'] ?? null;
        if (!is_array($c)) continue;
        foreach ($c as $part) {
            if (!is_array($part) || ($part['type'] ?? '') !== 'image_url') continue;
            $u = $part['image_url'] ?? '';
            if (is_array($u)) $u = $u['url'] ?? '';
            if (!is_string($u) || $u === '') continue;
            if (str_starts_with($u, 'data:image/')) {
                if (strlen($u) > 6 * 1024 * 1024) continue;
                $url = $u;
            } else {
                $url = download_image_data_url($u);
                if ($url === null) continue;
            }
            $out[] = ['url' => $url];
            if (count($out) >= 4) return $out;
        }
    }
    return $out;
}

function provider_request_error(string $providerId, array $body): ?string {
    $supportsTools = ($providerId === 'deepseek');
    if (!$supportsTools && isset($body['tools']) && is_array($body['tools']) && count($body['tools'])>0){
        return "custom tool calls are not supported by $providerId web";
    }
    return null;
}

function log_line(string $tag, string $msg){
    if (!ENABLE_LOG) return;
    $line=date('Y-m-d H:i:s')." [$tag] $msg\n";
    @file_put_contents(LOG_FILE,$line,FILE_APPEND);
}

function get_bearer_token(): ?string {
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!$auth && function_exists('apache_request_headers')){
        $h=apache_request_headers();
        $auth=$h['Authorization'] ?? $h['authorization'] ?? '';
    }
    if (preg_match('/Bearer\s+(.+)/i',$auth,$m)) return trim($m[1]);
    return null;
}

function cors_preflight(): void {
    header("Access-Control-Allow-Origin: *");
    header("Access-Control-Allow-Headers: Authorization, Content-Type, *");
    header("Access-Control-Allow-Methods: GET, POST, OPTIONS, PUT, DELETE, PATCH");
    header("Content-Length: 0");
    http_response_code(200);
    exit;
}
