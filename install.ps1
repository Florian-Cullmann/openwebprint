param(
    [ValidateSet('install', 'start', 'stop', 'status', 'open', 'uninstall')]
    [string]$Action = 'install',
    [string]$Version = $env:OPENWEBPRINT_VERSION,
    [string]$Root,
    [ValidateRange(1024, 65535)][int]$Port,
    [switch]$NoOpen,
    [switch]$NoAutostart
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Use install.sh on Linux or macOS.' }
$arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($arch -notin @('x64', 'arm64')) { throw 'Supported processors: x64 and arm64.' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows 10 1803 or later with tar.exe is required.' }
if (-not $Version) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/Florian-Cullmann/openwebprint/releases/latest'
    $Version = $release.tag_name
}
if ($Version -notmatch '^v[0-9][a-zA-Z0-9.-]*$') { throw 'Invalid release tag. Use a tag such as v0.1.0.' }
$base = "https://github.com/Florian-Cullmann/openwebprint/releases/download/$Version"
$name = "openwebprint-win32-$arch"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    Write-Host "Downloading openwebprint $Version for Windows/$arch..."
    $archive = Join-Path $temporary "$name.tar.gz"
    Invoke-WebRequest -UseBasicParsing "$base/$name.tar.gz" -OutFile $archive
    $checksumFile = Join-Path $temporary 'checksum'
    Invoke-WebRequest -UseBasicParsing "$base/$name.tar.gz.sha256" -OutFile $checksumFile
    $expected = ((Get-Content -LiteralPath $checksumFile -TotalCount 1) -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw 'Checksum mismatch. The package was not installed.'
    }
    & tar.exe -xzf $archive -C $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the release.' }
    $package = Join-Path $temporary $name
    $arguments = @((Join-Path $package 'scripts/install/manage.mjs'), $Action)
    if ($Root) { $arguments += @('--root', $Root) }
    if ($Port) { $arguments += @('--port', $Port.ToString()) }
    if ($NoOpen) { $arguments += '--no-open' }
    if ($NoAutostart) { $arguments += '--no-autostart' }
    & (Join-Path $package 'runtime/node.exe') @arguments
    if ($LASTEXITCODE -ne 0) { throw 'openwebprint setup failed. See the message above.' }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
