# 把仓库根目录的网关源码同步进 desktop/resources/gateway（打包载荷）
# 仓库根目录是第一份源码（开发用，保持不动）；这里是第二份（随安装包分发）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$dest = (Resolve-Path (Join-Path $here '..')).Path + '\resources\gateway'

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$includeDirs = @('lib', 'node', 'scripts')
foreach ($d in $includeDirs) {
  $src = Join-Path $root $d
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $dest $d) -Recurse -Force
  }
}
foreach ($f in @('index.php', 'config.php', 'test.html', 'LICENSE', 'NOTICE')) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src $dest -Force }
}

# 载荷里不要的东西
$strip = @(
  (Join-Path $dest 'node\node_modules'),
  (Join-Path $dest 'node\accounts.json'),
  (Join-Path $dest 'scripts\.run'),
  (Join-Path $dest 'node\test-pool.js')
)
foreach ($p in $strip) { if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue } }
Get-ChildItem (Join-Path $dest 'node\profiles') -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 载荷内的 node_modules 由打包脚本安装（playwright 等）
Write-Host "[sync] gateway payload -> $dest"
Write-Host ("[sync] files: " + (Get-ChildItem $dest -Recurse -File | Measure-Object).Count)
