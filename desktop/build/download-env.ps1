# 从官方站点下载打包所需的运行时（不使用本机已安装环境）
#   PHP   : https://windows.php.net  (NTS x64 zip)
#   Node  : https://nodejs.org/dist   (win-x64 zip)
# 产物: build/env/php  build/env/node   （已 gitignore，只在本机构建时存在）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envDir = Join-Path $here '..\build\env'
New-Item -ItemType Directory -Force -Path $envDir | Out-Null

# 版本与官方 SHA256（PHP 取自 windows.php.net 下载页，Node 取自 nodejs.org SHASUMS256.txt）
$PHP_VER = '8.5.11'
$PHP_FILE = "php-${PHP_VER}-nts-Win32-vs17-x64.zip"
$PHP_URL = "https://windows.php.net/downloads/releases/$PHP_FILE"
$PHP_SHA = '0ea96e0d2b9b737a6036f05cf4e95c49313faa6d0f27bd97edb2742503f0c043'

$NODE_VER = 'v24.21.0'
$NODE_FILE = "node-${NODE_VER}-win-x64.zip"
$NODE_URL = "https://nodejs.org/dist/$NODE_VER/$NODE_FILE"
$NODE_SHA = ''
try {
  $shas = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($shas -split "`n") | Where-Object { $_ -match [regex]::Escape($NODE_FILE) } | Select-Object -First 1
  if ($line) { $NODE_SHA = ($line -split '\s+')[0].Trim() }
} catch {}

function Get-Zip($url, $dest, $sha, $label) {
  if (Test-Path $dest) {
    if ($sha -and (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -eq $sha.ToLower()) {
      Write-Host "[skip] $label already downloaded"
      return
    }
    Remove-Item $dest -Force
  }
  Write-Host "[get ] $label <- $url"
  $tmp = "$dest.dl"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 1800
  if ($sha) {
    $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $sha.ToLower()) { Remove-Item $tmp -Force; throw "$label SHA256 mismatch: $got" }
    Write-Host "[ ok ] $label SHA256 verified"
  } else {
    Write-Host "[warn] $label no SHA256 available, skip verify"
  }
  Move-Item $tmp $dest -Force
}

function Expand-Official($zip, $destName) {
  $dest = Join-Path $envDir $destName
  if (Test-Path $dest) { Write-Host "[skip] $destName already extracted"; return $dest }
  $tmp = Join-Path $envDir "_tmp_$destName"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  # Node 官方 zip 带一层 wrapper 目录 (node-vX-win-x64)；PHP 官方 zip 是根目录结构
  $hasExe = @(Get-ChildItem $tmp -File -Filter '*.exe' -ErrorAction SilentlyContinue).Count -gt 0
  if ($hasExe) {
    Move-Item $tmp $dest
  } else {
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $inner) { throw "unexpected layout in $zip" }
    Move-Item $inner.FullName $dest
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[ ok ] extracted -> $destName"
  return $dest
}

$phpZip = Join-Path $envDir $PHP_FILE
$nodeZip = Join-Path $envDir $NODE_FILE
Get-Zip $PHP_URL $phpZip $PHP_SHA 'PHP'
Get-Zip $NODE_URL $nodeZip $NODE_SHA 'Node.js'
$phpDir = Expand-Official $phpZip 'php'
$nodeDir = Expand-Official $nodeZip 'node'

# 冒烟验证：必须是下载来的官方运行时，而不是 PATH 里的
$phpExe = Join-Path $phpDir 'php.exe'
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path $phpExe)) { throw "php.exe missing in $phpDir" }
if (-not (Test-Path $nodeExe)) { throw "node.exe missing in $nodeDir" }
Write-Host ("[php ] " + (& $phpExe -v | Select-Object -First 1))
Write-Host ("[node] " + (& $nodeExe -v))
Write-Host "[done] env ready under $envDir"
