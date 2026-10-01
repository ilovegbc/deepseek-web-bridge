# 生成桌面版图形资源：icon.ico（多尺寸）+ 安装向导侧栏 BMP（NSIS MUI 164x314）
# 产物: build/assets/icon.ico  build/assets/installerSidebar.bmp
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'assets'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Force -Path $out | Out-Null }

function New-RoundRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $right = $x + $w
  $bottom = $y + $h
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($right - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($right - $d), ($bottom - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($bottom - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Graphics([System.Drawing.Bitmap]$bmp) {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  return $g
}

# 统一标志：蓝色渐变圆角方块 + 白色对话气泡（尾在左下）+ 三个蓝点
function Draw-Mark([System.Drawing.Graphics]$g, [float]$s) {
  $inset = $s - 1
  $radius = $s * 0.18
  $bgPath = New-RoundRectPath 0.5 0.5 $inset $inset $radius
  $p0 = New-Object System.Drawing.PointF(0, 0)
  $p1 = New-Object System.Drawing.PointF($s, $s)
  $c0 = [System.Drawing.Color]::FromArgb(255, 84, 148, 255)
  $c1 = [System.Drawing.Color]::FromArgb(255, 20, 42, 108)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p0, $p1, $c0, $c1)
  $g.FillPath($bgBrush, $bgPath)

  $white = [System.Drawing.Brushes]::White
  # 气泡
  $bx = $s * 0.20
  $by = $s * 0.22
  $bw = $s * 0.60
  $bh = $s * 0.42
  $br = $s * 0.11
  $bub = New-RoundRectPath $bx $by $bw $bh $br
  $g.FillPath($white, $bub)
  # 气泡尾巴
  $tail = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tx0 = $s * 0.30
  $tx1 = $s * 0.42
  $ty0 = $s * 0.60
  $ty1 = $s * 0.755
  $tail.AddLine($tx0, $ty0, $tx1, $ty0)
  $tail.AddLine($tx1, $ty0, $tx0, $ty1)
  $tail.CloseFigure()
  $g.FillPath($white, $tail)
  # 三个点
  $dotColor = [System.Drawing.Color]::FromArgb(255, 43, 107, 229)
  $dot = New-Object System.Drawing.SolidBrush($dotColor)
  $r = $s * 0.052
  $r2 = $r * 2
  $dy = $s * 0.43
  foreach ($f in @([float]0.34, [float]0.50, [float]0.66)) {
    $cx = $s * $f
    $g.FillEllipse($dot, ($cx - $r), ($dy - $r), $r2, $r2)
  }
  $dot.Dispose()
  $bgBrush.Dispose()
  $bgPath.Dispose()
  $bub.Dispose()
  $tail.Dispose()
}

# ---- icon.ico ----
$icoPath = Join-Path $out 'icon.ico'
$imgs = @()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = New-Graphics $bmp
  $fs2 = [float]$size
  Draw-Mark $g $fs2
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $imgs += ,@{ size = $size; data = $ms.ToArray() }
  $ms.Dispose(); $bmp.Dispose()
}

$fs = [System.IO.File]::Create($icoPath)
try {
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$imgs.Count)
  [uint32]$offset = 6
  $offset = $offset + (16 * $imgs.Count)
  foreach ($im in $imgs) {
    $dim = if ($im.size -ge 256) { [byte]0 } else { [byte]$im.size }
    $bw.Write($dim)
    $bw.Write($dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    [uint32]$len = $im.data.Length
    $bw.Write($len)
    $bw.Write($offset)
    $offset = $offset + $len
  }
  foreach ($im in $imgs) { $bw.Write([byte[]]$im.data) }
  $bw.Flush()
} finally { $fs.Dispose() }
Write-Host "[assets] $icoPath ($(([System.IO.FileInfo]$icoPath).Length) bytes)"

# ---- installerSidebar.bmp（NSIS MUI_WELCOMEFINISHPAGE_BITMAP = 164x314, 24bpp）----
$sw = 164
$sh = 314
$bmp = New-Object System.Drawing.Bitmap($sw, $sh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = New-Graphics $bmp

$p0 = New-Object System.Drawing.PointF(0, 0)
$p1 = New-Object System.Drawing.PointF($sw, $sh)
$c0 = [System.Drawing.Color]::FromArgb(255, 62, 120, 235)
$c1 = [System.Drawing.Color]::FromArgb(255, 16, 32, 78)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p0, $p1, $c0, $c1)
$g.FillRectangle($bgBrush, 0, 0, $sw, $sh)

# 装饰弧线（右下，低透明度）
$arcColor = [System.Drawing.Color]::FromArgb(36, 255, 255, 255)
$arcPen = New-Object System.Drawing.Pen($arcColor, 10)
$g.DrawArc($arcPen, 40, 200, 240, 240, 200, 140)
$g.DrawArc($arcPen, 90, 250, 240, 240, 200, 140)
$arcPen.Dispose()

# 标志（放大绘制在上半部）
$markSize = 96
$mx = ($sw - $markSize) / 2
$g.TranslateTransform($mx, 56)
$scale = $markSize / 256.0
$g.ScaleTransform($scale, $scale)
Draw-Mark $g ([float]256)
$g.ResetTransform()

$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$fmt.LineAlignment = 'Center'

$segoe = New-Object System.Drawing.FontFamily('Segoe UI')
$yahei = New-Object System.Drawing.FontFamily('Microsoft YaHei')
$f1 = New-Object System.Drawing.Font($segoe, 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$f2 = New-Object System.Drawing.Font($yahei, 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$whiteB = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$subColor = [System.Drawing.Color]::FromArgb(255, 190, 210, 245)
$subB = New-Object System.Drawing.SolidBrush($subColor)

$r1 = New-Object System.Drawing.RectangleF(0, 178, $sw, 24)
$r2 = New-Object System.Drawing.RectangleF(0, 202, $sw, 24)
$r3 = New-Object System.Drawing.RectangleF(0, 234, $sw, 20)
$g.DrawString('DeepSeek', $f1, $whiteB, $r1, $fmt)
$g.DrawString('Web Bridge', $f1, $whiteB, $r2, $fmt)
$g.DrawString('OpenAI 兼容本地网关', $f2, $subB, $r3, $fmt)

$sidebar = Join-Path $out 'installerSidebar.bmp'
$bmp.Save($sidebar, [System.Drawing.Imaging.ImageFormat]::Bmp)

$f1.Dispose(); $f2.Dispose(); $segoe.Dispose(); $yahei.Dispose()
$whiteB.Dispose(); $subB.Dispose(); $fmt.Dispose(); $bgBrush.Dispose()
$g.Dispose(); $bmp.Dispose()

Write-Host "[assets] $sidebar ($(([System.IO.FileInfo]$sidebar).Length) bytes)"

$chk = [System.Drawing.Image]::FromFile($sidebar)
$wOk = $chk.Width
$hOk = $chk.Height
$chk.Dispose()
if ($wOk -ne 164 -or $hOk -ne 314) { throw "sidebar size wrong: ${wOk}x${hOk}" }
Write-Host '[assets] done (icon.ico multi-size + installerSidebar.bmp 164x314)'
