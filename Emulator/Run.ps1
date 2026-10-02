#requires -Version 7
param([string]$Bios)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root 'References\pcsx2\build\pcsx2-qt\Release\pcsx2-qt.exe'
$Runtime = Join-Path $Root 'Runtime'
$Ini = Join-Path $Runtime 'PCSX2\inis\PCSX2.ini'
$Port = 21512

function Fail([string]$Reason) { Write-Host "Run.ps1: $Reason"; exit 1 }

function Set-IniValue([string]$Path, [string]$Section, [string]$Key, [string]$Value) {
    $Lines = [System.Collections.Generic.List[string]](Get-Content $Path)
    $Start = $Lines.IndexOf("[$Section]")
    if ($Start -lt 0) { $Lines.Add("[$Section]"); $Lines.Add("$Key = $Value"); Set-Content $Path $Lines; return }
    $End = $Start + 1
    while ($End -lt $Lines.Count -and -not $Lines[$End].StartsWith('[')) {
        if ($Lines[$End] -match "^\s*$([regex]::Escape($Key))\s*=") { $Lines[$End] = "$Key = $Value"; Set-Content $Path $Lines; return }
        $End++
    }
    $Lines.Insert($Start + 1, "$Key = $Value")
    Set-Content $Path $Lines
}

if (-not (Test-Path $Exe)) { Fail "no build at $Exe; run Emulator/Build.ps1" }

$Holder = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($Holder) {
    $Process = Get-Process -Id $Holder.OwningProcess -ErrorAction SilentlyContinue
    Fail "port $Port is already held by $($Process.Path) (pid $($Holder.OwningProcess)); close it first"
}

$Dependencies = Join-Path $Root 'References\pcsx2\deps\bin'
if (-not (Test-Path (Join-Path $Dependencies 'Qt6Core.dll'))) { Fail "no Qt runtime in $Dependencies; run Emulator/Build.ps1" }
$env:PATH = "$Dependencies;$env:PATH"

if (-not (Test-Path $Ini)) {
    New-Item -ItemType Directory -Force $Runtime | Out-Null
    $Init = Start-Process -FilePath $Exe -ArgumentList @('-datapath', "`"$Runtime`"", '-testconfig') -PassThru
    if (-not $Init.WaitForExit(60000)) {
        $Init.Kill()
        Fail "-testconfig did not exit within 60 s; PCSX2 is probably showing a dialog"
    }
    if (-not (Test-Path $Ini)) { Fail "-testconfig (exit $($Init.ExitCode)) did not create $Ini" }
}
Set-IniValue $Ini 'UI' 'SetupWizardIncomplete' 'false'

$Arguments = @('-datapath', "`"$Runtime`"")
if ($Bios) {
    $BiosFile = Get-Item $Bios -ErrorAction SilentlyContinue
    if (-not $BiosFile) { Fail "BIOS not found: $Bios" }
    Set-IniValue $Ini 'Folders' 'Bios' $BiosFile.DirectoryName
    Set-IniValue $Ini 'Filenames' 'BIOS' $BiosFile.Name
    $Arguments += '-bios'
}

$Started = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
Write-Host "pcsx2 pid $($Started.Id)"
