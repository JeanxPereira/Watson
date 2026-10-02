#requires -Version 7
param([string]$Bios, [string]$Elf, [string]$State, [switch]$Interpreter)

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
Set-IniValue $Ini 'EmuCore' 'EnablePINE' 'true'
Set-IniValue $Ini 'EmuCore/GS' 'Renderer' '13'
Set-IniValue $Ini 'EmuCore/GS' 'GSDumpCompression' '0'
Set-IniValue $Ini 'EmuCore/GS' 'ScreenshotSize' '2'
# The GIF trace needs the interpreters; every other launch puts the recompilers back.
$Recompile = if ($Interpreter) { 'false' } else { 'true' }
foreach ($Key in 'EnableEE', 'EnableVU0', 'EnableVU1') { Set-IniValue $Ini 'EmuCore/CPU/Recompiler' $Key $Recompile }

$Arguments = @('-datapath', "`"$Runtime`"")
if ($Bios) {
    $BiosFile = Get-Item -LiteralPath $Bios -ErrorAction SilentlyContinue
    if (-not $BiosFile) { Fail "BIOS not found: $Bios" }
    Set-IniValue $Ini 'Folders' 'Bios' $BiosFile.DirectoryName
    Set-IniValue $Ini 'Filenames' 'BIOS' $BiosFile.Name
}
if ($Elf) {
    $ElfFile = Get-Item -LiteralPath $Elf -ErrorAction SilentlyContinue
    if (-not $ElfFile) { Fail "ELF not found: $Elf" }
    $Arguments += @('-elf', "`"$($ElfFile.FullName)`"")
} elseif ($Bios) {
    $Arguments += '-bios'
}
if ($State) {
    $StateFile = Get-Item -LiteralPath $State -ErrorAction SilentlyContinue
    if (-not $StateFile) { Fail "state not found: $State" }
    $Arguments += @('-statefile', "`"$($StateFile.FullName)`"")
}

$Started = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
Write-Host "pcsx2 pid $($Started.Id)"
