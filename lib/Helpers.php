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

function sse_done(string $id, int $created, string $finish, string $model = ''): string {
    // delta must be {} not []
    return json_encode([
        'id'=>$id,
        'object'=>'chat.completion.chunk',
        'created'=>$created,
        'model'=>$model !== '' ? $model : DEFAULT_MODEL,
        'choices'=>[['index'=>0,'delta'=>(object)[],'finish_reason'=>$finish]]
    ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
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
