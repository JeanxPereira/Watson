# What the GS is told to draw on the crystal clock screen — ROM 2.30

Build: BIOS `0230AC20080220`. Emulator: Watson PCSX2 `v2.9.94`.
Dump: `Runtime/captures/rom-0230A-clock.gs`, SHA-256
`9176fdbb6bb5d394505e984462cbf7d8b11148c804d7b54dfc114ef758c97174`, captured from state
`rom-0230A-clock.p2s`. Parsed with `watson-gsdump parse`; 2 716 of 2 716 packets read.
Recorded 2026-10-01.

Everything below is read off the parsed dump: register values and counts. Where a line says
what a pass is *for*, it is marked as a reading, not a fact. Nothing here comes from code.

## Totals

| | |
|---|---|
| Frames in the dump (vsyncs) | 4 |
| Draws per frame | 181, 176, 176, 176 |
| Primitives per frame | 3 347, 3 335, 3 335, 3 335 |
| Register writes | 69 668 |
| Image data uploaded | 0 bytes: no texture is uploaded in these frames |
| VRAM-to-VRAM copies (`TRXDIR` 2) | none |
| Drawing context used | context 1 only |
| Writes to an undefined register | 200 to address `0x7f` |

## Frame targets

Four `FRAME` values are drawn to, all `FBW 10` (640 pixels wide), `PSM 0x00` (32-bit):

| `FBP` | Same memory as texture `TBP0` | Draws (4 frames) | Scissor |
|---|---|---|---|
| `0x046` | `0x08c0` | 98, in frames 1 and 3 | 0..639 × 0..223 |
| `0x0d2` | `0x1a40` | 139 | 0..639 × 0..223 |
| `0x118` | `0x2300` | 371 | 0..639 × 0..223 |
| `0x000` | `0x0000` | 101, in frames 0 and 2 | not broken down here |

`FBP` counts 2 048-pixel units and `TBP0` counts 64-pixel units, so `TBP0 = FBP × 32`. Each
target is 70 `FBP` units from the next, which is 640 × 224 pixels: field-sized buffers.

`0x000` and `0x046` alternate frame by frame and are never both drawn in one frame; `0x0d2`
and `0x118` are drawn in every frame.

**Every one of these buffers is also bound as a texture by other draws.** `0x1a40` and
`0x2300` are sampled with `PSM 0x00` (55 and 130 draws); `0x0000` and `0x08c0` with `PSM 0x01`,
24-bit (14 draws each). With no VRAM copy in the dump, the frame is built by drawing one
buffer into another.

## Textures that are not frame buffers

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

## One frame, in the order the GS received it

Frame 1 of the dump, 176 draws. Runs of the same kind are folded.

1. **Clear and background.** `0x046`: one untextured sprite over 640 × 224. Then one triangle
   strip of 912 triangles, texture `0x2c00`, Gouraud, `ST` coordinates, depth `GREATER`; its
   vertices run from −723 to 1 160 horizontally and are cut by the scissor.
2. **Five round trips between `0x046` and `0x118`.** Sprite into `0x118` sampling `0x08c0`
   (the buffer just drawn), covering 319.2 × 149.2, then 317.2 × 148.2, 315.2 × 147.2,
   313.2 × 146.2, 311.2 × 145.2; each followed by a full-size sprite into `0x046` sampling
   `0x2300`. All opaque, `UV` coordinates. *Reading: the background is repeatedly shrunk into
   a work buffer and stretched back.*
3. **Three full-buffer sprites:** `0x0d2` ← `0x08c0`; `0x118` ← `0x08c0`; `0x046` ← `0x1a40`.
4. **Twelve groups of five triangle-strip draws, one group per on-screen rod.** Within a
   group every draw has the same bounding box. In order:

   | # | Target | Texture | Coordinates | Blend | Depth |
   |---|---|---|---|---|---|
   | 1 | `0x118` | `0x1a40` (buffer `0x0d2`) | `UV` | off | `ALWAYS` |
   | 2 | `0x118` | `0x2d00` | `ST` | `(0 - Cs) * As + Cd` | `GEQUAL` |
   | 3 | `0x118` | `0x2d00` | `ST` | `(Cs - 0) * As + Cd` | `GEQUAL` |
   | 4 | `0x046` | `0x2300` (buffer `0x118`) | `UV` | off | `GEQUAL` |
   | 5 | `0x0d2` | `0x2300` (buffer `0x118`) | `UV` | off | `GEQUAL` |

   Draws 1–3 have 16 to 24 triangles; draws 4–5 have 10 to 20. *Reading: a rod is drawn into
   the work buffer with the picture behind it as its texture, darkened and brightened by a
   64 × 64 texture, then copied to the frame and to the buffer the next rod samples.*
5. **Seven groups of three, interleaved among the rods,** each drawn twice, to `0x046` and to
   `0x0d2`: a line strip of 48 segments, untextured, depth `GREATER`; a sprite with texture
   `0x2e40` and one with `0x2e00`, both `(Cs - 0) * As + Cd`. *Reading: the light orbs and
   their trails.*
6. **Two more passes over all twelve rods, into `0x118`.** Each starts with an untextured
   full-buffer sprite, then per rod: a triangle strip with texture `0x2bc0`, blend off, and a
   triangle strip with texture `0x2d40` or `0x2d00`, `(0 - Cs) * As + Cd`. Each pass ends with
   one full-buffer sprite into `0x046` sampling `0x2300` with `(Cs - 0) * As + Cd`.
7. **Overlay, into `0x046`:** two untextured full-buffer sprites (one `(Cs - Cd) * As + Cd`),
   then sprites with texture `0x2f05` (19, then 7) and one with `0x2ec0`, all
   `(Cs - Cd) * As + Cd`. *Reading: the bars, date, time and the `Display` prompt.*

## What this does and does not settle

- A rod's first draw samples a frame buffer, not an uploaded texture. That is on the wire.
- The dump does not say which EE function sent which draw. That needs `gif_trace`.
- Textures `0x2d00`, `0x2d40`, `0x2bc0`, `0x2c00`, `0x2e00`, `0x2e40` are in VRAM before the
  dump starts; their pixels are in the dump's state blob and are not extracted yet.
- Vertex colours, texture coordinates and depth values per draw are in
  `rom-0230A-clock.jsonl`; this page does not summarize them.
- Frames 0 and 2 draw to `0x000` where frames 1 and 3 draw to `0x046`; only frame 1 was
  broken down here. Frame 0 has five more draws than the others, not examined.
