param([switch]$EnableDeepSeek)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '我的远程面板 · 电脑端'
$port = 8788
if ($env:REMOTE_PORT) {
    if (-not [int]::TryParse($env:REMOTE_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        Write-Host 'REMOTE_PORT 必须是 1 到 65535 之间的端口。'
        exit 1
    }
}
$panelUrl = "http://127.0.0.1:$port"
$panelProcess = $null

function Test-LocalPanel {
    try {
        $page = Invoke-WebRequest -Uri $panelUrl -UseBasicParsing -TimeoutSec 2
        return $page.StatusCode -eq 200 -and $page.Content.Contains('name="remote-panel-version" content="2"')
    } catch {
        return $false
    }
}

function Start-PhoneAccess {
    $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
        Write-Host '电脑端面板可用。装好 Windows 版 Tailscale 后，再双击启动入口即可连接手机。'
        return
    }

    $script = Join-Path $PSScriptRoot 'connect-phone.ps1'
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',('"' + $script + '"'),'-Port',[string]$port)
    Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Normal
}

try {
    if (Test-LocalPanel) {
        if ($EnableDeepSeek) { throw '请先关闭原来打开的面板窗口，再双击“启用DeepSeek并启动”。' }
        Write-Host '检测到面板已启动。请用原面板窗口里的连接码登录。'
    } else {
        $node = Join-Path $PSScriptRoot 'runtime\node.exe'
        if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
            $node = (Get-Command node.exe -ErrorAction Stop).Source
        }
        if ($EnableDeepSeek) {
            $previousKey = $env:DEEPSEEK_API_KEY
            $previousHarness = $env:REMOTE_DSH_EXE
            try {
                $secret = Read-Host '粘贴 DeepSeek API Key' -AsSecureString
                $env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
                if (-not $env:DEEPSEEK_API_KEY) { throw '请输入 DeepSeek 开放平台创建的 API Key。' }
                if ((Read-Host 'DeepSeek Harness 安装在自定义目录？输入 Y 选择程序，或回车自动查找') -eq 'Y') {
                    Add-Type -AssemblyName System.Windows.Forms
                    $picker = [Windows.Forms.OpenFileDialog]::new()
                    try {
                        $picker.Title = '选择 DeepSeek Harness.exe'
                        $picker.Filter = 'DeepSeek Harness|DeepSeek Harness.exe'
                        if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { throw '请先选择 DeepSeek Harness.exe。' }
                        $env:REMOTE_DSH_EXE = $picker.FileName
                    } finally { $picker.Dispose() }
                }
                & (Join-Path $PSScriptRoot 'desktop-panel.ps1')
            } finally {
                $env:DEEPSEEK_API_KEY = $previousKey
                $env:REMOTE_DSH_EXE = $previousHarness
                if ($null -ne $secret) { $secret.Dispose() }
            }
            return
        }
        $panelProcess = Start-Process -FilePath $node -ArgumentList 'server.mjs' `
            -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru

        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-LocalPanel)) {
            if ($panelProcess.HasExited -or [DateTime]::UtcNow -ge $deadline) {
                throw "面板无法在端口 $port 启动，请查看上面的报错。"
            }
            Start-Sleep -Milliseconds 200
        }
    }

    try { Start-Process $panelUrl } catch { Write-Host "请在电脑浏览器打开 $panelUrl" }
    try { Start-PhoneAccess } catch { Write-Host "手机连接尚未启动。$($_.Exception.Message)" }
    if ($null -ne $panelProcess) {
        while (-not $panelProcess.WaitForExit(500)) { }
        exit $panelProcess.ExitCode
    }
} catch {
    Write-Host $_.Exception.Message
    exit 1
} finally {
    if ($null -ne $panelProcess -and -not $panelProcess.HasExited) { $panelProcess.Kill() }
}
