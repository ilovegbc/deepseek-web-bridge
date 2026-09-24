<?php
// 工具调用协议：注入 / 解析 / 流式模式

class ToolCalling {
    const MAX_TOOLS = 64;
    const MAX_SCHEMA_CHARS = 32768;
    const MAX_DESCRIPTION_CHARS = 2000;

    const TOOL_TAGS = ['<tool_calls>', '<tool_call>'];

    public static function createPlan(array $body, string $basePrompt): array {
        if (!isset($body['tools']) || $body['tools']===null) {
            return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>true,'error'=>null];
        }
        if (!is_array($body['tools'])) {
            return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>'tools must be an array'];
        }
        $tools = $body['tools'];
        $map=[];
        $limit = min(count($tools), 64);
        for($i=0;$i<$limit;$i++){
            $t=$tools[$i];
            if (!isset($t['type']) || $t['type']!=='function') continue;
            $func=$t['function'] ?? null;
            if (!$func || !isset($func['name'])) {
                return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>"tools[$i].function is required"];
            }
            $name=$func['name'];
            if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/',$name)) {
                return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>"invalid tool name at tools[$i]"];
            }
            $desc=substr($func['description']??'',0,2000);
            $params=$func['parameters'] ?? ['type'=>'object','properties'=>new stdClass()];
            if (strlen(json_encode($params))>32768){
                return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>"tool schema is too large: $name"];
            }
            $map[$name]=['name'=>$name,'description'=>$desc,'parameters'=>$params];
        }
        if (empty($map)) {
            return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>'no valid function tools'];
        }
        $tool_choice=$body['tool_choice']??null;
        $required=false;
        $enabled=true;
        if ($tool_choice===null || $tool_choice==='auto') {
            $required=false;
        } elseif ($tool_choice==='none') {
            return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>null];
        } elseif ($tool_choice==='required') {
            $required=true;
        } elseif (is_array($tool_choice) && isset($tool_choice['function']['name'])) {
            $n=$tool_choice['function']['name'];
            if (!isset($map[$n])) return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>'tool_choice references an unknown tool'];
            $map=[$n=>$map[$n]];
            $required=false;
        } elseif (is_string($tool_choice)) {
            return ['prompt'=>$basePrompt,'tools'=>[],'enabled'=>false,'required'=>false,'parallel'=>false,'error'=>'invalid tool_choice'];
        }
        $parallel=$body['parallel_tool_calls'] ?? true;
        $arr=[];
        foreach($map as $v) $arr[]=['name'=>$v['name'],'description'=>$v['description'],'parameters'=>$v['parameters']];
        $must = $required ? '你必须调用工具，不能直接回答。' : '只有确实需要工具时才调用；不需要时直接正常回答。';
        $par  = $parallel ? '可以在数组中同时返回多个互不依赖的工具调用。' : '每次最多返回一个工具调用。';
        $protocol = "\n". $must . $par . "\n可用工具定义：\n". json_encode($arr, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT)
            . "\n\n调用工具时，最终回答必须且只能是下面的格式，不要使用 Markdown 代码块，不要添加解释：\n<tool_calls>[{\"name\":\"工具名\",\"arguments\":{}}]</tool_calls>\narguments 必须是符合该工具 parameters 的 JSON 对象。工具结果会在下一轮以“工具返回”提供。\n";
        $prompt = $basePrompt . "\n\n[系统工具调用协议]\n" . $protocol;
        return ['prompt'=>$prompt,'tools'=>$map,'enabled'=>true,'required'=>$required,'parallel'=>$parallel,'error'=>null];
    }

    public static function parse(string $answer, array $plan): array {
        if (!$plan['enabled']) {
            return ['content'=>$answer,'calls'=>[],'attemptedToolCall'=>false];
        }
        $payload=self::extractPayload($answer);
        if (!$payload) {
            return ['content'=>$answer,'calls'=>[],'attemptedToolCall'=>false];
        }
        $arr=self::parseArray($payload['text']);
        if ($arr===null) {
            if ($payload['explicit']) return ['content'=>'','calls'=>[],'attemptedToolCall'=>true];
            return ['content'=>$answer,'calls'=>[],'attemptedToolCall'=>false];
        }
        $calls=[];
        $explicit=$payload['explicit'];
        $limit=min(count($arr),64);
        for($i=0;$i<$limit;$i++){
            $obj=$arr[$i];
            if (!is_array($obj)) continue;
            if (isset($obj['name']) || isset($obj['function'])) $explicit=true;
            if (isset($obj['function']) && is_array($obj['function'])) $obj=$obj['function'];
            $name=$obj['name']??'';
            if (!isset($plan['tools'][$name])) continue;
            $args=$obj['arguments']??null;
            $norm=self::normalizeArguments($args);
            if ($norm===null) continue;
            $id='call_'.substr(str_replace('-','',bin2hex(random_bytes(16))),0,24);
            $calls[]=['id'=>$id,'name'=>$name,'arguments'=>$norm];
            if (!$plan['parallel']) break;
        }
        if (!empty($calls)) return ['content'=>'','calls'=>$calls,'attemptedToolCall'=>true];
        if ($explicit) return ['content'=>'','calls'=>[],'attemptedToolCall'=>true];
        return ['content'=>$answer,'calls'=>[],'attemptedToolCall'=>false];
    }

    public static function streamMode(string $prefix, bool $required): string {
        if ($required) return 'TOOL';
        $trim=ltrim($prefix);
        if ($trim==='') return 'WAIT';
        foreach(self::TOOL_TAGS as $tag){
            if (str_starts_with($trim,$tag)) return 'TOOL';
        }
        foreach(self::TOOL_TAGS as $tag){
            if (str_starts_with($tag,$trim)) return 'WAIT';
        }
        $first=$trim[0]??'';
        if ($first==='[') return 'TOOL';
        if ($first==='`') {
            $line=strtolower(trim(explode("\n",$trim)[0]));
            if (strpos($trim,"\n")===false && strlen($trim)<16) return 'WAIT';
            if ($line==='```' || $line==='```json') return 'TOOL';
            return 'CONTENT';
        }
        if ($first==='{') {
            return str_contains($trim,'"tool_calls"') ? 'TOOL' : ((strlen($trim)>=64 || str_contains($trim,'}')) ? 'CONTENT' : 'WAIT');
        }
        return 'CONTENT';
    }

    private static function extractPayload(string $answer): ?array {
        if (preg_match('/^\s*<tool_calls>\s*(.*?)\s*<\/tool_calls>/s',$answer,$m)){
            return ['text'=>trim($m[1]),'explicit'=>true];
        }
        if (preg_match('/^\s*<tool_call>\s*(.*?)\s*<\/tool_call>/s',$answer,$m)){
            return ['text'=>trim($m[1]),'explicit'=>true];
        }
        $t=trim($answer);
        if (str_starts_with($t,'```') && str_ends_with($t,'```')){
            $t=trim(substr($t,3,-3));
            if (str_starts_with(strtolower($t),'json')) $t=trim(substr($t,4));
        }
        if (str_starts_with($t,'[')) return ['text'=>$t,'explicit'=>false];
        if (str_starts_with($t,'{') && str_contains($t,'"tool_calls"')) return ['text'=>$t,'explicit'=>true];
        return null;
    }

    private static function parseArray(string $payload): ?array {
        $norm=str_replace(["‘","’","“","”"],'"',$payload);
        $data=json_decode($norm,true);
        if (json_last_error()!==JSON_ERROR_NONE) return null;
        if (is_array($data) && array_is_list($data)) return $data;
        if (is_array($data) && isset($data['tool_calls']) && is_array($data['tool_calls'])) return $data['tool_calls'];
        if (is_array($data) && (isset($data['name']) || isset($data['function']))) return [$data];
        return null;
    }

    private static function normalizeArguments($value): ?string {
        if ($value===null) return '{}';
        if (is_array($value)) return json_encode($value, JSON_UNESCAPED_UNICODE);
        if (is_string($value)) {
            $j=json_decode($value,true);
            if (json_last_error()===JSON_ERROR_NONE && is_array($j)) return json_encode($j, JSON_UNESCAPED_UNICODE);
            return null;
        }
        if ($value instanceof stdClass) return json_encode($value, JSON_UNESCAPED_UNICODE);
        return null;
    }
}
