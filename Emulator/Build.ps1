#requires -Version 7
param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Pin = Get-Content (Join-Path $PSScriptRoot 'upstream.json') -Raw | ConvertFrom-Json
$References = Join-Path $Root 'References'
$Tree = Join-Path $References 'pcsx2'
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

if (-not (Test-Path (Join-Path $Tree 'deps\lib\cmake\Qt6'))) {
    if (-not (Test-Path $SevenZip)) { Fail "7-Zip not found at $SevenZip" }
    $Archive = Join-Path $References 'pcsx2-windows-dependencies.7z'
    if (-not (Test-Path $Archive)) { Run curl.exe @('-L', '--fail', '--retry', '3', '-o', $Archive, $Pin.dependencies) }
    Run $SevenZip @('x', '-y', "-o$Tree", $Archive)
    if (-not (Test-Path (Join-Path $Tree 'deps\lib\cmake\Qt6'))) {
        Fail "dependency archive did not produce References/pcsx2/deps/lib/cmake/Qt6"
    }
}

Copy-Item (Join-Path $PSScriptRoot 'DebugServer.cpp') (Join-Path $Tree 'pcsx2\DebugTools\DebugServer.cpp') -Force
Copy-Item (Join-Path $PSScriptRoot 'DebugServer.h') (Join-Path $Tree 'pcsx2\DebugTools\DebugServer.h') -Force

& git -C $Tree apply --reverse --check $Hooks 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host 'hooks already applied'
} else {
    Run git @('-C', $Tree, 'apply', '--check', $Hooks)
    Run git @('-C', $Tree, 'apply', $Hooks)
    Write-Host 'hooks applied'
}

if ($PrepareOnly) { Write-Host 'prepared'; exit 0 }

$Build = Join-Path $Tree 'build'
Run cmake @('-S', $Tree, '-B', $Build, '-G', 'Visual Studio 18 2026', '-A', 'x64', "-DCMAKE_PREFIX_PATH=$(Join-Path $Tree 'deps')")
Run cmake @('--build', $Build, '--config', 'Release', '--target', 'pcsx2-qt', 'pcsx2-gsrunner')

foreach ($Exe in 'pcsx2-qt\Release\pcsx2-qt.exe', 'pcsx2-gsrunner\Release\pcsx2-gsrunner.exe') {
    if (-not (Test-Path (Join-Path $Build $Exe))) { Fail "build finished without $Exe" }
}
Write-Host 'built'
