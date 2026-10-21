# ============================================================================
#  智练 SmartFit 一键启动脚本（由上层「启动智练SmartFit.bat」调用）
# ----------------------------------------------------------------------------
#  设计要点：
#    1. 用 .ps1 而非 .bat 写中文提示：.ps1 带 UTF-8 BOM 后 PowerShell 一定能
#       正确读取，不会因控制台代码页（936 / 65001）不同而乱码；
#    2. 浏览器统一用 127.0.0.1 打开，而不是 localhost —— Windows 上 localhost
#       可能被优先解析为 IPv6 的 ::1，而 Vite 只监听 IPv4 时会连不上；
#    3. 全过程写日志到 logs\launcher.log，万一启动失败可直接看日志定位问题。
#  ============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$url = 'http://127.0.0.1:5173'

try { $Host.UI.RawUI.WindowTitle = '智练 SmartFit 启动器' } catch {}

# ---------------- 日志 ----------------
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'launcher.log'

function Write-Log($msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}
function Write-Line($text, $color = 'Gray') {
    Write-Host $text -ForegroundColor $color
    Write-Log $text
}

Write-Log '================ 启动器开始运行 ================'
Write-Log ("项目目录: " + $root)

Write-Host ''
Write-Line '==================================================' 'Green'
Write-Line '   智练 SmartFit  ·  AI 个人健康 / 运动管理平台' 'Green'
Write-Line '==================================================' 'Green'
Write-Host ''

# ---------------- 工具函数：打开浏览器 ----------------
function Open-Browser($address) {
    Write-Log ("打开浏览器: " + $address)
    try {
        Start-Process $address
        return $true
    } catch {
        Write-Log ("Start-Process 失败: " + $_.Exception.Message)
    }
    try {
        Start-Process 'cmd.exe' -ArgumentList '/c', 'start', '', $address -WindowStyle Hidden
        return $true
    } catch {
        Write-Log ("cmd start 失败: " + $_.Exception.Message)
    }
    return $false
}

# ---------------- 1. 服务已在运行则直接打开浏览器 ----------------
$listening = $false
try {
    $listening = [bool](Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)
} catch {
    $listening = [bool](netstat -ano | Select-String ':5173 .*LISTENING')
}

if ($listening) {
    Write-Line '[i] 服务已经在运行，正在为你打开浏览器…' 'Cyan'
    Write-Line '    如果浏览器没有自动打开，请手动复制这个地址：' 'Cyan'
    Write-Line ("    " + $url) 'White'
    Write-Host ''
    Write-Line '    演示账号 : demo      密码 : 123456' 'White'
    $opened = Open-Browser $url
    if (-not $opened) {
        Write-Line '[!] 自动打开浏览器失败，请手动在浏览器地址栏输入上面的地址。' 'Yellow'
    }
    Start-Sleep -Seconds 3
    exit 0
}

# ---------------- 2. 依赖检查 ----------------
if (-not (Test-Path (Join-Path $root 'node_modules\express'))) {
    Write-Line '[*] 首次运行，正在安装依赖，请耐心等待几分钟…' 'Yellow'
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络或 Node.js 安装' }
    Write-Line '[*] 依赖安装完成' 'Green'
    Write-Host ''
}

# ---------------- 3. 数据库检查 ----------------
if (-not (Test-Path (Join-Path $root 'server\data\smartfit.db'))) {
    Write-Line '[*] 正在初始化数据库与演示数据…' 'Yellow'
    & npm run init:db
    if ($LASTEXITCODE -ne 0) { throw '数据库初始化失败' }
    Write-Host ''
}

# ---------------- 4. 提示 ----------------
Write-Line '[*] 正在启动服务，约 8 秒后自动打开浏览器…' 'Yellow'
Write-Host ''
Write-Line '    访问地址 : http://127.0.0.1:5173' 'White'
Write-Line '    演示账号 : demo      密码 : 123456' 'White'
Write-Host ''
Write-Line '    --------------------------------------------------' 'DarkGray'
Write-Line '    · 不要关闭本窗口，关闭窗口 = 停止服务' 'DarkGray'
Write-Line '    · 停止服务：关闭本窗口，或按 Ctrl + C' 'DarkGray'
Write-Line '    · 启动日志：logs\launcher.log' 'DarkGray'
Write-Line '    --------------------------------------------------' 'DarkGray'
Write-Host ''

# ---------------- 5. 延迟 8 秒开浏览器（等 Vite 就绪） ----------------
Start-Job -ScriptBlock {
    param($u)
    Start-Sleep -Seconds 8
    try { Start-Process $u } catch {}
} -ArgumentList $url | Out-Null

# ---------------- 6. 前台启动前后端 ----------------
Write-Log '执行 npm run dev'
& npm run dev
Write-Log ("npm run dev 退出，代码 " + $LASTEXITCODE)

Write-Host ''
Write-Line '服务已停止。' 'DarkGray'
Write-Line '（如果这是意外退出，请查看 logs\launcher.log）' 'DarkGray'
