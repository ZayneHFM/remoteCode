param(
    [string]$Address = '',
    [string]$OutputPath = '',
    [string]$AndroidSdkRoot = '',
    [string]$JavaHome = '',
    [string]$SigningDirectory = ''
)

$ErrorActionPreference = 'Stop'
$defaultUrl = ''
if ($Address) {
    $origin = [Uri]$Address
    if ($origin.Scheme -ne 'https' -or $origin.DnsSafeHost -notmatch '^[a-z0-9.-]+\.ts\.net$' -or $origin.UserInfo -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) {
        throw 'Use the private HTTPS root of the computer panel.'
    }
    $defaultUrl = $origin.AbsoluteUri
}
$project = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $project '.remote-data\android-tools'

function Find-Tool($File) {
    $match = Get-ChildItem -LiteralPath $tools -Recurse -File -Filter $File | Select-Object -First 1
    if (-not $match) { throw "Missing Android build tool: $File" }
    $match.FullName
}

function Run-Tool($Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build step failed: $Command" }
}

if (-not $AndroidSdkRoot) { $AndroidSdkRoot = $env:ANDROID_HOME }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $AndroidSdkRoot -and $env:LOCALAPPDATA) {
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path -LiteralPath $defaultSdk -PathType Container) { $AndroidSdkRoot = $defaultSdk }
}

if ($AndroidSdkRoot) {
    if (-not $JavaHome) { $JavaHome = $env:JAVA_HOME }
    $javac = if ($JavaHome) { Join-Path $JavaHome 'bin\javac.exe' } else { (Get-Command javac.exe -ErrorAction Stop).Source }
    $javaBin = Split-Path -Parent $javac
    $java = Join-Path $javaBin 'java.exe'
    $keytool = Join-Path $javaBin 'keytool.exe'
    $platform = Join-Path $AndroidSdkRoot 'platforms\android-35\android.jar'
    $buildToolsRoot = Join-Path $AndroidSdkRoot 'build-tools'
    $buildTools = Get-ChildItem -LiteralPath $buildToolsRoot -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [Version]$_.Name } -Descending |
        Where-Object {
            $folder = $_.FullName
            (Test-Path -LiteralPath (Join-Path $folder 'aapt2.exe')) -and
            (Test-Path -LiteralPath (Join-Path $folder 'zipalign.exe')) -and
            (Test-Path -LiteralPath (Join-Path $folder 'lib\d8.jar')) -and
            (Test-Path -LiteralPath (Join-Path $folder 'lib\apksigner.jar'))
        } | Select-Object -First 1
    if (-not $buildTools) { throw 'Install Android SDK Build-Tools with aapt2, zipalign, d8, and apksigner.' }
    $aapt = Join-Path $buildTools.FullName 'aapt2.exe'
    $zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
    $d8 = Join-Path $buildTools.FullName 'lib\d8.jar'
    $signer = Join-Path $buildTools.FullName 'lib\apksigner.jar'
    $compileCommand = $javac
    $compilePrefix = @()
} elseif (Test-Path -LiteralPath $tools -PathType Container) {
    $java = Find-Tool 'java.exe'
    $keytool = Join-Path (Split-Path -Parent $java) 'keytool.exe'
    $compileCommand = $java
    $compilePrefix = @('-jar', (Find-Tool 'ecj.jar'))
    $platform = Find-Tool 'android.jar'
    $aapt = Find-Tool 'aapt2.exe'
    $zipalign = Find-Tool 'zipalign.exe'
    $d8 = Find-Tool 'd8.jar'
    $signer = Find-Tool 'apksigner.jar'
} else {
    throw 'Install the Android SDK and set ANDROID_HOME or pass -AndroidSdkRoot.'
}
foreach ($file in @($java, $keytool, $compileCommand, $platform, $aapt, $zipalign, $d8, $signer)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing Android build tool or platform: $file" }
}
$keys = if ($SigningDirectory) { [IO.Path]::GetFullPath($SigningDirectory) } else { Join-Path $env:LOCALAPPDATA 'remoteCode\AndroidSigning' }
$null = [IO.Directory]::CreateDirectory($keys)
$keystore = Join-Path $keys 'panel.p12'
$passwordFile = Join-Path $keys 'key-password.dpapi'
$apk = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $project '安装包\PersonalRemotePanel.apk' }
$previousKeyPassword = $env:REMOTE_APK_KEY_PASSWORD
$build = Join-Path ([IO.Path]::GetTempPath()) ('personal-remote-panel-build-' + [Guid]::NewGuid().ToString('N'))
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
$sources = Join-Path $build 'src'
foreach ($folder in @($build, $classes, $dex, $sources)) { $null = [IO.Directory]::CreateDirectory($folder) }

try {
    $androidJar = Join-Path $build 'android.jar'
    Copy-Item -LiteralPath $platform -Destination $androidJar
    $manifest = Join-Path $build 'AndroidManifest.xml'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Destination $manifest
    $res = Join-Path $build 'res'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'res') -Destination $res -Recurse
    $activity = Join-Path $sources 'MainActivity.java'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src\local\personal\remotepanel\MainActivity.java') -Destination $activity
    $addressFile = Join-Path $sources 'PanelAddress.java'
    $source = 'package local.personal.remotepanel; final class PanelAddress { static final String URL = "' + $defaultUrl + '"; }'
    [IO.File]::WriteAllText($addressFile, $source, [Text.UTF8Encoding]::new($false))
    $compiled = Join-Path $build 'resources.zip'
    $unsigned = Join-Path $build 'unsigned.apk'
    $aligned = Join-Path $build 'aligned.apk'
    $signed = Join-Path $build 'signed.apk'

    Run-Tool $aapt @('compile','--dir',$res,'-o',$compiled)
    Run-Tool $aapt @('link','-I',$androidJar,'--manifest',$manifest,'-o',$unsigned,$compiled)
    Run-Tool $compileCommand ($compilePrefix + @('-source','8','-target','8','-encoding','UTF-8','-proc:none','-bootclasspath',$androidJar,'-d',$classes,$activity,$addressFile))
    $compiledClasses = @(Get-ChildItem -LiteralPath $classes -Recurse -File -Filter '*.class' | ForEach-Object FullName)
    Run-Tool $java (@('-cp',$d8,'com.android.tools.r8.D8','--release','--min-api','26','--lib',$androidJar,'--output',$dex) + $compiledClasses)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($unsigned, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $dex 'classes.dex'), 'classes.dex')
    } finally { $archive.Dispose() }
    Run-Tool $zipalign @('-f','4',$unsigned,$aligned)

    if (-not (Test-Path -LiteralPath $passwordFile)) {
        $random = [byte[]]::new(32)
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($random) } finally { $generator.Dispose() }
        $password = ConvertTo-SecureString ([Convert]::ToBase64String($random)) -AsPlainText -Force
        try { [IO.File]::WriteAllText($passwordFile, (ConvertFrom-SecureString $password)) }
        finally { $password.Dispose() }
    }
    $password = ConvertTo-SecureString ([IO.File]::ReadAllText($passwordFile))
    try { $env:REMOTE_APK_KEY_PASSWORD = [Net.NetworkCredential]::new('', $password).Password }
    finally { $password.Dispose() }
    if (-not (Test-Path -LiteralPath $keystore)) {
        Run-Tool $keytool @('-genkeypair','-keystore',$keystore,'-storetype','PKCS12','-storepass:env','REMOTE_APK_KEY_PASSWORD','-alias','panel','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=remoteCode')
    }
    Run-Tool $java @('-jar',$signer,'sign','--ks',$keystore,'--ks-key-alias','panel','--ks-pass','env:REMOTE_APK_KEY_PASSWORD','--out',$signed,$aligned)
    Run-Tool $java @('-jar',$signer,'verify','--verbose',$signed)
    $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $apk))
    Copy-Item -LiteralPath $signed -Destination $apk -Force
    Get-FileHash -LiteralPath $apk -Algorithm SHA256
} finally {
    $env:REMOTE_APK_KEY_PASSWORD = $previousKeyPassword
    $absoluteBuild = (Resolve-Path -LiteralPath $build).Path
    $prefix = Join-Path ([IO.Path]::GetTempPath()) 'personal-remote-panel-build-'
    if ($absoluteBuild -eq $build -and $absoluteBuild.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $absoluteBuild -Recurse -Force
    }
}
