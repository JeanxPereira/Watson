# Watson

The live witness for PS2 reverse engineering: an instrumented PCSX2 and an MCP server that let
an agent drive the emulator and record what it did.

Design: [docs/superpowers/specs/2026-10-01-watson-design.md](docs/superpowers/specs/2026-10-01-watson-design.md).

## Status

Phase 0: a self-built PCSX2 with the DebugServer patch, and 28 EE debugger tools over MCP.

## Build

```powershell
pwsh Emulator/Build.ps1
cd Server; npm ci; npm test
```

`Build.ps1` clones the PCSX2 tag pinned in `Emulator/upstream.json` into `References/pcsx2`,
applies the patch, and builds `pcsx2-qt` and `pcsx2-gsrunner`.

## Run

```powershell
pwsh Emulator/Run.ps1 -Bios <path to a BIOS .bin you dumped>
```

Watson keeps its own PCSX2 data in `Runtime/` and does not touch `Documents/PCSX2`.
No BIOS, game or ELF is distributed with Watson.

## Credits and licensing

Watson is a fork of [hkmodd/PCSX2-MCP](https://github.com/hkmodd/PCSX2-MCP), whose history is
merged into this repository. It links into [PCSX2](https://github.com/PCSX2/pcsx2).

Watson is licensed GPL-3.0, as PCSX2 is. `Emulator/DebugServer.cpp` and
`Emulator/DebugServer.h` carry an `SPDX-License-Identifier: MIT` header from upstream while
the upstream repository's `LICENSE` is GPL-3.0. The headers are kept as found.
