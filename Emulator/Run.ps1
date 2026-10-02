#requires -Version 7
param([string]$Bios, [string]$Elf, [string]$State, [switch]$Interpreter, [switch]$Visible)

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

if ($Visible) {
    $Started = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
    Write-Host "pcsx2 pid $($Started.Id)"
    exit 0
}

# Start-Process can minimize a window but not keep it from taking the focus; CreateProcess can.
Add-Type -Namespace Watson -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
}
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CreateProcessW(string application, System.Text.StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, int creationFlags, IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
'@
$Startup = New-Object Watson.Native+STARTUPINFO
$Startup.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($Startup)
$Startup.dwFlags = 1          # STARTF_USESHOWWINDOW
$Startup.wShowWindow = 7      # SW_SHOWMINNOACTIVE
$CommandLine = [System.Text.StringBuilder]::new("`"$Exe`" $($Arguments -join ' ')")
$Information = New-Object Watson.Native+PROCESS_INFORMATION
if (-not [Watson.Native]::CreateProcessW($Exe, $CommandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, [NullString]::Value, [ref]$Startup, [ref]$Information)) {
    Fail "CreateProcess failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
[Watson.Native]::CloseHandle($Information.hThread) | Out-Null
[Watson.Native]::CloseHandle($Information.hProcess) | Out-Null
Write-Host "pcsx2 pid $($Information.dwProcessId)"
