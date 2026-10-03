<?php
// ToolCalling 回归测试：php scripts\test-toolcalling.php
require __DIR__.'/../lib/ToolCalling.php';

$fail=0; $pass=0;
function check(string $name, bool $ok, string $detail='') {
    global $fail,$pass;
    if ($ok) { $pass++; echo "PASS  $name\n"; }
    else { $fail++; echo "FAIL  $name  $detail\n"; }
}

$planFull = ['enabled'=>true,'required'=>false,'parallel'=>true,'tools'=>['pwsh'=>['name'=>'pwsh'],'glob'=>['name'=>'glob']],'error'=>null];
$planOne  = ['enabled'=>true,'required'=>false,'parallel'=>false,'tools'=>['pwsh'=>['name'=>'pwsh'],'glob'=>['name'=>'glob']],'error'=>null];
$planOff  = ['enabled'=>false,'required'=>false,'parallel'=>true,'tools'=>[],'error'=>null];
$planUnknown = ['enabled'=>true,'required'=>false,'parallel'=>true,'tools'=>['bash'=>['name'=>'bash']],'error'=>null];

$sample = '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="pwsh"> <｜｜DSML｜｜ parameter name="command" string="true">Get-Location; Get-ChildItem -Force | Select-Object Mode,Length,Name</｜｜DSML｜｜ parameter> <｜｜DSML｜｜ parameter name="description" string="true">List workspace root contents</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> <｜｜DSML｜｜ invoke name="glob"> <｜｜DSML｜｜ parameter name="pattern" string="true">*.md</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>';

// 1. 并行双调用
$r = ToolCalling::parse($sample, $planFull);
check('dsml parallel 2 calls', count($r['calls'])===2 && $r['attemptedToolCall'] && $r['content']==='', json_encode($r['calls']));
check('dsml call[0] name=pwsh', ($r['calls'][0]['name']??'')==='pwsh');
$a0 = json_decode($r['calls'][0]['arguments']??'', true);
check('dsml call[0] args command', is_array($a0) && str_starts_with($a0['command']??'', 'Get-Location'), $r['calls'][0]['arguments']??'');
check('dsml call[0] args description', ($a0['description']??'')==='List workspace root contents');
$a1 = json_decode($r['calls'][1]['arguments']??'', true);
check('dsml call[1] name=glob pattern=*.md', ($r['calls'][1]['name']??'')==='glob' && ($a1['pattern']??'')==='*.md');
check('dsml call ids generated', str_starts_with($r['calls'][0]['id']??'', 'call_'));

// 2. 串行只取第一个
$r = ToolCalling::parse($sample, $planOne);
check('dsml non-parallel 1 call', count($r['calls'])===1 && ($r['calls'][0]['name']??'')==='pwsh');

// 3. 工具名不在白名单
$r = ToolCalling::parse($sample, $planUnknown);
check('dsml unknown tool -> attempted', $r['attemptedToolCall'] && count($r['calls'])===0);

// 4. 未启用工具时原样透传（不做解析）
$r = ToolCalling::parse($sample, $planOff);
check('dsml plan off passthrough', !$r['attemptedToolCall'] && count($r['calls'])===0 && $r['content']===$sample);

// 5. 无 calls 包裹、裸 invoke
$bare = '<｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="command" string="true">Get-Date</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
$r = ToolCalling::parse($bare, $planFull);
check('dsml bare invoke', count($r['calls'])===1 && ($r['calls'][0]['name']??'')==='pwsh');
$a0 = json_decode($r['calls'][0]['arguments']??'', true);
check('dsml bare invoke arg', ($a0['command']??'')==='Get-Date');

// 6. 结构残缺（流被截断）
$r = ToolCalling::parse('<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="command" string="true">Get-Location', $planFull);
check('dsml truncated -> attempted no calls', $r['attemptedToolCall'] && count($r['calls'])===0);

// 7. 纯文本中提到 DSML（结构不成立、且不以 < 开头）→ 当正文并剥标签
$r = ToolCalling::parse('DSML 是一种标记语言，示例：<｜｜DSML｜｜ calls> 结构不完整', $planFull);
check('dsml prose mention -> content', !$r['attemptedToolCall'] && $r['calls']===[] && str_contains($r['content'],'标记语言') && !str_contains($r['content'],'DSML｜｜ calls>'), $r['content']);

// 8. 非法 JSON 参数（string=false）时兜底为字符串
$weird = '<｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="command" string="false">not-json-text</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
$r = ToolCalling::parse($weird, $planFull);
$a0 = json_decode($r['calls'][0]['arguments']??'', true);
check('dsml string=false non-json -> string', count($r['calls'])===1 && ($a0['command']??'')==='not-json-text', $r['calls'][0]['arguments']??'');

// 9. 非法 JSON 参数（string=false 且是 JSON）→ 解析为对象
$weird2 = '<｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="data" string="false">{"a":1}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
$r = ToolCalling::parse($weird2, $planFull);
$a0 = json_decode($r['calls'][0]['arguments']??'', true);
check('dsml string=false json -> object', count($r['calls'])===1 && ($a0['data']['a']??0)===1, $r['calls'][0]['arguments']??'');

// 10. 旧协议不受影响
$legacy = '<tool_calls>[{"name":"pwsh","arguments":{"command":"Get-Date"}}]</tool_calls>';
$r = ToolCalling::parse($legacy, $planFull);
check('legacy tool_calls still works', count($r['calls'])===1 && ($r['calls'][0]['name']??'')==='pwsh');
$legacy2 = '纯文本回答，不需要工具';
$r = ToolCalling::parse($legacy2, $planFull);
check('legacy plain content', $r['content']===$legacy2 && $r['calls']===[] && !$r['attemptedToolCall']);

// 11. streamMode
$cases = [
    ['', false, 'WAIT'],
    ['<｜｜DSM', false, 'WAIT'],            // 特殊标记开头但还没到 DSML 字样
    ['<｜｜DSML', false, 'TOOL'],           // DSML 出现
    ['<｜｜DSML｜｜ calls> <｜｜DSML', false, 'TOOL'],
    ['<｜', false, 'WAIT'],                // 疑似特殊标记开头
    ['<|', false, 'WAIT'],
    ['好的，我来查一下', false, 'CONTENT'],
    ['<tool_calls>', false, 'TOOL'],
    ['<tool_ca', false, 'WAIT'],
    ['', true, 'TOOL'],                    // required 模式
    ['关于 DSML 的说明', false, 'TOOL'],    // WAIT 缓冲中出现 DSML 字样
    ['关于格式的说明', false, 'CONTENT'],
];
foreach ($cases as $i=>$c) {
    $got = ToolCalling::streamMode($c[0], $c[1]);
    check("streamMode#$i ".var_export($c[0],true)." req=".($c[1]?'1':'0')." -> $c[2]", $got===$c[2], "got $got");
}

// 12. 正文前有说明文字 + tool_calls 块（不再要求标签在开头）
$pre = "I'll explore the project structure first.\n\n".'<tool_calls>[{"name":"pwsh","arguments":{"command":"Get-ChildItem","description":"List files"}},{"name":"glob","arguments":{"pattern":"*.md"}}]</tool_calls>';
$r = ToolCalling::parse($pre, $planFull);
check('preamble + tool_calls parsed as calls', count($r['calls'])===2 && ($r['calls'][0]['name']??'')==='pwsh', json_encode($r));
check('preamble kept as content', str_contains($r['content'],'explore the project structure'), $r['content']);

// 13. 正文 + 残缺 tool_calls（无闭合）仍然当正文（不误报工具）
$bad = "说明文字\n<tool_calls>[{\"name\":\"pwsh\",\"arguments\":{\"command\":\"x\"}}]";
$r = ToolCalling::parse($bad, $planFull);
check('unclosed tool_calls stays content', count($r['calls'])===0 && !$r['attemptedToolCall'], json_encode($r));

// 14. streamMode：正文后才出现标记
$cases2 = [
    ["I'll explore first.\n<tool_calls>", false, 'TOOL'],
    ["I'll explore first.", false, 'CONTENT'],
    ["说明文字</tool_call>", false, 'TOOL'],
    ["说明文字<tool_ca", false, 'WAIT'],
];
foreach ($cases2 as $i=>$c) {
    $got = ToolCalling::streamMode($c[0], $c[1]);
    check("streamMode2#$i -> $c[2]", $got===$c[2], "got $got");
}

// 15. createPlan 协议中包含 DSML 说明
$plan = ToolCalling::createPlan(['tools'=>[['type'=>'function','function'=>['name'=>'pwsh','description'=>'d','parameters'=>['type'=>'object']]]]], 'base');
check('createPlan mentions DSML', str_contains($plan['prompt'],'DSML'));

echo "\n$pass passed, $fail failed\n";
exit($fail===0?0:1);
