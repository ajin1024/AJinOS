$ErrorActionPreference = 'Stop'
$clientRoot = $PSScriptRoot
$electronExe = Join-Path $clientRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) {
    throw 'Electron is missing. Run npm ci and npm run setup:desktop in the client directory first.'
}
$nodeCandidates = @()
if ($env:STUDIO_NODE -and (Test-Path -LiteralPath $env:STUDIO_NODE)) { $nodeCandidates += $env:STUDIO_NODE }
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Programs\agent-autoloop-runtime'
if (Test-Path -LiteralPath $runtimeRoot) {
    Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-v*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object {
            $candidate = Join-Path $_.FullName 'node.exe'
            if (Test-Path -LiteralPath $candidate) { $nodeCandidates += $candidate }
        }
}
$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($pathNode) { $nodeCandidates += $pathNode.Source }
$nodeExe = $null
foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
    try {
        $major = [int]((& $candidate --version).TrimStart('v').Split('.')[0])
        if ($major -ge 24) { $nodeExe = $candidate; break }
    } catch {}
}
if (-not $nodeExe) { throw 'Node.js 24 or newer is required.' }
$env:STUDIO_NODE = $nodeExe
if (-not $env:STUDIO_PORT) { $env:STUDIO_PORT = '3360' }
if (-not $env:STUDIO_HOME) {
    $liveHome = Join-Path $env:USERPROFILE '.agent-autoloop'
    if (Test-Path -LiteralPath (Join-Path $liveHome 'config.json')) {
        $env:STUDIO_HOME = $liveHome
        if (-not $env:STUDIO_CONNECT_ONLY) { $env:STUDIO_CONNECT_ONLY = '1' }
    }
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# The user is launching the interactive desktop application, so show its window.
Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $clientRoot 'desktop-launch.mjs') + '"') -WorkingDirectory $clientRoot -WindowStyle Hidden
