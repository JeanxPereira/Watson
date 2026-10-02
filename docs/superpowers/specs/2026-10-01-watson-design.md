# Watson — Design

Date: 2026-10-01
Status: draft, awaiting review

## 1. Purpose

Watson is the live witness for PS2 reverse engineering: an instrumented PCSX2 plus an MCP
server that lets an agent launch the emulator, reach a screen, capture what the Graphics
Synthesizer drew, and tie every GS packet back to the EE code that sent it, without a human
in the loop.

The first consumer is CrystalClockVK, a Vulkan reimplementation of the PS2 OSDSYS crystal
clock. That project stalled because its evidence was unreliable: its notes paired symbol
addresses from one OSDSYS build with RAM values captured from another, and no note said which
build it came from. Watson exists so that a captured fact always names the build it was
captured on and the coverage of the instrument that captured it.

Sherlock answers from a precomputed store of static facts. Watson answers from a running
machine. They share the answer contract (section 6).

### Success criteria

1. From a cold start, with no human action, an agent can boot a chosen BIOS or ELF, reach the
   OSDSYS clock screen, and save a state there.
2. From that state, an agent can obtain a GS dump of N frames and a software-renderer PNG of
   each frame.
3. For a captured frame, every GIF transfer is attributed to an EE program counter and call
   stack, and the attributed transfers match the GS dump of the same frame byte for byte.
4. Every answer names the running build, or says the build is unknown.

### Non-goals

- IOP debugging, cheats, rewind buffers, virtual XInput devices.
- macOS and Linux. Watson targets Windows; nothing is done to prevent a later port.
- A GS emulator or renderer. Watson records and decodes; rendering is PCSX2's.
- Static analysis. Function stores, cross-build address maps and decompilation belong to a
  separate tool.
- Live readout of GS general-purpose registers or VRAM. Both are recovered offline from a GS
  dump, whose state blob holds them at the first frame (section 5.4). This drops `gs_vram_read`
  and narrows `gs_regs` relative to the design discussed in chat.

## 2. Prior art and what is reused

| Project | Reused | Not reused |
|---|---|---|
| `hkmodd/PCSX2-MCP` | `DebugServer.cpp/.h` (JSON over TCP inside PCSX2) and the TypeScript MCP bridge with its 30 EE debugger tools. Watson starts as a fork of this repository. | The prebuilt PCSX2 binary. |
| `snowyegret23/PCSX2_MCP` (MIT) | Its tool list as a reference for lifecycle, input and log tools. | Its transport. It needs a PCSX2 build with GDB servers and `qPcsx2` commands; upstream PCSX2 has neither and no such build was found. |
| `dmang-dev/mcp-pine` | Nothing. PINE covers memory and savestates only, which the DebugServer already covers. | |

Licensing: the emulator patch links into PCSX2, which is GPL-3.0, so Watson is GPL-3.0. The
upstream `DebugServer.cpp` carries an `SPDX-License-Identifier: MIT` header while its
repository's `LICENSE` is GPL-3.0; Watson keeps the file header as found and records the
discrepancy in its README.

## 3. Architecture

```
agent ── stdio (MCP) ──► Server (TypeScript, Node)
                           │  ├─ live tools ── TCP 127.0.0.1:21512, newline-delimited JSON ──► PCSX2 + DebugServer patch
                           │  ├─ lifecycle ─── spawns and kills the PCSX2 process
                           │  └─ offline tools ─ GS dump parser (in-process), gsrunner (child process)
                           └─ reads watson.json from the consumer (builds, symbols)
```

Three units, each testable alone:

- **Emulator patch** (C++). Runs inside PCSX2. Knows nothing about MCP or about any game.
  Exposes commands over TCP.
- **Server** (TypeScript). Translates MCP tool calls into patch commands, owns the PCSX2
  process, annotates addresses with symbols, and appends the answer contract.
- **Offline** (TypeScript, same package). Parses GS dump files and drives `pcsx2-gsrunner`.
  Needs no running emulator. Also reachable as a CLI: `watson gsdump parse|render`.

One runtime for everything outside the emulator: Node 22.15 or newer (the machine has 25.2).

### Repository layout

```
Watson/
  Emulator/
    DebugServer.cpp, DebugServer.h     the patch body
    hooks.patch                        the few lines added to upstream files
    upstream.json                      pinned PCSX2 commit
    Build.ps1                          clone or update, apply, configure, build
  Server/
    src/                               MCP server, DebugServer client, lifecycle, contract
    src/offline/                       GS dump parser, gsrunner driver
    tests/
  References/                          git-ignored: PCSX2 clone, build output
  Runtime/                             git-ignored: portable PCSX2 data directory
  docs/
```

Watson does not vendor PCSX2. `Emulator/upstream.json` pins one upstream tag and commit,
initially `v2.9.94` (`81526d4dc7`, 2026-10-01), the latest upstream release when Watson began.
`Build.ps1` clones that commit into `References/pcsx2`, copies the patch body, applies
`hooks.patch`, and builds `pcsx2-qt` and `pcsx2-gsrunner`.

### Isolation from the user's PCSX2

Watson launches PCSX2 with `-datapath <Watson>/Runtime`, so it never reads or writes
the configuration in `Documents/PCSX2`. It never passes `-portable`: portable mode takes
priority over `-datapath` and would write next to the executable. Watson writes the settings it depends on into that
runtime directory before each launch: software renderer (`Renderer = 13`), uncompressed GS
dumps (`GSDumpCompression = Uncompressed`), the BIOS search path, and DebugServer enabled.

## 4. The consumer: `watson.json`

Discovery is `--config <file>`, else the first `watson.json` walking up from the working
directory. The file tells Watson which builds the consumer knows.

```json
{
  "schema": 1,
  "watson": "0.1",
  "builds": [
    {
      "id": "hddosd-1.10U",
      "fingerprint": { "address": "0x00200008", "length": 4096, "sha1": "<sha1 of those bytes>" },
      "symbols": "../CrystalOSD/symbol_addrs.txt",
      "launch": { "elf": "References/hddosd.elf" }
    },
    {
      "id": "rom-0230A-20080220",
      "fingerprint": { "address": "0x00200000", "length": 4096, "sha1": "<sha1 of those bytes>" },
      "launch": { "bios": "References/bios/megadump/ps2-0230a-20080220.bin" }
    }
  ]
}
```

- `fingerprint` is a hash over a range of live EE memory. It identifies a build whether it was
  loaded from an ELF or unpacked from ROM at boot, which a file hash cannot do.
- `symbols` is a splat `symbol_addrs.txt`. Optional. Used only to name addresses in answers.
- `launch` holds one of `elf` or `bios`.
- Paths are relative to the file. Every validation failure is `NOT VERIFIED` and names what
  was refused.

Without a `watson.json`, live tools still work and report the build as `unknown`.

## 5. Tool surface

Names are prefixed `watson_`. The 30 inherited tools keep their behavior and are renamed from
`pcsx2_*` to `watson_*`; the two `ps2recomp_*` tools are removed.

### 5.1 Lifecycle

| Tool | Does |
|---|---|
| `watson_launch` | Starts PCSX2 for a build id from `watson.json`, or for an explicit `bios` or `elf` path. Options: `state` (savestate file to load), `visible` (default true). Waits until the DebugServer accepts a connection. Refuses if a Watson-owned PCSX2 is already running. |
| `watson_kill` | Terminates the PCSX2 process Watson started. Never touches a PCSX2 it did not start. |
| `watson_status` | Process state, connection state, paused or running, frame counter, build identity. |

### 5.2 Time and input

| Tool | Does |
|---|---|
| `watson_frame_advance` | Runs exactly N frames and pauses. Built on `VMManager::FrameAdvance`. |
| `watson_run_until` | Resumes until a breakpoint hits or a frame budget is spent, whichever is first; reports which. |
| `watson_pad` | Holds a set of pad buttons for N frames, then releases. Port 1 only. |
| `watson_save_state`, `watson_load_state` | By file path, in addition to the inherited slot form. |

### 5.3 GS, live

| Tool | Does |
|---|---|
| `watson_gs_dump` | Captures N frames to an uncompressed `.gs` file through `GSQueueSnapshot`. Returns the path once the file is complete. |
| `watson_snapshot` | Writes a PNG of the current frame as rendered by the software renderer. |
| `watson_gs_regs` | Reads the GS privileged registers (`PMODE`, `SMODE2`, `DISPFB1/2`, `DISPLAY1/2`, `BGCOLOR`, `CSR`). |
| `watson_gif_trace` | Records every GIF transfer for N frames with its origin (section 5.5). Returns the path of a JSON Lines file. |

### 5.4 GS, offline

| Tool | Does |
|---|---|
| `watson_gsdump_parse` | Reads a `.gs` file and writes JSON Lines: header, initial register state, then one record per packet. Transfers are decoded into GIF tags (`NLOOP`, `EOP`, `PRE`, `PRIM`, `FLG`, `NREG`, `REGS`) and their register writes, by name, in `PACKED`, `REGLIST` and `IMAGE` formats. A second pass emits one record per draw: primitive type, vertices, and the register state in force (`FRAME`, `ZBUF`, `TEX0`, `TEX1`, `CLAMP`, `ALPHA`, `TEST`, `SCISSOR`, `FBA`, `COLCLAMP`, `DTHE`, `PABE`, `FOGCOL`, `TEXA`). |
| `watson_gsdump_render` | Runs `pcsx2-gsrunner` on a dump with the software renderer and returns the PNG paths, one per frame. |

Dump format, as written by `pcsx2/GS/GSDump.cpp` at the pinned commit: `u32 0xFFFFFFFF`,
`u32 header_size`, `GSDumpHeader` (`state_version`, `state_size`, `serial_offset`,
`serial_size`, `crc`, `screenshot_width`, `screenshot_height`, `screenshot_offset`,
`screenshot_size`), serial, screenshot, the state blob, the privileged registers, then packets:
`0` transfer (`u8 path`, `u32 size`, data), `1` vsync (`u8 field`), `2` read FIFO (`u32 size`),
`3` registers. Paths: `0` PATH1 old, `1` PATH2, `2` PATH3, `3` PATH1 new.

The parser reads uncompressed and Zstandard dumps (Node's `zlib`). An LZMA dump is
`NOT VERIFIED`, naming the compression; Watson's own captures are always uncompressed.

### 5.5 `gif_trace`

The GS dump is recorded on the GS thread, where the EE program counter is no longer known.
`gif_trace` records on the EE side. As built (plan `2026-10-02-watson-gif-trace.md`), the hooks
at the pinned tag are:

- `dmaVIF1()` and `dmaGIF()`: the EE sets channel 1 or 2 going. An `origin` record: channel
  registers, EE `pc`, `ra`, `sp` and a stack walk (`MipsStackWalk`).
- `Gif_Unit::TransferGSPacketData`: bytes enter a path, for all of `XGKICK` (PATH1), `DIRECT`
  and `DIRECTHL` (PATH2), `DMA` and `FIFO` (PATH3). A `data` record: path, kind, the origin it
  belongs to, where the bytes were read from (EE RAM, scratchpad, VU1 memory) and their size;
  for PATH1 also the VU1 program counter.
- The PATH3 rewind and the soft reset in `Gif_Path`: bytes leave a path unsent.
- `Gif_AddCompletedGSPacket`: a packet enters the MTGS ring, with its bytes. These are the
  dump's transfer packets, one for one.
- `gsPostVsyncStart`: vsync.

The server replays each path's byte queue, so every byte of every packet is tied to a `data`
record, and checks its own count against the emulator's after each packet.

**The trace needs the EE and VU1 interpreters** (`watson_launch` with `interpreter: true`).
Under the recompilers a hardware write does not write the program counter back, and guest
registers may sit in host registers, so `pc`, `ra` and `sp` would not be those of the
instruction. `gif_trace_start` refuses under them. Under the EE interpreter of a release
build breakpoints and watchpoints never fire, so the server refuses to set them there.

`watson_gif_trace` always captures a GS dump and a PNG of the same frames and checks the trace
against the dump before answering.

What an origin is and is not. A `data` record names the last start of the channel that
normally feeds its path. That is the code that sent the bytes when they are read straight from
guest memory by that transfer, which the trace cannot prove by itself. Known cases where it is
not:

- Bytes that waited in the emulated GIF FIFO, or were written to the VIF1 FIFO by the EE,
  arrive from an emulator buffer. These are recorded with origin 0 (unknown).
- `XGKICK`: VU1 is usually started by a VIF1 `MSCAL`, but can be started by the EE through
  `CTC2`, and a kick can finish while a later VIF1 transfer is running. The origin named is
  then the wrong VIF1 start. `vuTpc` is the VU1 program counter when the bytes move, not the
  address of the `XGKICK` instruction.
- MFIFO: the origin is the start of the draining channel, not the code that filled the ring.

A capture where each origin feeds exactly one packet, and every chunk lies inside its origin's
`MADR` range, is free of the first and third; the clock capture is.

Probes (plan `2026-10-02-watson-probes.md`). A trace can carry up to 32 probes. A probe is a
program counter and up to 8 memory ranges; every time the EE interpreter is about to execute
the instruction there, a `probe` record is written, in order with the packets: the 32 general
registers (low 32 bits), the 32 FPU registers (raw bits), and each range's bytes. A range is
`[*]base[+hex]:hexlength`, base being a register name or a hex address, `*` following the
32-bit pointer found there; a range that is not in EE RAM or the scratchpad is recorded as not
readable and the trace goes on. A malformed probe refuses the whole trace.

A probe is how arithmetic read from disassembly becomes a measured fact: probe the function's
entry for its real inputs, recompute the output with the formula read, and compare with the
packet that follows in the same trace. The EE cuts single-precision results toward zero; a
recomputation that rounds to nearest is off by one unit in a fraction of a percent of values.

Cost: with a trace running, every DMA start walks the EE stack, about 3 ms each. The OSDSYS
clock starts 677 per frame, so a traced frame takes about 2 s. `frame_advance` allows 20 s per
frame while a trace runs.

### 5.6 Symbols and identity

- When the running build matches a `watson.json` entry with `symbols`, every address in an
  answer is followed by `symbol+offset`.
- `identity` is computed on connect and after every state load: the fingerprint match, plus
  what PCSX2 reports (`BiosDescription`, `BiosChecksum`, `GetCurrentELF`, `GetCurrentCRC`,
  `GetDiscSerial`).

## 6. Answer contract

Every tool result ends with two lines:

```
build: <id from watson.json | unknown> (<bios description or elf name>)
verdict: FOUND <count> | EMPTY | PARTIAL <why> | NOT VERIFIED <diagnostic>   coverage <read>/<total>
```

- `FOUND` and `EMPTY` mean the instrument looked at everything it was asked to.
- `PARTIAL` means it looked at less, and says how much. Example: a `gif_trace` stopped by a
  breakpoint after 2 of 5 frames.
- `NOT VERIFIED` means the instrument could not look. Examples: no connection, unsupported
  dump compression, `watson.json` refused.
- `build: unknown` is never an error by itself; it is information the agent must carry into
  whatever it writes down.

The CLI form uses Sherlock's exit codes: 0 for `FOUND` and `EMPTY`, 3 for `PARTIAL`, 2 for
`NOT VERIFIED`, 1 for a tool that looked and failed.

## 7. Wire protocol

Unchanged from the inherited DebugServer: newline-delimited JSON over TCP on
`127.0.0.1:21512`. Request `{"cmd": "...", ...}`, response `{"ok": true, "data": {...}}` or
`{"ok": false, "error": "..."}`. New commands: `identity`, `frame_advance`, `pad`,
`gs_dump`, `snapshot`, `gs_regs`, `gif_trace_start`, `gif_trace_stop`, `save_state_file`,
`load_state_file`. Commands that finish later (`frame_advance`, `gs_dump`, a trace) reply once
when done; the server applies a timeout and reports `NOT VERIFIED` when it expires.

The DebugServer listens on loopback only, and its port is exclusive: a second emulator
cannot listen on it.

Two properties this design needs are not true of the inherited server and are owed by the
first task of phase 2, before any new command is added:

- **One client.** The inherited server accepts any number of connections, each on its own
  detached thread with no lock between them.
- **Clean stop.** `Stop()` closes the listening socket but neither wakes nor joins client
  threads; a command in flight at shutdown can outlive the emulator's memory.

## 8. Error handling

- A lost TCP connection marks the session disconnected; the next live tool call answers
  `NOT VERIFIED not connected` instead of retrying silently.
- `watson_launch` that does not reach a listening DebugServer within its timeout kills the
  process it started and reports the last lines of the PCSX2 log.
- A tool that writes a file returns the path only after the file is closed and its size is
  stable.
- The patch never blocks the emulation thread on a socket. Commands that change emulator
  state run on the CPU thread through `Host::RunOnCPUThread`, as upstream's own debugger
  does. The inherited server does not do this: it calls `CBreakPoints` from its socket
  thread, and `CBreakPoints::Update` resets the recompiler while the CPU thread may be
  inside it. Phase 0 keeps that behavior; moving every mutating command to the CPU thread
  is the first task of phase 2, together with the two items in section 7.
- A command other than `status` that arrives before any VM has booted is refused with
  `no VM is running`.
- A watchpoint with action `log` is refused. PCSX2 removed the log-only result, and a
  memcheck with no break bit never counts a hit.

## 9. Testing

Offline, always run:

- **Parser fixtures.** Small hand-built `.gs` files covering each packet type and each GIF
  format, with expected JSON Lines checked in.
- **Bridge contract.** The server against a fake DebugServer on a local socket: every tool,
  the timeout path, the disconnect path, and that every answer ends with the contract lines.
- **Config.** `watson.json` validation: each refusal names its cause.

Live gates, run when a built PCSX2 and a BIOS are present, skipped with a stated reason
otherwise:

- **G1 identity.** Launching each build in a fixture `watson.json` reports that build's id.
- **G2 determinism.** From one savestate, `frame_advance(N)` then `snapshot`, twice, gives
  identical PNG bytes.
- **G3 trace parity.** For the same frames, the packets recorded by `gif_trace` equal the
  transfer packets in the GS dump: same order, same bytes, vsyncs in the same places. The path
  is not compared: PCSX2 hands every path's packet to the GS through one function, so a dump
  records path id 3 for all of them. The path is known from the trace alone.
- **G4 render parity.** `gsdump_render` of a captured dump equals the live `snapshot` of the
  same frame.

G3 is the gate that makes attribution trustworthy: two independent instruments, one answer.

## 10. Phases

| Phase | Delivers | Exit criterion |
|---|---|---|
| 0 | `Build.ps1`: pinned upstream plus the inherited patch builds on this machine; the inherited 30 tools work against it. | An agent connects to the self-built PCSX2 and reads EE registers. |
| 1 | Offline: `gsdump_parse`, `gsdump_render`, CLI, parser fixtures. | A dump captured by hand from the OSDSYS clock parses with `FOUND` and full coverage, and renders to PNG. |
| 2 | `launch`, `kill`, `status`, `frame_advance`, `run_until`, `pad`, state by file, `gs_dump`, `snapshot`, `gs_regs`. | Success criteria 1 and 2; gates G2 and G4 pass. |
| 3 | `watson.json`, identity, symbols, the answer contract on every tool, `gif_trace`. | Success criteria 3 and 4; gates G1 and G3 pass. |

Phase 0 is the risk gate. The inherited patch was written against upstream of March 2026 and
has not been built against the pinned tag. PCSX2 itself was built on this machine in July
2026 with the Visual Studio generator and MSVC, at an older commit. If phase 0 does not close, phase 1 is still deliverable: it needs only
`pcsx2-gsrunner`, or, failing a local build, dumps rendered by a stock PCSX2.

Each phase gets its own implementation plan.

Order as executed: phase 0, then phase 2 (plan `2026-10-01-watson-navigation.md`), then
phase 1. Navigation moved ahead so that the dump phase 1 needs is captured by the agent
rather than by hand. That plan leaves out `watson_run_until` and `watson_gs_regs`: navigation
does not need the first, and the GS privileged registers are already category 6 of
`watson_read_registers`.

Phase 3 was split. `gif_trace` and gate G3 were delivered by plan
`2026-10-02-watson-gif-trace.md`. Build identity by fingerprint, symbols, and the answer
contract on every tool (success criterion 4, gate G1) are still owed and get their own plan. Probes were added to the trace by plan
`2026-10-02-watson-probes.md`.

## 11. Open questions resolved by phase 0 and 1, not by assumption

- Whether `hddosd.elf` boots to the clock under `-elf` in PCSX2. If it does not, the HDD OSD
  build stays a static reference and live work runs on the ROM build.
- Whether OSDSYS reaches the clock by idling or needs pad input; this decides how
  `watson_pad` is first exercised.
- Whether the clock sends geometry on PATH1 (VU1), which an earlier note in CrystalOSD denies
  without a build id. The first `gif_trace` answers it. Answered for ROM 2.30
  (`0230AC20080220`): no. Geometry goes on PATH2 from the scratchpad, state on PATH3; see
  `docs/findings/rom-0230A-clock-origins.md`.
