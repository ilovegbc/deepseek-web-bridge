# 安装网关载荷依赖 + 下载 Playwright Chromium 到载荷内（官方 CDN）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$gw = (Resolve-Path (Join-Path $here '..')).Path + '\resources\gateway'
$nodeDir = Join-Path $gw 'node'
$browsers = Join-Path $gw 'browsers'

if (-not (Test-Path (Join-Path $nodeDir 'package.json'))) { throw "payload not synced, run sync-gateway.ps1 first" }

$npm = (Get-Command npm -ErrorAction SilentlyContinue)
if (-not $npm) { throw 'npm not found' }

Push-Location $nodeDir
try {
  Write-Host "[npm ] installing payload deps in $nodeDir"
  & npm install --no-audit --no-fund --omit=dev 2>&1 | ForEach-Object { "      $_" }
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

  if (-not (Test-Path $browsers)) { New-Item -ItemType Directory -Force -Path $browsers | Out-Null }
  $env:PLAYWRIGHT_BROWSERS_PATH = $browsers
  Write-Host "[pw  ] downloading Playwright Chromium -> $browsers"
  & npx playwright install chromium 2>&1 | ForEach-Object { "      $_" }
  if ($LASTEXITCODE -ne 0) { throw "playwright install failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
  Remove-Item Env:\PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
}

$pw = Join-Path $nodeDir 'node_modules\playwright'
if (-not (Test-Path $pw)) { throw 'playwright missing after install' }
$chromium = @(Get-ChildItem $browsers -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue).Count
Write-Host "[done] payload ready (chromium dirs: $chromium)"
