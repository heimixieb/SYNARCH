# Prepares a fresh clone on Windows: dependencies, the DeepSeek Harness CLI, the private key file, and a typecheck.
# Run from the repository root:  powershell -ExecutionPolicy Bypass -File scripts\synarch\setup-windows.ps1 [-NewKey]
# Security: the key is written only to %USERPROFILE%\.synarch\deepseek.env, readable by this Windows user alone.
param([switch]$NewKey)
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n出错：$text" -ForegroundColor Red; exit 1 }

Step "检查 Git 和 Node.js"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "没装 Git，请先安装：https://git-scm.com/download/win" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "没装 Node.js，请先安装 24 或更新版本：https://nodejs.org" }
$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) { Fail "Node.js 版本太旧（$(node --version)），需要 24 或更新版本：https://nodejs.org" }

Step "安装 pnpm 10.33.0"
$pnpmVersion = if (Get-Command pnpm -ErrorAction SilentlyContinue) { (pnpm --version) } else { "" }
if ($pnpmVersion -ne "10.33.0") { npm install -g pnpm@10.33.0; if ($LASTEXITCODE) { Fail "pnpm 安装失败" } }

Step "安装项目依赖（大约 1-3 分钟）"
pnpm install
if ($LASTEXITCODE) { Fail "依赖安装失败" }

Step "安装 DeepSeek 命令行工具 dsh"
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) { npm install -g "@deepseek-ai/dsh@0.2.2-rc.1"; if ($LASTEXITCODE) { Fail "dsh 安装失败" } }

Step "连接官方仓库（以后跟进官方更新用）"
if (-not ((git remote) -contains "upstream")) { git remote add upstream https://github.com/milind-soni/OpenMausBot.git }

Step "DeepSeek 密钥"
$keyDir = Join-Path $env:USERPROFILE ".synarch"
$keyFile = Join-Path $keyDir "deepseek.env"
if ($NewKey -or -not (Test-Path $keyFile)) {
  $secure = Read-Host "请粘贴 DeepSeek API 密钥（以 sk- 开头，输入时不显示）" -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if (-not $key.StartsWith("sk-")) { Fail "密钥应该以 sk- 开头，请重新运行本脚本" }
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  [IO.File]::WriteAllText($keyFile, "DEEPSEEK_API_KEY=$key`n")
  icacls $keyFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  Write-Host "已保存到 $keyFile"
} else {
  Write-Host "已有密钥文件，跳过（要换密钥就加 -NewKey 重新运行）"
}

Step "类型检查（大约 2 分钟）"
pnpm typecheck
if ($LASTEXITCODE) { Fail "类型检查没通过，把上面的报错发给 Claude" }

Write-Host "`n准备完成。在 Claude 里打开这个文件夹，说「继续任务」即可。" -ForegroundColor Green
