<?php
// Playwright sidecar HTTP 客户端

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/Helpers.php';

function sidecar_request(string $path, ?array $post = null, int $timeoutSec = 30) {
    $url = SIDECAR_URL . $path;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeoutSec,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'],
    ]);
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($post, JSON_UNESCAPED_UNICODE));
    }
    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($body === false) {
        return ['ok' => false, 'code' => 0, 'error' => $err ?: 'sidecar unreachable', 'data' => null];
    }
    $data = json_decode($body, true);
    return ['ok' => $code >= 200 && $code < 300, 'code' => $code, 'error' => null, 'data' => $data];
}

function sidecar_open_login(string $provider): array {
    return sidecar_request('/login', ['provider' => $provider], 65);
}

function sidecar_login_status(?string $provider = null): array {
    $path = '/login/status' . ($provider ? '?provider=' . rawurlencode($provider) : '');
    return sidecar_request($path, null, 10);
}

function sidecar_health(): array {
    return sidecar_request('/health', null, 3);
}

function webdriver_chat(string $providerId, string $prompt, bool $stream, string $traceId, ?callable $onChunk = null): array {
    if (function_exists('set_time_limit')) { @set_time_limit(0); }
    if (function_exists('ignore_user_abort')) { @ignore_user_abort(true); }
    $post = [
        'provider' => $providerId,
        'prompt' => $prompt,
        'stream' => $stream,
        'timeoutSec' => CHAT_TIMEOUT_SEC,
        'traceId' => $traceId,
    ];
    $url = SIDECAR_URL . '/chat';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => !$stream,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($post, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/x-ndjson, application/json'],
        CURLOPT_TIMEOUT => SIDECAR_TIMEOUT_SEC,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
    ]);

if ($stream) {
        // WRITEFUNCTION must return byte count
        $final = ['thinking' => '', 'answer' => ''];
        $responseFn = function ($ch, $data) use ($onChunk, &$final) {
            $len = strlen($data);
            $line = trim($data);
            if ($line === '') return $len;
            $obj = json_decode($line, true);
            if (!is_array($obj)) return $len;
            $t = $obj['type'] ?? '';
            if ($t === 'chunk' && $onChunk) {
                $onChunk($obj['kind'] ?? 'answer', $obj['chunk'] ?? '');
                if (($obj['kind'] ?? '') === 'answer') $final['answer'] .= $obj['chunk'] ?? '';
                if (($obj['kind'] ?? '') === 'thinking') $final['thinking'] .= $obj['chunk'] ?? '';
            } elseif ($t === 'done') {
                $final['thinking'] = (string)($obj['thinking'] ?? $final['thinking']);
                $final['answer'] = (string)($obj['answer'] ?? $final['answer']);
            } elseif ($t === 'error') {
                $final['error'] = (string)($obj['message'] ?? 'stream error');
            }
            return $len;
        };
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, $responseFn);
        $ok = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($ok === false) {
            return ['ok' => false, 'thinking' => '', 'answer' => '', 'error' => $err ?: 'sidecar stream failed'];
        }
        if ($code < 200 || $code >= 300) {
            return ['ok' => false, 'thinking' => '', 'answer' => '', 'error' => $final['error'] ?? ('sidecar http '.$code), 'code' => $code];
        }
        if (!empty($final['error'])) {
            return ['ok' => false, 'thinking' => $final['thinking'], 'answer' => $final['answer'], 'error' => $final['error']];
        }
        return ['ok' => true, 'thinking' => $final['thinking'], 'answer' => $final['answer']];
    }

    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($body === false) {
        return ['ok' => false, 'thinking' => '', 'answer' => '', 'error' => $err ?: 'sidecar unreachable'];
    }
    $data = json_decode($body, true) ?: [];
    if ($code < 200 || $code >= 300) {
        $msg = $data['error']['message'] ?? ('sidecar http '.$code);
        return ['ok' => false, 'thinking' => '', 'answer' => '', 'error' => $msg, 'code' => $code];
    }
    return [
        'ok' => true,
        'thinking' => (string)($data['thinking'] ?? ''),
        'answer' => (string)($data['answer'] ?? ''),
        'provider' => $data['provider'] ?? $providerId,
        'model' => $data['model'] ?? '',
        'traceId' => $data['traceId'] ?? $traceId,
    ];
}

function model_to_provider(string $model): string {
    global $UPSTREAM_MAP;
    $m = strtolower(trim($model));
    if ($m === '') return 'deepseek';
    $cfgModel = strtolower((string)($UPSTREAM_MAP['deepseek']['model'] ?? ''));
    if ($m === 'deepseek' || ($cfgModel !== '' && $m === $cfgModel)) return 'deepseek';
    if (str_starts_with($m,'deepseek') || str_starts_with($m,'ds-') || $m==='r1' || str_starts_with($m,'deepseek-r1')) return 'deepseek';
    return 'default';
}
