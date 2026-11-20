param([ValidateRange(1, 65535)][int]$Port = 8788, [ValidateRange(1, 65535)][int]$HttpsPort = 8443)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '远程任务面板 · 手机连接'
$installDir = Join-Path $env:ProgramFiles 'Tailscale'
$cli = Join-Path $installDir 'tailscale.exe'
$data = Join-Path $env:LOCALAPPDATA 'RemoteTaskPanel\Tailscale'
$addressFile = Join-Path $PSScriptRoot ".remote-data\phone-url-$Port.txt"
$cliOptions = @()
$daemon = $null
$login = $null
$loginFiles = @()
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sessionLock = [Threading.Mutex]::new($false, "Local\RemoteTaskPanelPhone-$currentUser-$HttpsPort")
$hasLock = $false

function Read-TailscaleStatus {
    $ErrorActionPreference = 'SilentlyContinue'
    $json = (& $cli @cliOptions status --json --peers=false 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $json) { return $json | ConvertFrom-Json }
}

function Save-PhoneAddress([string]$Address) {
    $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $addressFile))
    [IO.File]::WriteAllText($addressFile, $Address)
    Write-Host "手机地址  $Address"
}

try {
    try { $hasLock = $sessionLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasLock = $true }
    if (-not $hasLock) { return }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw '找不到电脑端的 Tailscale。' }

    $panel = Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -UseBasicParsing -TimeoutSec 3
    if (-not $panel.Content.Contains('id="task-form"')) { throw '本地端口上没有找到远程任务面板。' }

    Write-Host '正在准备手机访问。'
    $status = Read-TailscaleStatus
    $userspace = -not $status.BackendState
    if ($userspace) {
        Write-Host 'Tailscale 系统后台不可用，正在启动本面板专用的用户空间连接。'
        $pipe = '\\.\pipe\remote-task-panel-tailscale-' + $currentUser
        $cliOptions = @("--socket=$pipe")
        $status = Read-TailscaleStatus
        if (-not $status.BackendState) {
            $null = [IO.Directory]::CreateDirectory($data)
            $daemonArgs = @('--windows-mode=dev','--tun=userspace-networking','--port=0',"--socket=$pipe",('--statedir="' + $data + '"'))
            $daemon = Start-Process -FilePath (Join-Path $installDir 'tailscaled.exe') -ArgumentList $daemonArgs `
                -RedirectStandardError (Join-Path $data 'daemon.log') -WindowStyle Hidden -PassThru
            $deadline = [DateTime]::UtcNow.AddSeconds(18)
            do {
                Start-Sleep -Milliseconds 400
                $status = Read-TailscaleStatus
            } until ($status.BackendState -or $daemon.HasExited -or [DateTime]::UtcNow -ge $deadline)
            if (-not $status.BackendState) { throw 'Tailscale 用户空间后台启动失败。' }
        }
    }

    if ($status.BackendState -ne 'Running') {
        Write-Host '请在浏览器登录 Tailscale。手机安装后也使用同一个账号。'
        $loginArgs = $cliOptions + @('up','--timeout=20m')
        if ($userspace -and $status.BackendState -eq 'NeedsLogin' -and -not $status.AuthURL) { $loginArgs += '--force-reauth' }
        $null = [IO.Directory]::CreateDirectory($data)
        $loginId = [Guid]::NewGuid().ToString('N')
        $loginFiles = @((Join-Path $data "$loginId.stdout"), (Join-Path $data "$loginId.stderr"))
        $login = Start-Process -FilePath $cli -ArgumentList $loginArgs -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $loginFiles[0] -RedirectStandardError $loginFiles[1]
        $loginDeadline = [DateTime]::UtcNow.AddMinutes(20)
        $opened = ''
        do {
            $message = Get-Content -LiteralPath $loginFiles -Raw -ErrorAction SilentlyContinue
            $candidate = [regex]::Match(($message -join "`n"), 'https://login\.tailscale\.com/a/[a-zA-Z0-9]+').Value
            if ($status.AuthURL -match '^https://login\.tailscale\.com/a/[a-zA-Z0-9]+(?:[/?#][^\s]*)?$') { $candidate = $status.AuthURL }
            if ($candidate -and $candidate -ne $opened) {
                $opened = $candidate
                try { Start-Process $opened } catch { Write-Host '请打开下面的 Tailscale 登录链接。'; Write-Host $opened }
                Write-Host '等待浏览器授权。'
            }
            Start-Sleep -Seconds 2
            $status = Read-TailscaleStatus
            $loginFailed = $login.HasExited -and $login.ExitCode -ne 0 -and -not $opened
        } until ($status.BackendState -eq 'Running' -or $loginFailed -or [DateTime]::UtcNow -ge $loginDeadline)
        if ($status.BackendState -ne 'Running') { throw 'Tailscale 登录未完成，请重开面板后再试。' }
    }

    $serve = (& $cli @cliOptions serve status --json | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw '无法读取 Tailscale Serve 状态。' }
    $hostname = ($status.Self.DNSName -as [string]).TrimEnd('.')
    if ($hostname -notmatch '^[a-z0-9.-]+\.ts\.net$') { throw 'Tailscale 没有可用的设备域名，请确认已启用 MagicDNS。' }
    $listener = "${hostname}:$HttpsPort"
    $target = "http://127.0.0.1:$Port"
    $address = "https://$listener/"
    $config = $serve | ConvertFrom-Json
    $scopes = @($config)
    if ($config.Foreground) { $scopes += $config.Foreground.PSObject.Properties.Value }
    foreach ($scope in $scopes) {
        $web = if ($scope.Web) { $scope.Web.PSObject.Properties[$listener] }
        $tcp = if ($scope.TCP) { $scope.TCP.PSObject.Properties[[string]$HttpsPort] }
        $public = if ($scope.AllowFunnel) { $scope.AllowFunnel.PSObject.Properties[$listener] }
        if ($public.Value) { throw '所选 HTTPS 端口已有公网共享规则，请改用另一个私有端口。' }
        if (-not $web -and -not $tcp) { continue }
        if ($web.Value.Handlers.'/'.Proxy -eq $target) {
            Save-PhoneAddress $address
            return
        }
        throw '所选 HTTPS 端口已有其他共享规则。'
    }

    Write-Host '手机打开接下来显示的 HTTPS 地址。首次可能会提示在浏览器启用 HTTPS。'
    if ($userspace) {
        Save-PhoneAddress $address
        & $cli @cliOptions serve "--https=$HttpsPort" $target
        $serveExitCode = $LASTEXITCODE
    } else {
        Write-Host '如果 Windows 弹出管理员确认，请选“是”。'
        $relayArgs = @('serve','--bg',"--https=$HttpsPort",$target)
        $relay = Start-Process -FilePath $cli -ArgumentList $relayArgs -Verb RunAs -WindowStyle Normal -PassThru -Wait
        $serveExitCode = $relay.ExitCode
    }
    if ($serveExitCode -ne 0) { throw 'Tailscale Serve 启动失败，请查看上面的提示。' }
    if (-not $userspace) { Save-PhoneAddress $address }
} catch {
    Write-Host $_.Exception.Message
    $null = Read-Host '按回车关闭这个窗口'
} finally {
    if ($null -ne $login -and -not $login.HasExited) { $login.Kill() }
    if ($null -ne $daemon -and -not $daemon.HasExited) { $daemon.Kill() }
    foreach ($file in $loginFiles) { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
    if ($hasLock) { $sessionLock.ReleaseMutex() }
    $sessionLock.Dispose()
}
