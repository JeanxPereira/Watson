Watson @VERSION@ on PCSX2 @LABEL@ (Windows x64)
=================================================

Watson is an instrumented PCSX2 and an MCP server: a live PS2 that an agent drives,
probes and records, frame by frame. https://github.com/@REPOSITORY@

Contents
  PCSX2/                 PCSX2 @LABEL@ built with Watson's debug server and hooks
                         (pcsx2-qt.exe, pcsx2-gsrunner.exe, Qt runtime, resources)
  Server/                The MCP server (dist/ and its runtime node_modules)
  Emulator/Run.ps1       The launcher the server calls
  watson-applied.patch   The exact change made to PCSX2 for this build
  LICENSE                GNU General Public License v3

Use
  Needs Node.js 22 or later and PowerShell 7 (pwsh).
  Register the server with your MCP client, for example in Claude Code:

    claude mcp add watson --env WATSON_PCSX2_EXE=<this folder>\PCSX2\pcsx2-qt.exe -- node <this folder>\Server\dist\index.js

  The emulator's data, states and captures go to <this folder>\Runtime, never to
  Documents\PCSX2. A BIOS image is not included; you supply your own.

Source (GPL-3.0)
  This build is PCSX2 @LABEL@ (https://github.com/PCSX2/pcsx2/commit/@PCSX2_SHA@)
  with watson-applied.patch applied, which is Watson's sources under pcsx2/DebugTools
  and the hooks of Emulator/hooks.patch, from Watson commit
  https://github.com/@REPOSITORY@/commit/@WATSON_SHA@
  To rebuild: check out both, then run
    python <watson>/Emulator/ApplyHooks.py <pcsx2>
  and build PCSX2 as usual (Watson's Emulator/Build.ps1 does both on the pinned version).
