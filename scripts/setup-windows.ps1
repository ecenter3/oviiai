# OViiAI 開發環境 — Windows 端設定
# 用法：以「系統管理員」開 PowerShell，執行
#   Set-ExecutionPolicy -Scope Process Bypass -Force; .\setup-windows.ps1
# 會做：檢查 Windows 版本與 WSL2、寫入 .wslconfig、開 DDS 防火牆、檢查 Docker Desktop

$ErrorActionPreference = 'Stop'
function Ok($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[注意] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[錯誤] $m" -ForegroundColor Red; exit 1 }

# 0. 系統管理員
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail '請用「以系統管理員身分執行」開啟 PowerShell 再執行本腳本' }

# 1. Windows 版本（mirrored 網路需要 Windows 11 22H2 = build 22621 以上）
$build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
$mirrored = $build -ge 22621
if ($mirrored) { Ok "Windows build $build，支援 mirrored 網路" }
else { Warn "Windows build $build 低於 22621（Windows 11 22H2），不支援 mirrored 網路；WSL 將無法直接連機器人網段，請告知 Claude 改用其他做法" }

# 2. WSL 與 Ubuntu
$wslList = (wsl -l -v) -replace "`0", '' | Where-Object { $_ -match 'Ubuntu' }
if (-not $wslList) { Fail '找不到 Ubuntu。請先執行：wsl --install -d Ubuntu-22.04，重開機後再執行本腳本' }
$line = ($wslList | Select-Object -First 1).Trim().TrimStart('*').Trim()
$parts = $line -split '\s+'
$distro = $parts[0]; $ver = $parts[-1]
if ($ver -ne '2') {
  Warn "$distro 目前是 WSL$ver，轉換為 WSL2（可能需要幾分鐘）"
  wsl --set-version $distro 2
}
Ok "$distro 使用 WSL2"

# 3. .wslconfig（記憶體上限 10GB、mirrored 網路）
$cfgPath = Join-Path $env:USERPROFILE '.wslconfig'
$net = if ($mirrored) { "networkingMode=mirrored`r`ndnsTunneling=true`r`nfirewall=true`r`nautoProxy=true" } else { '' }
$exp = if ($mirrored) { "`r`n[experimental]`r`nautoMemoryReclaim=gradual`r`nhostAddressLoopback=true" } else { "`r`n[experimental]`r`nautoMemoryReclaim=gradual" }
$cfg = "[wsl2]`r`nmemory=10GB`r`nprocessors=6`r`nswap=4GB`r`n$net`r`n$exp`r`n"
if (Test-Path $cfgPath) {
  Copy-Item $cfgPath "$cfgPath.bak" -Force
  Warn "已有 .wslconfig，原檔備份為 .wslconfig.bak"
}
Set-Content -Path $cfgPath -Value $cfg -Encoding ascii
Ok "已寫入 $cfgPath"

# 4. 防火牆：B2 的 DDS 用 UDP 7400-7500
if (-not (Get-NetFirewallRule -DisplayName 'OViiAI DDS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'OViiAI DDS' -Direction Inbound -Protocol UDP -LocalPort 7400-7500 -Action Allow | Out-Null
}
Ok '防火牆已允許 UDP 7400-7500（DDS）'

# 5. Docker Desktop
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Warn 'Docker Desktop 尚未安裝：請到 https://www.docker.com/products/docker-desktop/ 下載安裝'
} else {
  Ok 'Docker Desktop 已安裝'
}
Write-Host ''
Write-Host '請在 Docker Desktop → Settings 確認：' -ForegroundColor Cyan
Write-Host "  1. General → 勾選 Use the WSL 2 based engine"
Write-Host "  2. Resources → WSL integration → 開啟 $distro"

# 6. 套用設定
wsl --shutdown
Ok 'WSL 已重啟以套用 .wslconfig'
Write-Host ''
Write-Host "下一步：開啟 $distro 終端機，執行" -ForegroundColor Cyan
Write-Host '  git clone https://github.com/ecenter3/oviiai.git ~/oviiai && bash ~/oviiai/scripts/setup-wsl.sh'
Write-Host '（repo 是私有的：git 問帳號時輸入 GitHub 帳號，密碼請貼 Personal Access Token）'
