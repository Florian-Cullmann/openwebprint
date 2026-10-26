param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Manager,
    [switch]$Remove,
    [switch]$NoAutostart
)
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'openwebprint.lnk'
$login = Join-Path ([Environment]::GetFolderPath('Startup')) 'openwebprint.lnk'
foreach ($item in @(@($menu, 'open'), @($login, 'start'))) {
    $path, $command = $item
    if ($Remove -or ($command -eq 'start' -and $NoAutostart)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        continue
    }
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $Node
    $shortcut.Arguments = '"{0}" --root "{1}" {2}' -f $Manager, $Root, $command
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Print and scan in your browser'
    $shortcut.Save()
}
