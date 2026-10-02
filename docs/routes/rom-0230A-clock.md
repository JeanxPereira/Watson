# Route to the crystal clock — ROM 2.30

Build: BIOS `0230AC20080220` (`ps2-0230a-20080220.bin`), fresh NVRAM, no disc.
Emulator: Watson PCSX2 `v2.9.94`, software renderer, snapshots at internal resolution.
Recorded 2026-10-01. Every press below was decided from the snapshot on its row; none was blind.

The crystal clock is not on the main menu. It is the background of **System Configuration**,
and Square hides the menu so that the clock is alone on screen.

| Frame | What the snapshot showed | Pressed | Held | Then ran |
|---|---|---|---|---|
| 8 | Emulator launched, VM alive | — | — | 300 + 600 frames |
| 318 | Opening: dark cubes and coloured light trails | — | — | — |
| 920 | "Select language." in seven languages, `X Enter` | cross | 4 | 90 + 180 frames |
| 1199 | User Preferences — Language: English | cross | 4 | 60 frames |
| 1266 | User Preferences — Time Zone: Kabul, GMT +4:30 | cross | 4 | 60 frames |
| 1333 | User Preferences — Daylight Savings Time: Standard | cross | 4 | 240 frames |
| 1580 | "Settings completed." `X Enter` | cross | 4 | 420 frames |
| 2007 | Main menu: Browser (selected), System Configuration; ring of light orbs | down | 4 | 30 frames |
| 2044 | Main menu: System Configuration selected | cross | 4 | 240 frames |
| 2291 | System Configuration — Clock Adjustment; menu cubes over the clock rods | square | 4 | 180 frames |
| 2478 | **The crystal clock alone**: twelve glass rods, wireframe sphere, light orbs, one rod lit | — | — | — |

The language, time zone and daylight-saving values are whatever the BIOS offered first; the
route accepts each default. With the time zone left at GMT +4:30 the on-screen time is the
host clock shifted by that offset.

## States

Saved under `Runtime/states/` (git-ignored; a state embeds BIOS memory and is not distributed):

| File | Frame | Screen |
|---|---|---|
| `rom-0230A-menu.p2s` | 2007 | Main menu, Browser selected |
| `rom-0230A-config.p2s` | 2291 | System Configuration, menu visible |
| `rom-0230A-clock.p2s` | 2478 | Crystal clock alone |

Launching with `bios` and `state = rom-0230A-clock.p2s` and taking a snapshot shows the clock
with no pad input: checked after a full kill and relaunch.

## Ground truth captured

`Runtime/captures/rom-0230A-clock.gs` (one frame, uncompressed, 5 791 744 bytes) and
`rom-0230A-clock.png` beside it, from frame 2478.

## What the screen holds, from the snapshot alone

Observations, not decoded facts: twelve rods in a ring, tilted toward the viewer; the rod at
the five-o'clock position is brighter and lighter than the rest (the time read 5:44); a
wireframe sphere at the centre; seven white light orbs on an arc across the sphere; a purple
textured background; the date at top left and the time at top right in a black band; a black
band at the bottom with `Display`.
