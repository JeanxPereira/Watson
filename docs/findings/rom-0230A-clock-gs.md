# What the GS is told to draw on the crystal clock screen — ROM 2.30

Build: BIOS `0230AC20080220`, as launched by Watson; the dump itself carries only the serial
`20080220-175343`. Emulator: Watson PCSX2 `v2.9.94`.
Dump: `Runtime/captures/rom-0230A-clock.gs`, SHA-256
`9176fdbb6bb5d394505e984462cbf7d8b11148c804d7b54dfc114ef758c97174`, captured from state
`rom-0230A-clock.p2s`. Parsed with `watson-gsdump parse`; 2 716 of 2 716 packets read.
Recorded 2026-10-01; corrected the same day after an independent review re-derived every
number from the dump with a second decoder.

Everything below is read off the parsed dump: register values and counts. Where a line says
what a pass is *for*, it is marked as a reading, not a fact. Nothing here comes from code.
The privileged-register packets (display setup) are not decoded, so nothing here says which
buffer reaches the screen.

## Totals

| | |
|---|---|
| Frames in the dump (vsyncs) | 4, fields 0, 1, 0, 1 |
| Draws per frame | 181, 176, 176, 176 |
| Primitives per frame | 3 347, 3 335, 3 335, 3 335 |
| Register writes | 69 668 |
| Image data uploaded | 0 bytes: no texture is uploaded in these frames |
| `TRXDIR` writes (uploads, downloads, VRAM copies) | none |
| Drawing context used | context 1 only |
| Writes to an undefined register | 200 to address `0x7f`, data 0 |

## Buffers

Four `FRAME` values are drawn to, all `FBW 10` (640 pixels wide), `PSM 0x00` (32-bit), all
with scissor 0..639 × 0..223:

| `FBP` | Same memory as texture `TBP0` | Draws (4 frames) |
|---|---|---|
| `0x000` | `0x0000` | 101, in frames 0 and 2 |
| `0x046` | `0x08c0` | 98, in frames 1 and 3 |
| `0x0d2` | `0x1a40` | 139, every frame |
| `0x118` | `0x2300` | 371, every frame |

`FBP` counts 2 048-pixel units and `TBP0` counts 64-pixel units, so `TBP0 = FBP × 32`. A
640 × 224 buffer is 70 units. The four targets sit at 0, 70, 210 and 280; the slot at 140
(`0x08c`) is the depth buffer: `ZBUF.ZBP` is `0x08c` in all 709 draws, with depth writes
enabled in all of them.

`0x000` and `0x046` alternate with the field and are never both drawn in one frame.

**Every colour buffer is also bound as a texture by other draws.** `0x1a40` and `0x2300` are
sampled with `PSM 0x00` (55 and 130 draws); `0x0000` and `0x08c0` with `PSM 0x01`, 24-bit
(14 draws each). With no `TRXDIR` write in the dump, nothing is copied: the picture is built by
drawing one buffer into another.

## Textures that are not buffers

| `TBP0` | Size | `PSM` | Draws |
|---|---|---|---|
| `0x2c00` | 128 × 128 | `0x00` | 4 |
| `0x2d00` | 64 × 64 | `0x00` | 144 |
| `0x2d40` | 64 × 64 | `0x00` | 48 |
| `0x2bc0` | 64 × 64 | `0x00` | 96 |
| `0x2e00`, `0x2e40` | 64 × 64 | `0x00` | 56 each |
| `0x2ec0` | 64 × 64 | `0x00` | 4 |
| `0x2f05` | 256 × 512 | `0x14` (4-bit indexed) | 8 |

## Blending

| Equation `(A - B) * C >> 7 + D` | Draws |
|---|---|
| off | 381 |
| `(Cs - 0) * As + Cd` | 168 |
| `(0 - Cs) * As + Cd` | 144 |
| `(Cs - Cd) * As + Cd` | 16 |

No draw uses `FIX` or `Ad` as the coefficient.

## Tests

| | Draws |
|---|---|
| alpha test off, depth `ALWAYS` | 435 |
| alpha test off, depth `GEQUAL` | 198 |
| alpha test off, depth `GREATER` | 68 |
| alpha `GREATER 0`, depth `ALWAYS` | 8 |

## How triangle strips arrive

441 of the 445 triangle-strip draws hold more than one strip: the queue is restarted by a
`PRIM` write between strips with no state change, so several strips fall into one draw. The
rod draws are runs of two-triangle quads. Strip boundaries are in each draw's `indices`.

## One frame, in the order the GS received it

Frame 1 of the dump (field 1, target `0x046`), 176 draws, numbered from 0.

1. **Draws 0–1: clear and background.** One untextured sprite over 640 × 224. Then one draw of
   16 triangle strips, 912 triangles and 944 vertices, texture `0x2c00`, Gouraud, `ST`
   coordinates, depth `GREATER`; its vertices run from −723 to 1 160 horizontally and are cut
   by the scissor.
2. **Draws 2–11: five round trips between `0x046` and `0x118`.** A sprite into `0x118`
   covering 319.25 × 149.25 that samples all of `0x08c0` (texels 0.5..640.5 × 0.5..223.5);
   then a sprite into `0x046` covering 640 × 223 that samples that same corner of `0x2300`
   (0.5..319.75 × 0.5..149.75). The corner shrinks by 2 × 1 each trip: 317.25 × 148.25,
   315.25 × 147.25, 313.25 × 146.25, 311.25 × 145.25. All opaque. *Reading: the background is
   repeatedly shrunk into a work buffer and stretched back, which blurs it.*
3. **Draws 12–14: three full-buffer sprites.** `0x0d2` ← `0x08c0`; `0x118` ← `0x08c0`;
   `0x046` ← `0x1a40`.
4. **Draws 15–99: twelve rods, each a group of triangle-strip draws with one bounding box.**
   Eleven groups have five draws, in this order:

   | # | Target | Texture | Coordinates | Blend | Depth | `PRIM` |
   |---|---|---|---|---|---|---|
   | 1 | `0x118` | `0x1a40` (buffer `0x0d2`) | `UV` | off | `ALWAYS` | `0x194` |
   | 2 | `0x118` | `0x2d00` | `ST` | `(0 - Cs) * As + Cd` | `GEQUAL` | `0x054` |
   | 3 | `0x118` | `0x2d00` | `ST` | `(Cs - 0) * As + Cd` | `GEQUAL` | `0x054` |
   | 4 | `0x046` | `0x2300` (buffer `0x118`) | `UV` | off | `GEQUAL` | `0x194` |
   | 5 | `0x0d2` | `0x2300` (buffer `0x118`) | `UV` | off | `GEQUAL` | `0x194` |

   Draws 1–3 have 16 to 24 triangles; draws 4–5 have 10 to 20. `PRIM 0x194` has `AA1` set.
   One group has six draws: its first pass is split in two (draw 78, 4 triangles, `PRIM 0x114`;
   draw 79, 16 triangles, `PRIM 0x194`), which differ only in `AA1`.
   *Reading: a rod is drawn into the work buffer with the picture behind it as its texture,
   darkened and brightened by a 64 × 64 texture, then copied to the frame and to the buffer
   the next rod samples.*
5. **Seven groups of three draws, each drawn twice, to `0x046` and to `0x0d2`:** a line strip
   of 48 segments, untextured, depth `GREATER`; a sprite with texture `0x2e40` and one with
   `0x2e00`, both `(Cs - 0) * As + Cd`. Four of the groups fall between rods (starting at
   draws 20, 46, 62, 84); three follow the last rod (draws 100–117). *Reading: the light orbs
   and their trails.*
6. **Draws 118–169: two more passes over all twelve rods, into `0x118`.** Each pass starts
   with an untextured full-buffer sprite, then per rod: a triangle strip with texture `0x2bc0`,
   blend off, and a triangle strip with texture `0x2d40` or `0x2d00`, `(0 - Cs) * As + Cd`.
   Each pass ends with one full-buffer sprite into `0x046` that samples `0x2300` with
   `(Cs - 0) * As + Cd` and vertex colour (128, 128, 128, 30).
7. **Draws 170–175: overlay, into `0x046`.** A full-buffer untextured sprite with colour
   (0, 0, 0, 0), `(Cs - Cd) * As + Cd`. One opaque draw of two black bars, y 0..27.4 and
   196.6..224. Nineteen sprites with texture `0x2f05` across x 22..620, y 11.1..27.4. One
   sprite with texture `0x2ec0` at 24..49 × 200..212. Seven sprites with `0x2f05` at
   52..137 × 197.2..212.2. One opaque black sprite at x 637.5..639.5, full height.
   *Reading: the bars, the date and time, the button icon and the `Display` prompt.* The text
   positions match the software-renderer PNG captured with the dump.

## What this does and does not settle

- A rod's first draw samples a buffer the GS drew earlier in the same frame, not an uploaded
  texture. That is on the wire.
- The dump does not say which EE function sent which draw. That needs `gif_trace`.
- Textures `0x2d00`, `0x2d40`, `0x2bc0`, `0x2c00`, `0x2e00`, `0x2e40` are in VRAM before the
  dump starts; their pixels are in the dump's state blob and are not extracted yet.
- Vertex colours, texture coordinates and depth values per draw are in
  `rom-0230A-clock.jsonl`; this page does not summarize them.
- Only frame 1 was broken down. Frame 0 has five more draws than the others, not examined.
