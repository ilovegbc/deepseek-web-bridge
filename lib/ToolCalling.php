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
            . "\n\n调用工具时，最终回答必须且只能是下面的格式，不要使用 Markdown 代码块，不要添加解释：\n<tool_calls>[{\"name\":\"工具名\",\"arguments\":{}}]</tool_calls>\narguments 必须是符合该工具 parameters 的 JSON 对象。工具结果会在下一轮以“工具返回”提供。\n"
            . "如果你更习惯原生的 DSML 调用格式（<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"工具名\"><｜｜DSML｜｜ parameter name=\"参数名\" string=\"true\">值</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>...</｜｜DSML｜｜ calls>），也可以直接使用，网关同样能解析，二选一即可。\n";
        $prompt = $basePrompt . "\n\n[系统工具调用协议]\n" . $protocol;
        return ['prompt'=>$prompt,'tools'=>$map,'enabled'=>true,'required'=>$required,'parallel'=>$parallel,'error'=>null];
    }

    public static function parse(string $answer, array $plan): array {
        if (!$plan['enabled']) {
            return ['content'=>$answer,'calls'=>[],'attemptedToolCall'=>false];
        }
        $dsml=self::extractDsml($answer);
        if ($dsml!==null) {
            if ($dsml['raw']) {
                if (preg_match('/^\s*<\s*[\/｜|]/',$answer)) return ['content'=>'','calls'=>[],'attemptedToolCall'=>true];
                $content=trim(preg_replace('#</?[^>]*\bDSML\b[^>]*>#s','',$answer));
                return ['content'=>$content,'calls'=>[],'attemptedToolCall'=>false];
            }
            $calls=self::buildDsmlCalls($dsml['inner'],$plan);
            if (!empty($calls)) return ['content'=>'','calls'=>$calls,'attemptedToolCall'=>true];
            return ['content'=>'','calls'=>[],'attemptedToolCall'=>true];
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
        // DeepSeek 原生 DSML 工具调用标记（如 <｜｜DSML｜｜ calls>…invoke…）
        if (stripos($trim,'DSML')!==false) return 'TOOL';
        if (preg_match('/<(?:｜|\|)[^>]*\b(invoke|calls)\b/i',$trim)) return 'TOOL';
        if (preg_match('/^<\s*[｜|]/',$trim)) return 'WAIT';
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

    // 提取 DeepSeek 原生 DSML 工具调用块（也兜底全角竖线风格的同类标记）
    private static function extractDsml(string $a): ?array {
        $looksLikeDsml = stripos($a,'DSML')!==false || preg_match('/<(?:｜|\|)[^>]*\b(?:invoke|calls|parameters)\b/i',$a);
        if (!$looksLikeDsml) return null;
        $blocks=[];
        $inner='';
        if (preg_match_all('#<[^>/]*\bDSML\b[^>]*\bcalls\b[^>]*>(.*?)<\s*/[^>]*\bDSML\b[^>]*\bcalls\b[^>]*>#si',$a,$m)) {
            // calls 包裹：inner 取包裹内容（内含 invoke 块）
            foreach ($m[0] as $i=>$full) { $blocks[]=$full; $inner.="\n".$m[1][$i]; }
        } elseif (preg_match_all('#<(?:｜|\|)[^>]*\bcalls\b[^>]*>(.*?)<\s*/(?:｜|\|)[^>]*\bcalls\b[^>]*>#s',$a,$m)) {
            foreach ($m[0] as $i=>$full) { $blocks[]=$full; $inner.="\n".$m[1][$i]; }
        } elseif (preg_match_all('#<[^>/]*\bDSML\b[^>]*\binvoke\b[^>]*>.*?<\s*/[^>]*\bDSML\b[^>]*\binvoke\b[^>]*>#si',$a,$m)) {
            // 裸 invoke（无 calls 包裹）：inner 需保留 invoke 标签本身
            foreach ($m[0] as $full) { $blocks[]=$full; $inner.="\n".$full; }
        } elseif (preg_match_all('#<(?:｜|\|)[^>]*\binvoke\b[^>]*>.*?<\s*/(?:｜|\|)[^>]*\binvoke\b[^>]*>#s',$a,$m)) {
            foreach ($m[0] as $full) { $blocks[]=$full; $inner.="\n".$full; }
        }
        if ($inner==='') return ['blocks'=>$blocks,'inner'=>'','raw'=>true];
        return ['blocks'=>$blocks,'inner'=>$inner,'raw'=>false];
    }

    private static function buildDsmlCalls(string $inner, array $plan): array {
        if (!preg_match_all('#(<[^>/]*\bDSML\b[^>]*\binvoke\b[^>]*>)(.*?)<\s*/[^>]*\bDSML\b[^>]*\binvoke\b[^>]*>#si',$inner,$ms,PREG_SET_ORDER)) return [];
        $out=[];
        foreach ($ms as $m) {
            if (!preg_match('/\bname\s*=\s*[\'"]([^\'"]+)[\'"]/',$m[1],$nm)) continue;
            $name=trim($nm[1]);
            if (!isset($plan['tools'][$name])) continue;
            $args=[];
            if (preg_match_all('#(<[^>/]*\bDSML\b[^>]*\bparameter\b[^>]*>)(.*?)<\s*/[^>]*\bDSML\b[^>]*\bparameter\b[^>]*>#si',$m[2],$ps,PREG_SET_ORDER)) {
                foreach ($ps as $p) {
                    if (!preg_match('/\bname\s*=\s*[\'"]([^\'"]+)[\'"]/',$p[1],$pn)) continue;
                    $args[$pn[1]]=self::dsmlValue($p[2],$p[1]);
                }
            }
            $norm = empty($args) ? '{}' : self::normalizeArguments($args);
            if ($norm===null) continue;
            $out[]=['id'=>'call_'.substr(str_replace('-','',bin2hex(random_bytes(16))),0,24),'name'=>$name,'arguments'=>$norm];
            if (!$plan['parallel'] || count($out)>=64) break;
        }
        return $out;
    }

    private static function dsmlValue(string $raw, string $header) {
        $raw=trim($raw);
        if (preg_match('/\bstring\s*=\s*[\'"]?(?:true|1)[\'"]?/i',$header)) return $raw;
        if (preg_match('/\bstring\s*=\s*[\'"]?(?:false|0)[\'"]?/i',$header)) {
            if ($raw!=='') { $j=json_decode($raw,true); if (json_last_error()===JSON_ERROR_NONE && $j!==null) return $j; }
            return $raw;
        }
        if ($raw!=='' && ($raw[0]==='{' || $raw[0]==='[')) {
            $j=json_decode($raw,true);
            if (json_last_error()===JSON_ERROR_NONE && $j!==null) return $j;
        }
        return $raw;
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
