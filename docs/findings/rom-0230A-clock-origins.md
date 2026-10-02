# Which EE code sends each draw of the crystal clock — ROM 2.30

Build: BIOS `0230AC20080220`, as launched by Watson with the EE and VU interpreters
(`watson_launch` with `interpreter: true`). Emulator: Watson PCSX2 `v2.9.94`.
State: `rom-0230A-clock.p2s`. Captured 2026-10-02 with `watson_gif_trace`, 4 frames asked:

| File | SHA-256 |
|---|---|
| `Runtime/captures/rom-0230A-clock-origins.gs` | `8baabd1c8be19add6b09111b6fde01d6f423265bcdc46bf822bcc76685438ed5` |
| `Runtime/captures/rom-0230A-clock-origins.trace.jsonl` | `22896936688f3037ec428038dd53e72b28335e69b46f3cae728b9f6e7951bf86` |

The trace was checked against the dump: all 5 416 transfer packets of the dump equal the
trace's packets byte for byte, vsyncs in the same places, and the byte queue never lost step
(0 of 6 093 packets). Parsed with `watson_gsdump_parse` and the trace: 1 432 draws in 8 frames,
every one tied to a source.

Addresses here are of this build only. Nothing below says what a function *is*; names are not
known for this build. Where a line says what a function is for, it is a reading.

## How the data travels

| | |
|---|---|
| PATH1 (VU1 `XGKICK`) | not used: 0 packets |
| PATH2 (VIF1 `DIRECT`) | 2 835 packets, 1 153 136 bytes, every byte read from the scratchpad |
| PATH3 (GIF DMA) | 3 258 packets, 364 896 bytes, every byte read from EE RAM |
| Draws by path | 1 408 on PATH2, 24 on PATH3 |

- **The clock does not use VU1 to send geometry.** Vertices arrive at the GS already
  transformed; whatever transforms them runs on the EE side (EE core or VU0, not settled here).
- **Every packet is its own DMA transfer.** 6 770 channel starts were recorded in 9 frames,
  about 750 per frame, and each feeds one packet. There is no display list flushed once per
  frame, so the EE call stack at the moment a transfer starts names the code that built it.
- Two functions start every transfer:

  | Function entry | Instruction that starts the channel | Channel | `CHCR` written |
  |---|---|---|---|
  | `0x00272c10` | `0x00272cd0`: `sw v0,(s0)` | VIF1 (channel 1) | `0x70000145` |
  | `0x0026edc0` | `0x0026ee98`: `sw a0,(v1)` | GIF (channel 2) | `0x00000101` |

  Both instructions were disassembled live and are the stores the trace names.
- Geometry is built in the scratchpad, between `0x038` and `0x2248`, and sent from there. The
  draws on PATH3 are the full-buffer untextured sprites, read from EE RAM at `0x001f0b30`,
  `0x001f0c20` and `0x00297060`.

## Who sends what

Every stack ends `… < 0x00221558 < 0x00221060 < 0x00221408 < 0x00158284`. `0x00221558` is on
the stack of every draw of the screen. The table lists, for frame 1 of the dump (179 draws),
the function entries between the sender and `0x00221558`, innermost first.

| Call chain under `0x00221558` | Draws | Primitives | What they are, by the pipeline page |
|---|---|---|---|
| `0x002216d8` | 1 | 1 | the clear: untextured full-buffer sprite |
| `0x0022f470 < 0x0022f610 < 0x002216d8` | 1 | 910 | background strips, texture `0x2c00` |
| `0x0022fd00 < 0x002328d8 < 0x002216d8` | 10 | 10 | the five shrink-and-stretch round trips |
| `0x0022fd00 < 0x002326a8 < 0x002216d8` | 2 | 2 | frame copied into `0x0d2` and `0x118` |
| `0x0022fd00` | 4 | 4 | full-buffer sprites sent from `0x00221558` itself |
| `0x00233f60 < 0x0022bcc8 < 0x0022beb8` | 64 | 1 020 | the twelve rods, five draws each |
| `0x00235630 < 0x0022b928 < 0x0022bcc8 < 0x0022beb8` | 14 | 672 | orb line strips, 48 segments each |
| `0x0022fd00 < 0x00235630 < 0x0022b928 < 0x0022bcc8 < 0x0022beb8` | 28 | 28 | orb sprites, textures `0x2e40` and `0x2e00` |
| `0x0022bdb0` | 2 | 2 | untextured sprite that starts each extra pass |
| `0x00234a68 < 0x0022bdb0` | 48 | 672 | the two extra passes over the rods |
| `0x0022fd00 < 0x0022bdb0` | 1 | 1 | additive full-buffer sprite closing the first extra pass |
| `0x0022fd00 < 0x00221830` | 1 | 2 | the two black bars |
| `0x0020a938 < 0x0020aca8 < 0x0020c6f8 < 0x002219d8` | 1 | 19 | text, top line |
| `0x0022fd00 < 0x00221e48 < 0x00222160` | 1 | 1 | button icon |
| `0x0020a938 < 0x0020aca8 < 0x0020c6f8 < 0x00221e48 < 0x00222160` | 1 | 7 | text, bottom line |

`0x0022fd00` is called from seven of these functions and always sends sprites, one per draw
except the two bars. *Reading: a
"draw one textured rectangle" helper.*

## One rod, call site by call site

The five draws of a rod (see `rom-0230A-clock-gs.md`) are sent from five places inside one
function, `0x00233f60`. The return address into it tells them apart:

| Draw of the group | Returns to | Target | Texture |
|---|---|---|---|
| 1 | `0x002347c8` | `0x118` | `0x1a40` (buffer `0x0d2`) |
| 2 | `0x00234868` | `0x118` | `0x2d00`, `(0 - Cs) * As + Cd` |
| 3 | `0x00234904` | `0x118` | `0x2d00`, `(Cs - 0) * As + Cd` |
| 4 | `0x00234994` | frame | `0x2300` (buffer `0x118`) |
| 5 | `0x00234a24` | `0x0d2` | `0x2300` (buffer `0x118`) |

One group per frame is sent from a second set of sites in the same function: `0x00234280`,
`0x00234324`, `0x0023447c`, `0x00234634`, `0x00234724`. In frame 1 it is the sixth group and
has 24 triangles in its first three draws where the five before it have 18 to 20. *Reading: the rod
that is drawn differently; which rod, and why, is in the code at those sites.*

The orbs are drawn between rods by `0x00235630`, called through `0x0022b928` from the same
loop function `0x0022bcc8`: line strip to the frame (returns to `0x00235b74`), two sprites,
line strip to `0x0d2` (returns to `0x00236230`), two sprites.

In the two extra passes, `0x00234a68` sends the `0x2bc0` strip (returns to `0x00235084`, once
per pass to `0x00234d84`) and the subtractive strip (returns to `0x002351d0`).

## What this does and does not settle

- Which function sends which draw: settled, for this build, by the trace.
- What each function computes: not looked at. The next step is to read `0x00233f60`,
  `0x00234a68`, `0x00235630`, `0x0022f470` and `0x0022fd00`, and to find their counterparts in
  the HDD OSD build, which has symbols.
- An earlier comparison in this project put `clock_orb_rendering_func` of HDD OSD 1.10U
  (`0x00225E80` there) at `0x00221558` in this build. That was matched by code shape, not
  measured here; this page only shows that `0x00221558` is the root of the screen's drawing.
- Where the vertices are computed, and whether VU0 is involved: not settled. They are written
  to the scratchpad before each send; who writes them is the question for a write trace.
- Frames differ slightly: 175 to 183 draws per frame in this capture. Only frame 1 was broken
  down.
