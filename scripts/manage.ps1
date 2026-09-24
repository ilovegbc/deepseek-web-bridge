# deepseek-web-bridge 管理脚本（唯一入口）
# 用法:
#   .\scripts\manage.ps1              # 终端菜单
#   .\scripts\manage.ps1 -Action check|setup|start|stop|menu
# 环境变量可覆盖: PHP_BIN, NODE_BIN, CHROME_PATH, GATEWAY_PORT, SIDECAR_PORT, API_KEY
[CmdletBinding()]
param(
  [ValidateSet('menu','check','setup','start','stop')]
  [string]$Action = 'menu',
  [int]$GatewayPort = 0,
  [int]$SidecarPort = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeDir = Join-Path $Root 'node'
$RunDir = Join-Path $Root 'scripts\.run'
$StateFile = Join-Path $RunDir 'state.json'

function Write-Ok($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red }
function Write-Hdr($m)  { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

function Ensure-RunDir {
  if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }
}

function Save-State([hashtable]$s) {
  Ensure-RunDir
  ($s | ConvertTo-Json -Depth 5) | Out-File -FilePath $StateFile -Encoding utf8
}
function Load-State {
  if (Test-Path $StateFile) {
    try { return Get-Content $StateFile -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $null }
  }
  return $null
}
function Get-SavedPort([string]$name, [int]$fallback) {
  $st = Load-State
  if ($st -and $st.$name) { return [int]$st.$name }
  $envVal = [Environment]::GetEnvironmentVariable($name)
  if ($envVal) { try { return [int]$envVal } catch {} }
  return $fallback
}

function Find-Php {
  if ($env:PHP_BIN -and (Test-Path $env:PHP_BIN)) { return $env:PHP_BIN }
  $c = Get-Command php -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @('C:\php\php.exe','C:\PHP\php.exe',"$env:LOCALAPPDATA\Programs\PHP\php.exe",'C:\xampp\php\php.exe','D:\php\php.exe')) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
function Find-Node {
  if ($env:NODE_BIN -and (Test-Path $env:NODE_BIN)) { return $env:NODE_BIN }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @('C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe',"$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
function Find-Chrome {
  if ($env:CHROME_PATH -and (Test-Path $env:CHROME_PATH)) { return $env:CHROME_PATH }
  $cands = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  )
  foreach ($p in $cands) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}
function Test-PortFree($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return -not $c
}
function Wait-Http($url, $timeoutSec = 20) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch { Start-Sleep -Milliseconds 400 }
  }
  return $false
}
function Get-PhpIniPostMax($php) {
  try {
    $out = & $php -r "echo ini_get('post_max_size');" 2>$null
    $out = "$out".Trim()
    if ($out -match '^(\d+)([MmKk]?)$') {
      $n = [int]$Matches[1]; $u = $Matches[2].ToUpper()
      if ($u -eq 'K') { return [int]($n / 1024) }
      if ($u -eq '' -or $u -eq 'B') { return [int]($n / 1MB) }
      return $n
    }
  } catch {}
  return -1
}
function Get-PhpExtCurl($php) {
  try {
    $out = & $php -r "echo extension_loaded('curl') ? '1' : '0';" 2>$null
    return ("$out" -match '1')
  } catch { return $false }
}
function Test-Playwright {
  return (Test-Path (Join-Path $NodeDir 'node_modules\playwright'))
}
function Stop-ByName {
  $stopped = 0
  foreach ($name in @('sidecar','gateway')) {
    $pidFile = Join-Path $RunDir "$name.pid"
    if (Test-Path $pidFile) {
      $procId = $null
      try { $procId = [int]((Get-Content $pidFile -Raw) -replace '\D','') } catch {}
      if ($procId) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) {
          try { Stop-Process -Id $procId -Force -ErrorAction Stop; $stopped++ } catch {}
        }
      }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  $gw = Get-SavedPort 'GatewayPort' 8080
  $sc = Get-SavedPort 'SidecarPort' 8090
  foreach ($port in @($gw, $sc, 8080, 8090)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in @($conns)) {
      $procId = $c.OwningProcess
      if ($procId -and $procId -ne 0) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
        if ($proc -and ($proc.CommandLine -match 'sidecar\.js|php\.exe.*-S')) {
          try { Stop-Process -Id $procId -Force -ErrorAction Stop; $stopped++ } catch {}
        }
      }
    }
  }
  return $stopped
}

function Invoke-Check {
  Write-Hdr "环境检测（本项目最低要求）"
  $fail = 0
  $php = Find-Php
  $node = Find-Node
  $chrome = Find-Chrome

  if ($php) {
    $ver = & $php -r "echo PHP_VERSION;" 2>$null
    $ver = "$ver".Trim()
    Write-Ok "PHP     $ver  ($php)"
    $major = 0; $minor = 0
    if ($ver -match '^(\d+)\.(\d+)') { $major = [int]$Matches[1]; $minor = [int]$Matches[2] }
    if ($major -lt 8 -or ($major -eq 8 -and $minor -lt 1)) {
      Write-Bad "PHP 最低要求 >= 8.1，当前 $ver"; $fail++
    }
    if (Get-PhpExtCurl $php) { Write-Ok "ext     curl 已启用" } else { Write-Bad "ext     缺少 curl 扩展"; $fail++ }
    $pm = Get-PhpIniPostMax $php
    if ($pm -ge 8) { Write-Ok "ini     post_max_size >= 8M (当前 ${pm}M)" }
    elseif ($pm -gt 0) { Write-Warn "ini     post_max_size=${pm}M，建议 >= 8M（大会话可能 413）" }
    else { Write-Warn "ini     无法读取 post_max_size，建议 >= 8M" }
  } else {
    Write-Bad "PHP     未找到（最低 8.1；可设 PHP_BIN）"; $fail++
  }

  if ($node) {
    $nver = & $node -v 2>$null
    Write-Ok "Node    $nver  ($node)"
    $num = 0
    if ($nver -match 'v(\d+)') { $num = [int]$Matches[1] }
    if ($num -lt 18) { Write-Bad "Node 最低要求 >= 18，当前 $nver"; $fail++ }
  } else {
    Write-Bad "Node    未找到（最低 18；可设 NODE_BIN）"; $fail++
  }

  if ($chrome) { Write-Ok "Browser $chrome" } else { Write-Warn "Browser 未检测到 Chrome/Edge/Chromium（可设 CHROME_PATH；也可由 playwright 自带）" }

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    $npmv = npm -v 2>$null
    Write-Ok "npm     $npmv"
  } else {
    Write-Warn "npm     未找到（安装依赖需要）"
  }

  if (Test-Playwright) { Write-Ok "deps    node/node_modules/playwright 已安装" }
  else { Write-Warn "deps    playwright 未安装 — 菜单选 2 或 -Action setup" }

  $gp = Get-SavedPort 'GatewayPort' $(if ($GatewayPort) { $GatewayPort } else { 8080 })
  $sp = Get-SavedPort 'SidecarPort' $(if ($SidecarPort) { $SidecarPort } else { 8090 })
  if (Test-PortFree $gp) { Write-Ok "port    $gp 网关可用（或未占用）" } else { Write-Warn "port    $gp 网关端口占用中（可能已在运行）" }
  if (Test-PortFree $sp) { Write-Ok "port    $sp sidecar可用（或未占用）" } else { Write-Warn "port    $sp sidecar端口占用中（可能已在运行）" }

  if ($node) {
    $nd = $node
    Write-Hdr "语法检查"
    Push-Location $NodeDir
    try {
      & $nd --check sidecar.js
      & $nd --check providers.js
      & $nd --check bridge.js
      & $nd --check webdriver.js
      if ($LASTEXITCODE -eq 0) { Write-Ok "node 源文件语法通过" } else { Write-Bad "node 语法失败"; $fail++ }
    } catch { Write-Bad "node 语法失败"; $fail++ }
    Pop-Location
    if ($php) {
      $phpOk = $true
      foreach ($f in @('index.php','config.php','lib\Helpers.php','lib\WebDriver.php','lib\ToolCalling.php')) {
        $p = Join-Path $Root $f
        $r = & $php -l $p 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Bad "php -l $f : $r"; $fail++; $phpOk = $false }
      }
      if ($phpOk) { Write-Ok "php 语法通过" }
    }
  }

  Write-Hdr "结果"
  if ($fail -eq 0) {
    Write-Ok "环境满足本项目最低要求"
    return $true
  }
  Write-Bad "存在 $fail 项未满足最低要求"
  return $false
}

function Invoke-Setup {
  Write-Hdr "安装 / 升级 / 补依赖"
  $node = Find-Node
  if (-not $node) { Write-Bad "Node 未找到，无法 npm install"; return $false }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { Write-Bad "npm 未找到"; return $false }
  Push-Location $NodeDir
  try {
    Write-Host "npm install ..."
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Write-Bad "npm install 失败"; return $false }
    Write-Ok "依赖已安装/更新"
    & npm run check
    if ($LASTEXITCODE -ne 0) { Write-Bad "语法检查失败"; return $false }
    Write-Ok "语法检查通过"
    if (-not (Find-Chrome)) {
      Write-Warn "未检测到系统浏览器，尝试 playwright install chromium ..."
      & npx playwright install chromium
    }
  } finally { Pop-Location }
  Invoke-Check | Out-Null
  return $true
}

function Invoke-Stop {
  Write-Hdr "停止 deepseek-web-bridge"
  $n = Stop-ByName
  if (Test-Path $StateFile) { Remove-Item $StateFile -Force -ErrorAction SilentlyContinue }
  Write-Ok "已停止（操作数=$n）"
}

function Invoke-Start {
  param([int]$GwPort, [int]$ScPort)
  Write-Hdr "启动 deepseek-web-bridge"
  $php = Find-Php
  $node = Find-Node
  if (-not $php) { Write-Bad "PHP 未找到"; return $false }
  if (-not $node) { Write-Bad "Node 未找到"; return $false }
  if (-not (Test-Playwright)) { Write-Bad "playwright 未安装 — 先执行 setup"; return $false }

  if (-not $GwPort -or $GwPort -le 0) { $GwPort = Get-SavedPort 'GatewayPort' 8080 }
  if (-not $ScPort -or $ScPort -le 0) { $ScPort = Get-SavedPort 'SidecarPort' 8090 }
  if ($GwPort -eq $ScPort) { Write-Bad "网关与 sidecar 端口不能相同"; return $false }
  if (-not (Test-PortFree $GwPort)) {
    $existing = Get-NetTCPConnection -LocalPort $GwPort -State Listen -ErrorAction SilentlyContinue
    if ($existing) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing[0].OwningProcess)" -ErrorAction SilentlyContinue
      if ($proc -and $proc.CommandLine -match 'php\.exe.*-S') {
        Write-Warn "网关已在 $GwPort 运行，先停止再启动"
        Invoke-Stop
        Start-Sleep -Milliseconds 500
      } else {
        Write-Bad "端口 $GwPort 被其它进程占用"; return $false
      }
    }
  }
  if (-not (Test-PortFree $ScPort)) {
    Write-Warn "sidecar 端口 $ScPort 占用，尝试先停止相关进程"
    Invoke-Stop
    Start-Sleep -Milliseconds 500
  }

  Ensure-RunDir
  $env:GATEWAY_PORT = "$GwPort"
  $env:SIDECAR_PORT = "$ScPort"
  $env:PHP_BIN = $php
  $env:NODE_BIN = $node
  $chrome = Find-Chrome
  if ($chrome) { $env:CHROME_PATH = $chrome }

  Save-State @{
    GatewayPort = $GwPort
    SidecarPort = $ScPort
    Php = $php
    Node = $node
    Chrome = $chrome
    StartedAt = (Get-Date).ToString('o')
  }

  $sidecarLog = Join-Path $RunDir 'sidecar.log'
  $sidecarErr = Join-Path $RunDir 'sidecar.err.log'
  $gwLog = Join-Path $RunDir 'gateway.log'
  $gwErr = Join-Path $RunDir 'gateway.err.log'

  $sc = Start-Process -FilePath $node -ArgumentList @('sidecar.js') `
    -WorkingDirectory $NodeDir -WindowStyle Hidden `
    -RedirectStandardOutput $sidecarLog -RedirectStandardError $sidecarErr -PassThru
  $sc.Id | Out-File -FilePath (Join-Path $RunDir 'sidecar.pid') -Encoding ascii
  Write-Ok "sidecar pid $($sc.Id) port $ScPort"

  if (-not (Wait-Http "http://127.0.0.1:$ScPort/health" 25)) {
    Write-Bad "sidecar 健康检查超时 — 见 $sidecarErr"
    if (Test-Path $sidecarErr) { Get-Content $sidecarErr -Tail 40 | Write-Host }
    return $false
  }
  Write-Ok "sidecar health OK"

  $bind = if ($env:GATEWAY_BIND) { $env:GATEWAY_BIND } else { '0.0.0.0' }
  $gw = Start-Process -FilePath $php -ArgumentList @('-S', "${bind}:$GwPort", '-t', $Root) `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $gwLog -RedirectStandardError $gwErr -PassThru
  $gw.Id | Out-File -FilePath (Join-Path $RunDir 'gateway.pid') -Encoding ascii
  Write-Ok "gateway pid $($gw.Id) port $GwPort"

  if (-not (Wait-Http "http://127.0.0.1:$GwPort/health" 15)) {
    Write-Bad "gateway 健康检查超时 — 见 $gwErr"
    if (Test-Path $gwErr) { Get-Content $gwErr -Tail 40 | Write-Host }
    return $false
  }
  Write-Ok "gateway health OK"

  Write-Host ""
  Write-Host "  Gateway : http://127.0.0.1:$GwPort" -ForegroundColor Cyan
  Write-Host "  Login   : http://127.0.0.1:$GwPort/login" -ForegroundColor Cyan
  Write-Host "  Health  : http://127.0.0.1:$GwPort/health" -ForegroundColor Cyan
  Write-Host "  Sidecar : http://127.0.0.1:$ScPort/health" -ForegroundColor Cyan
  $keyShow = $env:API_KEY
  if (-not $keyShow) { $keyShow = 'sk-test-local-proxy-key' }
  Write-Host "  API Key : $keyShow (见 config.php)" -ForegroundColor DarkGray
  return $true
}

function Show-Menu {
  while ($true) {
    Clear-Host
    $st = Load-State
    $portInfo = if ($st) { "网关:$($st.GatewayPort) sidecar:$($st.SidecarPort)" } else { "默认 网关:8080 sidecar:8090" }
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host "  deepseek-web-bridge  管理菜单" -ForegroundColor Cyan
    Write-Host "  路径: $Root" -ForegroundColor DarkGray
    Write-Host "  端口: $portInfo" -ForegroundColor DarkGray
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host "  1) 环境检测（最低要求 / 语法）"
    Write-Host "  2) 安装·升级·补依赖（npm install + check）"
    Write-Host "  3) 一键启动（可自定义端口）"
    Write-Host "  4) 一键停止"
    Write-Host "  5) 打开登录页"
    Write-Host "  0) 退出"
    Write-Host ""
    $choice = Read-Host "请选择"
    switch ($choice) {
      '1' { Invoke-Check | Out-Null; Write-Host ""; Read-Host "回车返回菜单" | Out-Null }
      '2' { Invoke-Setup | Out-Null; Write-Host ""; Read-Host "回车返回菜单" | Out-Null }
      '3' {
        $gwDefault = Get-SavedPort 'GatewayPort' 8080
        $scDefault = Get-SavedPort 'SidecarPort' 8090
        $gwIn = Read-Host "网关端口 [$gwDefault]"
        $scIn = Read-Host "sidecar端口 [$scDefault]"
        $gw = if ($gwIn) { [int]$gwIn } else { $gwDefault }
        $sc = if ($scIn) { [int]$scIn } else { $scDefault }
        Invoke-Start -GwPort $gw -ScPort $sc | Out-Null
        Write-Host ""; Read-Host "回车返回菜单" | Out-Null
      }
      '4' { Invoke-Stop; Write-Host ""; Read-Host "回车返回菜单" | Out-Null }
      '5' {
        $gw = Get-SavedPort 'GatewayPort' 8080
        Start-Process "http://127.0.0.1:$gw/login"
      }
      '0' { return }
      default { }
    }
  }
}

if ($GatewayPort -gt 0) { $env:GATEWAY_PORT = "$GatewayPort" }
if ($SidecarPort -gt 0) { $env:SIDECAR_PORT = "$SidecarPort" }

switch ($Action) {
  'check' { if (Invoke-Check) { exit 0 } else { exit 1 } }
  'setup' { if (Invoke-Setup) { exit 0 } else { exit 1 } }
  'start' {
    $gw = if ($GatewayPort -gt 0) { $GatewayPort } else { 8080 }
    $sc = if ($SidecarPort -gt 0) { $SidecarPort } else { 8090 }
    if (Invoke-Start -GwPort $gw -ScPort $sc) { exit 0 } else { exit 1 }
  }
  'stop'  { Invoke-Stop; exit 0 }
  default { Show-Menu }
}
