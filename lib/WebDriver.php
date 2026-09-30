<?php
// Playwright sidecar HTTP 客户端

require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/Helpers.php';

function sidecar_request(string $path, ?array $post = null, int $timeoutSec = 30, string $method = '') {
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
    } elseif ($method !== '' && strtoupper($method) !== 'GET') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($method));
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

function sidecar_open_login(string $provider, ?string $accountId = null): array {
    $post = ['provider' => $provider];
    if ($accountId !== null && $accountId !== '') $post['accountId'] = $accountId;
    return sidecar_request('/login', $post, 65);
}

function sidecar_close_login(): array {
    return sidecar_request('/login/close', [], 15);
}

function sidecar_login_status(?string $accountId = null): array {
    $path = '/login/status' . ($accountId ? '?account=' . rawurlencode($accountId) : '');
    return sidecar_request($path, null, 15);
}

function sidecar_accounts(): array {
    return sidecar_request('/accounts', null, 5);
}

function sidecar_add_account(array $acc): array {
    return sidecar_request('/accounts', $acc, 8);
}

function sidecar_remove_account(string $accountId): array {
    return sidecar_request('/accounts?id=' . rawurlencode($accountId), null, 8, 'DELETE');
}

/** 池内任一账号已登录则可用 */
function pool_any_logged_in(): bool {
    $st = sidecar_login_status();
    if (!$st['ok'] || !is_array($st['data'])) return false;
    foreach ($st['data'] as $acc) {
        if (is_array($acc) && !empty($acc['loggedIn'])) return true;
    }
    return false;
}

function pool_summary(): array {
    $total = 0; $loggedIn = 0; $busy = 0;
    $st = sidecar_login_status();
    if ($st['ok'] && is_array($st['data'])) {
        foreach ($st['data'] as $acc) {
            if (!is_array($acc)) continue;
            $total++;
            if (!empty($acc['loggedIn'])) $loggedIn++;
            if (!empty($acc['busy'])) $busy++;
        }
    }
    return ['total' => $total, 'loggedIn' => $loggedIn, 'busy' => $busy];
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
