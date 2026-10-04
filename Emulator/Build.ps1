#requires -Version 7
# -Tree, -BuildDir, -Deps build a second emulator beside the first: another PCSX2 checkout at the
# pinned commit, its own build directory, and the dependencies of the first tree.
param([switch]$PrepareOnly, [string]$Tree, [string]$BuildDir, [string]$Deps)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Pin = Get-Content (Join-Path $PSScriptRoot 'upstream.json') -Raw | ConvertFrom-Json
$References = if ($env:WATSON_REFERENCES) { $env:WATSON_REFERENCES } else { Join-Path $Root 'References' }
if (-not $Tree) { $Tree = Join-Path $References 'pcsx2' }
if (-not $Deps) { $Deps = Join-Path $Tree 'deps' }
$Hooks = Join-Path $PSScriptRoot 'hooks.patch'
$SevenZip = 'C:\Program Files\7-Zip\7z.exe'

function Fail([string]$Reason) { Write-Host "Build.ps1: $Reason"; exit 1 }
function Run([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$Exe $($Arguments -join ' ') exited $LASTEXITCODE" }
}

New-Item -ItemType Directory -Force $References | Out-Null

if (-not (Test-Path (Join-Path $Tree '.git'))) {
    Run git @('clone', '--depth', '1', '--branch', $Pin.tag, '-c', 'core.autocrlf=false', $Pin.repository, $Tree)
}
$Head = (& git -C $Tree rev-parse HEAD).Trim()
if ($Head -ne $Pin.commit) { Fail "References/pcsx2 is at $Head, upstream.json pins $($Pin.commit)" }

if (-not (Test-Path (Join-Path $Deps 'lib\cmake\Qt6'))) {
    if (-not (Test-Path $SevenZip)) { Fail "7-Zip not found at $SevenZip" }
    $Archive = Join-Path $References 'pcsx2-windows-dependencies.7z'
    if (-not (Test-Path $Archive)) { Run curl.exe @('-L', '--fail', '--retry', '3', '-o', $Archive, $Pin.dependencies) }
    Run $SevenZip @('x', '-y', "-o$Tree", $Archive)
    if (-not (Test-Path (Join-Path $Tree 'deps\lib\cmake\Qt6'))) {
        Fail "dependency archive did not produce References/pcsx2/deps/lib/cmake/Qt6"
    }
}

foreach ($Name in 'DebugServer.cpp', 'DebugServer.h', 'GifTrace.cpp', 'GifTrace.h', 'SpuTrace.cpp', 'SpuTrace.h') {
    # Copy-Item keeps the source's time, which may be older than the objects built from the last copy:
    # a changed file is copied and stamped now, so the build sees it.
    $From = Join-Path $PSScriptRoot $Name
    $To = Join-Path $Tree "pcsx2\DebugTools\$Name"
    if (-not (Test-Path $To) -or (Get-FileHash $From).Hash -ne (Get-FileHash $To).Hash) {
        Copy-Item $From $To -Force
        (Get-Item $To).LastWriteTime = Get-Date
    }
}

& git -C $Tree apply --reverse --check $Hooks 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host 'hooks already applied'
} else {
    # The tree may carry an older version of the hooks: put every hooked file back first.
    $Hooked = @(& git -C $Tree apply --numstat $Hooks | ForEach-Object { ($_ -split "`t")[2] })
    if ($Hooked.Count -eq 0) { Fail 'hooks.patch names no file' }
    Run git (@('-C', $Tree, 'checkout', '--') + $Hooked)
    Run git @('-C', $Tree, 'apply', $Hooks)
    Write-Host 'hooks applied'
}

if ($PrepareOnly) { Write-Host 'prepared'; exit 0 }

$Build = if ($BuildDir) { $BuildDir } else { Join-Path $Tree 'build' }
Run cmake @('-S', $Tree, '-B', $Build, '-G', 'Visual Studio 18 2026', '-A', 'x64', '-DENABLE_GSRUNNER=ON', "-DCMAKE_PREFIX_PATH=$Deps")
Run cmake @('--build', $Build, '--config', 'Release', '--target', 'pcsx2-qt', 'pcsx2-gsrunner')

foreach ($Exe in 'pcsx2-qt\Release\pcsx2-qt.exe', 'pcsx2-gsrunner\Release\pcsx2-gsrunner.exe') {
    if (-not (Test-Path (Join-Path $Build $Exe))) { Fail "build finished without $Exe" }
}
Write-Host 'built'
