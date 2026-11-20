$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Net.Http
Add-Type -Path (Join-Path $PSScriptRoot 'desktop-ui.cs') -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll')
[RemoteCode.Desktop.DpiMode]::Enable()
[Windows.Forms.Application]::EnableVisualStyles()

$sessionName = 'Local\PersonalRemotePanelDesktop-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [Threading.Mutex]::new($false, $sessionName)
$wake = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, "$sessionName-Show")
try { $ownWindow = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownWindow = $true }
if (-not $ownWindow) {
    $null = $wake.Set()
    $wake.Dispose()
    $mutex.Dispose()
    return
}

$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$port = 8788
if ($env:REMOTE_PORT) {
    if (-not [int]::TryParse($env:REMOTE_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        $null = [Windows.Forms.MessageBox]::Show('REMOTE_PORT 必须是 1 到 65535 之间的端口。', 'remoteCode')
        return
    }
}
$addressFile = Join-Path $PSScriptRoot ".remote-data\phone-url-$port.txt"
$state = @{
    Child = $null; Line = $null; Errors = $null; Ready = $false; Closing = $false; Action = ''
    StartFailed = $false; PhoneReachable = $null
    Probe = $null; NextProbe = [datetime]::MinValue; NextStatus = [datetime]::MinValue
    PhoneUrl = ''; Discovery = $null; DiscoveryOutput = $null; NextDiscovery = [datetime]::MinValue
}
$http = [Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromSeconds(5)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-LocalVersionMarker {
    $index = Join-Path $PSScriptRoot 'public\index.html'
    try {
        $html = [string](Get-Content -LiteralPath $index -Raw -ErrorAction Stop)
    } catch {
        return $null
    }
    if (-not $html) { return $null }
    $found = [regex]::Match($html, 'name="remote-panel-version"\s+content="[^"]+"')
    if (-not $found.Success -or -not $found.Value) { return $null }
    return $found.Value
}
$versionMarker = Get-LocalVersionMarker

$form = [Windows.Forms.Form]::new()
$form.SuspendLayout()
$form.Text = 'remoteCode'
$form.StartPosition = 'CenterScreen'
$form.AutoScaleMode = 'None'
$form.ClientSize = [Drawing.Size]::new(620, 322)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.BackColor = [Drawing.Color]::FromArgb(245, 244, 241)
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10)

$ink = [Drawing.Color]::FromArgb(28, 30, 33)
$muted = [Drawing.Color]::FromArgb(91, 96, 107)
$accent = [Drawing.Color]::FromArgb(79, 70, 229)
$soft = [Drawing.Color]::FromArgb(237, 235, 251)
$paper = [Drawing.Color]::White

function New-Label($Parent, $Text, [int]$X, [int]$Y, [int]$Width, [int]$Height) {
    $label = [Windows.Forms.Label]::new()
    $label.Text = $Text
    $label.SetBounds($X, $Y, $Width, $Height)
    $label.ForeColor = $ink
    $label.BackColor = [Drawing.Color]::Transparent
    $Parent.Controls.Add($label)
    $label
}

function New-Button($Parent, $Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [bool]$Primary = $false) {
    $button = [RemoteCode.Desktop.RoundedButton]::new()
    $button.Text = $Text
    $button.SetBounds($X, $Y, $Width, $Height)
    $button.UseVisualStyleBackColor = $false
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderSize = 0
    $button.BackColor = if ($Parent -is [RemoteCode.Desktop.RoundedCard]) { $Parent.FillColor } else { $Parent.BackColor }
    $button.Cursor = [Windows.Forms.Cursors]::Hand
    $button.FillColor = if ($Primary) { $accent } else { $soft }
    $button.ForeColor = if ($Primary) { $paper } else { $accent }
    $button.HoverColor = if ($Primary) { [Drawing.Color]::FromArgb(67, 56, 202) } else { [Drawing.Color]::FromArgb(228, 224, 249) }
    $button.PressedColor = if ($Primary) { [Drawing.Color]::FromArgb(55, 48, 163) } else { [Drawing.Color]::FromArgb(220, 215, 246) }
    $Parent.Controls.Add($button)
    $button
}

function New-Card([int]$Top, [int]$Height) {
    $card = [RemoteCode.Desktop.RoundedCard]::new()
    $card.SetBounds(28, $Top, 564, $Height)
    $card.FillColor = $paper
    $form.Controls.Add($card)
    $card
}

$title = New-Label $form 'remoteCode' 28 20 560 46
$title.Font = [Drawing.Font]::new('Segoe UI', 24, [Drawing.FontStyle]::Bold)
$status = New-Label $form '正在启动…' 30 72 560 23
$status.ForeColor = $muted

$addressCard = New-Card 105 104
$addressTitle = New-Label $addressCard '手机访问地址' 16 13 408 22
$addressTitle.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10, [Drawing.FontStyle]::Bold)
$phoneAddress = [Windows.Forms.TextBox]::new()
$phoneAddress.SetBounds(16, 51, 401, 25)
$phoneAddress.BorderStyle = 'None'
$phoneAddress.BackColor = $paper
$phoneAddress.ForeColor = $ink
$phoneAddress.Font = [Drawing.Font]::new('Consolas', 9)
$phoneAddress.ReadOnly = $true
$phoneAddress.TabStop = $false
$phoneAddress.AccessibleName = '手机访问地址'
$phoneAddress.Visible = $false
$addressCard.Controls.Add($phoneAddress)
$addressEmpty = New-Label $addressCard '让手机和电脑加入同一个 Tailscale 网络。' 16 50 404 38
$addressEmpty.ForeColor = $muted
$copyAddress = New-Button $addressCard '复制地址' 427 41 120 38
$repair = New-Button $addressCard '连接手机' 427 41 120 38 $true
$copyAddress.Visible = $false
$repair.Visible = $false

$web = New-Button $form '打开面板' 28 228 130 40 $true
$pairToggle = New-Button $form '连接新设备' 168 228 132 40
$download = New-Button $form '下载 Android' 442 228 150 40
$restart = New-Button $form '重试启动' 28 228 130 40 $true
foreach ($button in @($web, $pairToggle, $download, $restart)) { $button.Visible = $false }
$notice = New-Label $form '' 30 279 558 22
$notice.ForeColor = $muted

$pairCard = New-Card 306 139
$pairTitle = New-Label $pairCard '新设备配对码' 16 11 385 22
$pairTitle.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10, [Drawing.FontStyle]::Bold)
$pairLabel = New-Label $pairCard '—' 16 38 265 52
$pairLabel.Font = [Drawing.Font]::new('Consolas', 28, [Drawing.FontStyle]::Bold)
$pairLabel.AccessibleName = '手机配对码'
$copy = New-Button $pairCard '复制配对码' 306 47 130 36 $true
$rotate = New-Button $pairCard '更新配对码' 445 47 102 36
$hint = New-Label $pairCard '首次打开面板时输入这组数字。' 16 96 532 28
$hint.ForeColor = $muted
$pairCard.Visible = $false

function Resize-DesktopWindow([bool]$Expanded) {
    $bottom = if ($Expanded) { $pairCard.Bottom } else { $notice.Bottom }
    $form.ClientSize = [Drawing.Size]::new($form.ClientSize.Width, $bottom + $notice.Height)
}

function Set-PairingExpanded([bool]$Expanded) {
    $pairCard.Visible = $Expanded
    $pairToggle.Text = if ($Expanded) { '收起配对码' } else { '连接新设备' }
    Resize-DesktopWindow $Expanded
}

function Update-Buttons {
    $ready = $state.Ready
    $hasAddress = [bool]$state.PhoneUrl
    $needsConnection = $ready -and -not $hasAddress
    $hasPin = $ready -and ($pairLabel.Text -match '^[0-9]{8}$')
    $copy.Enabled = $hasPin
    $rotate.Enabled = $hasPin
    $web.Visible = $ready
    $pairToggle.Visible = $ready
    $phoneAddress.Visible = $hasAddress
    $addressEmpty.Visible = -not $hasAddress
    $copyAddress.Visible = $ready -and $hasAddress -and -not $needsConnection
    $repair.Visible = $needsConnection
    $download.Visible = $ready -and (
        (Test-Path -LiteralPath (Join-Path $PSScriptRoot '安装包\remoteCode-1.1.1.apk')) -or
        (Test-Path -LiteralPath (Join-Path $PSScriptRoot '安装包\PersonalRemotePanel.apk')) -or
        (Test-Path -LiteralPath (Join-Path $PSScriptRoot '安装包\PersonalRemotePanel-Codex-v1.apk')) -or
        (Test-Path -LiteralPath (Join-Path $PSScriptRoot '安装包\PersonalRemotePanel-Codex-v1.1.apk')))
    $restart.Visible = $state.StartFailed -and $state.Action -eq ''
    if (-not $ready -and $pairCard.Visible) { Set-PairingExpanded $false }
}

$layoutWidth = $form.ClientSize.Width
$layout = foreach ($parent in @($form, $addressCard, $pairCard)) {
    foreach ($control in $parent.Controls) {
        @{ Control = $control; Bounds = $control.Bounds }
    }
}

function Set-DesktopScale([int]$Dpi) {
    # Scale the original bounds, including controls hidden until pairing or startup finishes.
    $scale = $Dpi / 96.0
    $form.SuspendLayout()
    try {
        foreach ($item in $layout) {
            $bounds = $item.Bounds
            $item.Control.SetBounds(
                [int]($bounds.X * $scale), [int]($bounds.Y * $scale),
                [int]($bounds.Width * $scale), [int]($bounds.Height * $scale))
        }
        $form.ClientSize = [Drawing.Size]::new([int]($layoutWidth * $scale), $form.ClientSize.Height)
        Resize-DesktopWindow $pairCard.Visible
    } finally { $form.ResumeLayout($true) }
}

$form.ResumeLayout($false)
Set-DesktopScale ([RemoteCode.Desktop.DpiMode]::ForWindow($form))
$form.Add_DpiChanged({
    param($sender, $event)
    $event.Cancel = $true
    $sender.Location = $event.SuggestedRectangle.Location
    Set-DesktopScale $event.DeviceDpiNew
})

function Start-Panel {
    $state.Ready = $false
    $state.StartFailed = $false
    $state.PhoneReachable = $null
    $status.Text = '正在启动…'
    Update-Buttons
    $state.Action = ''
    $state.NextProbe = [datetime]::MinValue
    $state.NextStatus = [datetime]::MinValue
    $state.Probe = $null
    $pairLabel.Text = '—'
    $status.Text = '正在启动电脑端…'
    Update-Buttons
    try {
        $node = Join-Path $PSScriptRoot 'runtime\node.exe'
        if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
            $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) {
            $state.StartFailed = $true
            $status.Text = '未找到 Node.js。安装后可以重试。'
            Update-Buttons
            return
        }
        $node = $nodeCommand.Source
        }
        $start = [Diagnostics.ProcessStartInfo]::new($node, 'server.mjs --desktop')
        $start.WorkingDirectory = $PSScriptRoot
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = [Text.Encoding]::UTF8
        $start.StandardErrorEncoding = [Text.Encoding]::UTF8
        $start.EnvironmentVariables['REMOTE_PORT'] = [string]$port
        $state.Child = [Diagnostics.Process]::Start($start)
        $state.Line = $state.Child.StandardOutput.ReadLineAsync()
        $state.Errors = $state.Child.StandardError.ReadToEndAsync()
    } catch {
        $state.Child = $null
        $state.StartFailed = $true
        $status.Text = 'remoteCode 启动失败。'
        Update-Buttons
    }
}

function Set-PhoneAddress([string]$Url) {
    if ($Url -notmatch '^https://[a-z0-9.-]+\.ts\.net:8443/$') { $Url = '' }
    if ($Url -eq $state.PhoneUrl) { return }
    $state.PhoneUrl = $Url
    $state.PhoneReachable = $null
    $phoneAddress.Text = $Url
    $state.NextProbe = [datetime]::MinValue
    $status.Text = if ($Url) { '电脑在线 · 手机地址已就绪' } else { '电脑在线 · 手机尚未连接' }
    Update-Buttons
}

function Update-PhoneAddress([datetime]$Now) {
    if ($state.Discovery) {
        if (-not $state.DiscoveryOutput.IsCompleted -and $Now -lt $state.NextDiscovery) { return }
        $url = ''
        try {
            if ($state.DiscoveryOutput.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion) {
                $tsStatus = $state.DiscoveryOutput.Result | ConvertFrom-Json
                if ($tsStatus.BackendState -eq 'Running' -and $tsStatus.Self.DNSName) {
                    $hostname = ([string]$tsStatus.Self.DNSName).TrimEnd('.')
                    $url = "https://${hostname}:8443/"
                }
            }
        } catch {
            $url = ''
        } finally {
            if (-not $state.Discovery.HasExited) { $state.Discovery.Kill() }
            $state.Discovery.Dispose()
            $state.Discovery = $null
            $state.DiscoveryOutput = $null
            $state.NextDiscovery = $Now.AddSeconds(6)
        }
        if (-not $url -and (Test-Path -LiteralPath $addressFile -PathType Leaf)) {
            $url = [string](Get-Content -LiteralPath $addressFile -TotalCount 1 -ErrorAction SilentlyContinue)
        }
        Set-PhoneAddress $url
        if (-not $state.PhoneUrl) { $status.Text = '电脑端已启动 · 请点“连接手机网络”' }
        return
    }
    if ($Now -lt $state.NextDiscovery) { return }
    $state.NextDiscovery = $Now.AddSeconds(5)
    if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
        Set-PhoneAddress ''
        $status.Text = '电脑端已启动 · 点“连接手机网络”安装 Tailscale'
        return
    }
    try {
        $start = [Diagnostics.ProcessStartInfo]::new($tailscale, 'status --json --peers=false')
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $state.Discovery = [Diagnostics.Process]::Start($start)
        $state.DiscoveryOutput = $state.Discovery.StandardOutput.ReadToEndAsync()
    } catch {
        $status.Text = '电脑端已启动 · 无法读取 Tailscale 状态'
    }
}

function Send-Control($Action) {
    if ($null -eq $state.Child -or $state.Child.HasExited) { return }
    try { $state.Child.StandardInput.WriteLine($Action); $state.Child.StandardInput.Flush() }
    catch { $status.Text = '电脑端连接已断开。' }
}

function Request-Stop($Action) {
    if ($null -eq $state.Child -or $state.Child.HasExited) {
        if ($Action -eq 'restart') { Start-Panel }
        else { $state.Closing = $true; $form.Close() }
        return
    }
    if ($state.Action) { return }
    $state.Action = $Action
    Update-Buttons
    Send-Control 'stop'
}

$copy.Add_Click({ [Windows.Forms.Clipboard]::SetText($pairLabel.Text); $hint.Text = '配对码已复制到剪贴板。' })
$rotate.Add_Click({ Send-Control 'rotate'; $hint.Text = '请在手机输入新配对码。' })
$web.Add_Click({ Start-Process "http://127.0.0.1:$port/" })
$copyAddress.Add_Click({ [Windows.Forms.Clipboard]::SetText($state.PhoneUrl); $notice.Text = '已复制手机地址。' })
$pairToggle.Add_Click({ Set-PairingExpanded (-not $pairCard.Visible) })
$download.Add_Click({ Start-Process "http://127.0.0.1:$port/download/android.apk" })
$repair.Add_Click({
    if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
        Start-Process 'https://tailscale.com/download/windows'
        return
    }
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $script = Join-Path $PSScriptRoot 'connect-phone.ps1'
    Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',('"' + $script + '"'),'-Port',[string]$port) -WindowStyle Normal
})
$restart.Add_Click({ Request-Stop 'restart' })
$form.Add_FormClosing({
    param($sender, $event)
    if ($state.Closing -or $null -eq $state.Child -or $state.Child.HasExited) { return }
    $event.Cancel = $true
    Request-Stop 'close'
})

$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 200
$timer.Add_Tick({
    if ($wake.WaitOne(0)) {
        if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }
        $form.Activate()
    }
    if ($null -eq $state.Child) { return }
    for ($read = 0; $read -lt 12 -and $state.Line -and $state.Line.IsCompleted; $read++) {
        if ($state.Line.IsFaulted) { $state.Line = $null; break }
        $line = $state.Line.Result
        $state.Line = if ($null -ne $line) { $state.Child.StandardOutput.ReadLineAsync() }
        if (-not $line -or -not $line.StartsWith('{')) { continue }
        try { $message = $line | ConvertFrom-Json } catch { continue }
        if ($message.type -eq 'ready') {
            $state.Ready = $true
            $status.Text = '电脑在线 · 正在检查手机连接…'
            Update-Buttons
        }
        if ($message.pin -match '^[0-9]{8}$') { $pairLabel.Text = $message.pin; Update-Buttons }
        if ($message.type -eq 'paired') { $hint.Text = '手机已配对。下次可以直接打开应用。' }
        if ($message.type -eq 'busy') {
            $state.Action = ''
            Update-Buttons
            $null = [Windows.Forms.MessageBox]::Show($form, '有任务正在运行。它完成后就可以重启或关闭。', '我的远程面板')
        }
    }

    if ($state.Child.HasExited) {
        $action = $state.Action
        $errors = if ($state.Errors -and $state.Errors.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion) { $state.Errors.Result }
        $state.Child.Dispose()
        $state.Child = $null
        if ($action -eq 'restart') { Start-Panel; return }
        if ($action -eq 'close') { $state.Closing = $true; $form.Close(); return }
        $state.Ready = $false
        $state.StartFailed = $true
        $pairLabel.Text = '—'
        Update-Buttons
        $status.Text = if ($errors -match 'EADDRINUSE') { '本机端口已被占用。释放端口后重试。' } else { '电脑端已停止。' }
        return
    }
    if (-not $state.Ready -or $state.Action) { return }
    $now = [datetime]::UtcNow
    Update-PhoneAddress $now
    if ($now -ge $state.NextStatus) {
        Send-Control 'status'
        $state.NextStatus = $now.AddSeconds(2)
    }
    if ($state.Probe -and $state.Probe.IsCompleted) {
        $reachable = $false
        if (-not $state.Probe.IsFaulted -and -not $state.Probe.IsCanceled) {
            $response = $state.Probe.Result
            try {
                if ([bool]$versionMarker -and $response.IsSuccessStatusCode) {
                    try {
                        $body = $response.Content.ReadAsStringAsync().Result
                        $reachable = [bool]$body -and $body.Contains($versionMarker)
                    } catch { $reachable = $false }
                }
            }
            finally { $response.Dispose() }
        }
        if ($state.PhoneUrl) {
            $state.PhoneReachable = $reachable
            $status.Text = if ($reachable) { '电脑在线 · 手机可连接' } else { '电脑在线 · 手机地址已就绪' }
            Update-Buttons
        }
        $state.Probe = $null
        $state.NextProbe = $now.AddSeconds(6)
    }
    if ($state.PhoneUrl -and $null -eq $state.Probe -and $now -ge $state.NextProbe) { $state.Probe = $http.GetAsync($state.PhoneUrl) }
})
$form.Add_Shown({ Start-Panel; $timer.Start() })

try { [Windows.Forms.Application]::Run($form) }
finally {
    if ($state.Discovery) {
        if (-not $state.Discovery.HasExited) { $state.Discovery.Kill() }
        $state.Discovery.Dispose()
    }
    $timer.Dispose()
    $http.Dispose()
    $form.Dispose()
    $mutex.ReleaseMutex()
    $wake.Dispose()
    $mutex.Dispose()
}
