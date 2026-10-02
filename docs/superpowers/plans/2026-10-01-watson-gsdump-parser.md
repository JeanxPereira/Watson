# Watson GS Dump Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a PCSX2 GS dump into a machine-readable list of what the Graphics Synthesizer was told to draw: every register write, and every draw with its primitive, vertices and the register state in force.

**Architecture:** Four pure modules under `Server/src/gs/`, each fed by the one before: register names and field decoders; a GIF stream decoder that turns transfer bytes into register writes; a state tracker seeded from the dump's state blob; a draw assembler that applies the GS vertex-kick rules. `parse.ts` wires them over the packet walk and writes JSON Lines. One MCP tool and one CLI entry call it.

**Tech Stack:** TypeScript on Node 22.15+, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-watson-design.md` section 5.4 (this is the spec's phase 1).

## Global Constraints

- Windows only. Node 22.15 or newer. No new npm dependencies.
- The parser needs no running emulator and never touches the network.
- Format authority: `References/pcsx2/pcsx2/GS/GSDump.cpp`, `GSState.cpp`, `GSRegs.h` at the pinned tag `v2.9.94`. Where this plan and that source disagree, the source wins and the difference is ledgered.
- 64-bit register values are `bigint` in memory and `0x`-prefixed 16-digit lowercase hex strings in JSON. Never `number`: a 64-bit value does not fit.
- Vertex coordinates are reported twice: raw 12.4 fixed point as written, and pixels after subtracting `XYOFFSET` and dividing by 16.
- A dump that the packet walk does not find complete is refused; nothing is parsed from a truncated file.
- Every summary ends with the two contract lines of spec section 6; the build is `unknown` until phase 3.
- Tool names are prefixed `watson_`.
- No credit or attribution to an AI anywhere.
- Commit subject: `Type(Scope): Imperative description`, at most 72 characters.

## Out of scope, by decision

- `watson_gsdump_render`. `pcsx2-gsrunner` built from the pinned tag initializes and then renders no frame on this machine, with or without `-surfaceless`; the cause is not yet known. The live PNG captured with each dump stands in for it. Recorded as an open problem, not solved here.
- Decoding `IMAGE` transfers into pixels, texture extraction from VRAM, CLUT lookup. The parser records that image data was sent, how much, and to where.
- Zstandard and LZMA dumps. Watson's captures are uncompressed.

## Review Focus

1. **A GIF packet split across two transfer packets.** Expected: decoded exactly as if it had arrived whole. Pinned in Task 2.
2. **A dump whose first transfer continues a packet begun before the dump started** (path state in the state blob has `NLOOP` > 0). Expected: the remainder is decoded with the saved tag, not misread as a new tag. Pinned in Task 3.
3. **`XYZ3`/`XYZF3`, and the ADC bit in packed `XYZ2`/`XYZF2`.** Expected: the vertex enters the queue and no primitive is drawn by that kick. Pinned in Task 4.
4. **A register address the table does not know.** Expected: recorded by number as `0x..`, counted in the summary, and parsing continues. Pinned in Task 1 and Task 5.
5. **A truncated dump.** Expected: refused with the walk's reason; no output file is left behind. Pinned in Task 5.

---

## File Structure

| Path | Responsibility |
|---|---|
| `Server/src/gs/registers.ts` | Register addresses, names, and per-register field decoding. |
| `Server/src/gs/gif.ts` | GIF tag and data decoding for one path: bytes in, register writes and image-data events out. |
| `Server/src/gs/state.ts` | Register state: seeded from the state blob, updated by writes, read per context. |
| `Server/src/gs/draws.ts` | Vertex queue and primitive assembly; groups primitives into draws by state. |
| `Server/src/gs/parse.ts` | Walks the dump, drives the modules, writes JSON Lines, builds the summary. |
| `Server/src/cli.ts` | `watson gsdump parse <file> [--out <file>]`. |
| `Server/src/index.ts` | Registers `watson_gsdump_parse`. |
| `Server/tests/gs-*.test.mjs` | One test file per module, plus `gs-parse.test.mjs` over a synthetic dump. |

---

### Task 1: Registers

**Files:** Create `Server/src/gs/registers.ts`, `Server/tests/gs-registers.test.mjs`.

**Interfaces — produces:**
- `registerName(address: number): string` — the name, or `0x` + two hex digits when unknown.
- `REG: Record<string, number>` — name to address.
- `decodeRegister(name: string, value: bigint): Record<string, number | string>` — named fields; `{}` for a register with no decoder. Floats (`RGBAQ.Q`, `ST.S`, `ST.T`) are decoded from their IEEE-754 bits.
- `hex64(value: bigint): string`.

Addresses (A+D space): `PRIM 00, RGBAQ 01, ST 02, UV 03, XYZF2 04, XYZ2 05, TEX0_1 06, TEX0_2 07, CLAMP_1 08, CLAMP_2 09, FOG 0A, XYZF3 0C, XYZ3 0D, NOP 0F, TEX1_1 14, TEX1_2 15, TEX2_1 16, TEX2_2 17, XYOFFSET_1 18, XYOFFSET_2 19, PRMODECONT 1A, PRMODE 1B, TEXCLUT 1C, SCANMSK 22, MIPTBP1_1 34, MIPTBP1_2 35, MIPTBP2_1 36, MIPTBP2_2 37, TEXA 3B, FOGCOL 3D, TEXFLUSH 3F, SCISSOR_1 40, SCISSOR_2 41, ALPHA_1 42, ALPHA_2 43, DIMX 44, DTHE 45, COLCLAMP 46, TEST_1 47, TEST_2 48, PABE 49, FBA_1 4A, FBA_2 4B, FRAME_1 4C, FRAME_2 4D, ZBUF_1 4E, ZBUF_2 4F, BITBLTBUF 50, TRXPOS 51, TRXREG 52, TRXDIR 53, HWREG 54, SIGNAL 60, FINISH 61, LABEL 62`.

Fields (bit position : width), least significant first:
- `PRIM`: PRIM 0:3, IIP 3:1, TME 4:1, FGE 5:1, ABE 6:1, AA1 7:1, FST 8:1, CTXT 9:1, FIX 10:1.
- `RGBAQ`: R 0:8, G 8:8, B 16:8, A 24:8, Q float at 32.
- `ST`: S float at 0, T float at 32.
- `UV`: U 0:16, V 16:16 (12.4 fixed).
- `XYZ2`/`XYZ3`: X 0:16, Y 16:16, Z 32:32. `XYZF2`/`XYZF3`: X 0:16, Y 16:16, Z 32:24, F 56:8.
- `FOG`: F 56:8.
- `TEX0`: TBP0 0:14, TBW 14:6, PSM 20:6, TW 26:4, TH 30:4, TCC 34:1, TFX 35:2, CBP 37:14, CPSM 51:4, CSM 55:1, CSA 56:5, CLD 61:3.
- `TEX1`: LCM 0:1, MXL 2:3, MMAG 5:1, MMIN 6:3, MTBA 9:1, L 19:2, K 32:12.
- `CLAMP`: WMS 0:2, WMT 2:2, MINU 4:10, MAXU 14:10, MINV 24:10, MAXV 34:10.
- `XYOFFSET`: OFX 0:16, OFY 32:16.
- `SCISSOR`: SCAX0 0:11, SCAX1 16:11, SCAY0 32:11, SCAY1 48:11.
- `ALPHA`: A 0:2, B 2:2, C 4:2, D 6:2, FIX 32:8.
- `TEST`: ATE 0:1, ATST 1:3, AREF 4:8, AFAIL 12:2, DATE 14:1, DATM 15:1, ZTE 16:1, ZTST 17:2.
- `FRAME`: FBP 0:9, FBW 16:6, PSM 24:6, FBMSK 32:32. `ZBUF`: ZBP 0:9, PSM 24:4, ZMSK 32:1.
- `TEXA`: TA0 0:8, AEM 15:1, TA1 32:8. `FOGCOL`: FCR 0:8, FCG 8:8, FCB 16:8.
- `COLCLAMP`: CLAMP 0:1. `DTHE`: DTHE 0:1. `PABE`: PABE 0:1. `FBA`: FBA 0:1. `PRMODECONT`: AC 0:1.
- `BITBLTBUF`: SBP 0:14, SBW 16:6, SPSM 24:6, DBP 32:14, DBW 48:6, DPSM 56:6.
- `TRXPOS`: SSAX 0:11, SSAY 16:11, DSAX 32:11, DSAY 48:11, DIR 59:2. `TRXREG`: RRW 0:12, RRH 32:12. `TRXDIR`: XDIR 0:2.

Tests (write first, see them fail on the missing module, then implement):
- `registerName(0x42) === 'ALPHA_1'`; `registerName(0x7e) === '0x7e'`.
- `decodeRegister('ALPHA_1', 0x0000008000000044n)` → `{ A: 0, B: 1, C: 0, D: 1, FIX: 128 }`.
- `decodeRegister('PRIM', 0x15bn)` → `{ PRIM: 3, IIP: 1, TME: 1, FGE: 0, ABE: 1, AA1: 0, FST: 1, CTXT: 0, FIX: 0 }`.
- `decodeRegister('RGBAQ', 0x3f80000080402010n)` → `{ R: 0x10, G: 0x20, B: 0x40, A: 0x80, Q: 1 }`.
- `decodeRegister('TEX0_1', value)` for a value built from TBP0 0x2000, TBW 4, PSM 0x13, TW 8, TH 8, TCC 1, TFX 0, CBP 0x3000, CPSM 0, CSM 0, CSA 0, CLD 1 returns exactly those fields.
- `decodeRegister('FRAME_1', 0x00000000000a0000n)` → FBP 0, FBW 10, PSM 0, FBMSK 0.
- `decodeRegister('SIGNAL', 1n)` → `{}`.
- `hex64(0x44n) === '0x0000000000000044'`.

Commit: `Feat(Server): Name and decode GS registers`.

---

### Task 2: GIF stream decoder

**Files:** Create `Server/src/gs/gif.ts`, `Server/tests/gs-gif.test.mjs`.

**Interfaces — consumes** `REG`. **Produces:**
- `interface GifEvent { kind: 'write'; reg: number; value: bigint } | { kind: 'tag'; nloop: number; eop: boolean; pre: boolean; prim: number; flg: number; nreg: number; regs: number[] } | { kind: 'image'; bytes: number }`.
- `class GifPath { constructor(saved?: { tag: Buffer; reg: number }); feed(chunk: Buffer): GifEvent[]; get pendingBytes(): number }`.

Rules, from `GSState.cpp` and the GS manual:
- A tag is 16 bytes: NLOOP 0:15, EOP 15:1, PRE 46:1, PRIM 47:11, FLG 58:2, NREG 60:4 (0 means 16), REGS 64:64 as 4-bit descriptors.
- `FLG 0` PACKED: `NLOOP × NREG` qwords of 16 bytes. If PRE, emit a `PRIM` write of the tag's PRIM before the data. Per descriptor:
  `0` PRIM: low 11 bits. `1` RGBAQ: R = byte 0, G = byte 4, B = byte 8, A = byte 12, Q = the last Q latched by a packed ST. `2` ST: low 64 bits to `ST`; latch Q = bits 64..95. `3` UV: U = bits 0..13, V = bits 32..45, written as `UV` with V at bit 16. `4` XYZF2: X bits 0..15, Y bits 32..47, Z bits 68..91, F bits 100..107; if bit 111 (ADC) is set the write is `XYZF3`. `5` XYZ2: X bits 0..15, Y bits 32..47, Z bits 64..95; ADC makes it `XYZ3`. `6`,`7` TEX0_1/2 and `8`,`9` CLAMP_1/2: low 64 bits. `A` FOG: F bits 100..107, written to bits 56..63 of `FOG`. `C` as `4` but always `XYZF3`; `D` as `5` but always `XYZ3`. `E` A+D: address = bits 64..71 masked with 0x7F, value = low 64 bits. `F` and `B`: nothing.
- `FLG 1` REGLIST: `NLOOP × NREG` values of 8 bytes, padded to a 16-byte boundary at the end; each written to the register its descriptor names (descriptors `E` and `F` write nothing).
- `FLG 2` and `3` IMAGE: `NLOOP` qwords; one `image` event with `NLOOP × 16` bytes.
- `NLOOP 0`: the tag carries no data.
- Bytes that do not complete a tag or a datum stay buffered until the next `feed`.

Tests:
- PACKED, NREG 1, descriptor `E`, two loops: two A+D writes come out in order with the right address and value.
- PACKED `2,1,4` (ST, RGBAQ, XYZF2), one loop: `ST` write; `RGBAQ` write whose Q field equals the packed Q; `XYZF2` write with X, Y, Z, F in register positions.
- Same with ADC set: the last write is `XYZF3`.
- Descriptor `D`: write is `XYZ3` without ADC.
- PRE set with PRIM 0x15b: first event after the tag is a `PRIM` write of `0x15bn`.
- REGLIST with NREG 3, NLOOP 1 (odd count): three writes, and the padding qword half is skipped so a following tag decodes.
- IMAGE with NLOOP 4: one `image` event of 64 bytes, then a following tag decodes.
- NLOOP 0 followed by another tag: both tags reported, no writes from the first.
- A tag and its data split at every byte offset across two `feed` calls give the same events as one call. (Review Focus 1.)

Commit: `Feat(Server): Decode GIF tags and data into GS register writes`.

---

### Task 3: State

**Files:** Create `Server/src/gs/state.ts`, `Server/tests/gs-state.test.mjs`.

**Interfaces — consumes** `REG`, `registerName`, `decodeRegister`, `hex64`. **Produces:**
- `class GsState { static fromBlob(blob: Buffer): GsState; static empty(): GsState; write(reg: number, value: bigint): void; get(name: string): bigint; context(index: 0 | 1): Record<string, bigint>; snapshot(ctxt: 0 | 1): Record<string, string>; savedPaths: { tag: Buffer; reg: number }[]; vramOffset: number }`.
- `snapshot(ctxt)` returns hex strings for: `PRIM`, `FRAME`, `ZBUF`, `TEX0`, `TEX1`, `CLAMP`, `ALPHA`, `TEST`, `SCISSOR`, `XYOFFSET`, `FBA`, `TEXA`, `FOGCOL`, `COLCLAMP`, `DTHE`, `PABE`, `DIMX`, `TEXCLUT`, `PRMODECONT`, context registers without their `_1`/`_2` suffix.

State blob layout (`GSState::Freeze`, version 9), all little-endian:
- offset 0: `u32` version.
- offset 4, 8 bytes each: `PRIM, PRMODECONT, TEXCLUT, SCANMSK, TEXA, FOGCOL, DIMX, DTHE, COLCLAMP, PABE, BITBLTBUF, TRXDIR, TRXPOS, TRXREG, TRXREG`.
- offset 124, context 1 then context 2, 8 bytes each: `XYOFFSET, TEX0, TEX1, CLAMP, MIPTBP1, MIPTBP2, SCISSOR, ALPHA, TEST, FBA, FRAME, ZBUF`.
- offset 316: `RGBAQ, ST, UV, FOG, XYZ`, 8 bytes each, then 8 obsolete bytes.
- counted from the end of the blob: 4 bytes `q`; before it four paths of 20 bytes (16-byte tag, `u32` reg); before those 4 194 304 bytes of VRAM. `vramOffset = blob.length - 4 - 80 - 4194304`.

`PRMODE` writes update `PRIM`'s bits 3..10 only when `PRMODECONT.AC` is 0 is a GS rule the draws need; `write` stores `PRMODE` and `PRIM` separately and `effectivePrim(): bigint` applies it: with AC = 1 the result is `PRIM`; with AC = 0 it is `PRIM`'s low 3 bits with `PRMODE`'s bits 3..10.

Tests:
- A blob built with known values at the offsets above reads back through `get` and `context`.
- `write(REG.ALPHA_2, v)` changes context 1 only.
- `snapshot(0)` has `ALPHA` equal to `ALPHA_1` and no `ALPHA_1` key.
- `effectivePrim` under AC 1 and AC 0.
- A blob whose first saved path has NLOOP 3: `savedPaths[0].tag` has NLOOP 3, and a `GifPath` built from it decodes the next 3 loops with the saved descriptors and no tag event. (Review Focus 2.)
- `fromBlob` on a blob shorter than the fixed part throws naming the length.

Commit: `Feat(Server): Track GS register state from the dump state blob`.

---

### Task 4: Draws

**Files:** Create `Server/src/gs/draws.ts`, `Server/tests/gs-draws.test.mjs`.

**Interfaces — consumes** `GsState`, `REG`. **Produces:**
- `interface Vertex { x: number; y: number; z: number; px: number; py: number; rgba: [number, number, number, number]; q: number; s: number; t: number; u: number; v: number; fog: number }` (`x`,`y` raw 12.4; `px`,`py` pixels after `XYOFFSET`).
- `interface Draw { index: number; frame: number; primitive: 'point' | 'line' | 'linestrip' | 'triangle' | 'tristrip' | 'trifan' | 'sprite' | 'invalid'; context: 0 | 1; primitives: number; vertices: Vertex[]; bbox: [number, number, number, number]; state: Record<string, string> }`.
- `class DrawAssembler { constructor(state: GsState); apply(reg: number, value: bigint): void; endFrame(): void; take(): Draw[] }`. `apply` first lets the assembler see the write, then forwards it to `state.write`.

Rules:
- A write to `XYZ2`/`XYZF2` adds a vertex and kicks with drawing; `XYZ3`/`XYZF3` adds a vertex and kicks without drawing. The vertex takes the current `RGBAQ`, `ST`, `UV`, `FOG`.
- Vertices per primitive and what stays in the queue after one completes: point 1 keep 0; line 2 keep 0; linestrip 2 keep last 1; triangle 3 keep 0; tristrip 3 keep last 2; trifan 3 keep first and last; sprite 2 keep 0; type 7 never completes.
- A kick without drawing that completes a primitive discards it; the queue still advances by the same rule.
- A write to `PRIM` empties the queue.
- A draw is a run of primitives with the same effective `PRIM` and the same `snapshot` of their context. Any write that changes either closes the open draw before it applies. `endFrame` closes it and advances the frame number. Writes that change nothing do not split a draw.
- `bbox` is min/max of `px`,`py` over the draw's vertices.

Tests:
- Triangle strip, five drawing kicks: one draw, `primitives` 3, 5 vertices.
- Triangle fan, five kicks: 3 primitives; the first vertex is in every primitive (checked through a helper exposing the primitive vertex indices, `Draw.indices: number[]`).
- Sprite, two kicks: 1 primitive; `bbox` equals the two corners in pixels with `XYOFFSET` 0x8000,0x8000 subtracted.
- Strip with the third kick as `XYZ3`: the first triangle is not drawn, the second is. (Review Focus 3.)
- `PRIM` rewritten mid-strip: queue restarts; no primitive spans the write.
- `ALPHA_1` changed between two triangles: two draws, each with its own `state.ALPHA`.
- `ALPHA_1` rewritten with the same value: one draw.
- Context 2 primitive (`PRIM.CTXT` 1) takes `state` from context 2.

Commit: `Feat(Server): Assemble GS draws from vertex kicks`.

---

### Task 5: Parse, tool, CLI, and the clock dump

**Files:** Create `Server/src/gs/parse.ts`, `Server/src/cli.ts`, `Server/tests/gs-parse.test.mjs`. Modify `Server/src/index.ts`, `Server/tests/tools.test.mjs`, `Server/package.json` (`bin.watson-gsdump`).

**Interfaces — consumes** everything above and `walkGsDump`. **Produces:**
- `parseGsDump(file: string, out: string): Summary`, where `Summary` holds `frames`, `draws`, `writes`, `unknownRegisters: Record<string, number>`, `imageBytes`, `perFrame: { draws: number; primitives: number }[]`, `byPrimitive: Record<string, number>`, `alpha: Record<string, number>` (decoded `A,B,C,D,FIX` as `"(Cs-Cd)*As+Cd"`-style text keyed to a draw count), `frameTargets: Record<string, number>` (`FBP/FBW/PSM`), `textures: Record<string, number>` (`TBP0/TBW/PSM/TWxTH`), `tests: Record<string, number>`.
- `out` JSON Lines: one `{"type":"header",...}`, one `{"type":"state",...}` with the initial snapshot of both contexts, then per frame `{"type":"draw",...}` records in order and a `{"type":"frame","index":n,"draws":k}` record at each vsync.
- `formatSummary(summary, file): string` ending with `build: unknown` and `verdict: FOUND <draws> coverage <packets>/<packets>`.
- MCP tool `watson_gsdump_parse { path, out? }`; `out` defaults to the dump path with `.jsonl`.
- CLI `node dist/cli.js gsdump parse <file> [--out <file>]`, exit codes per spec section 6.

The alpha text uses the GS formula `(A - B) * C >> 7 + D` with A, B, D in `{Cs, Cd, 0}` and C in `{As, Ad, FIX}`.

Tests over a synthetic dump built in the test (header, a state blob with `XYOFFSET` set, one PATH3 transfer holding a PACKED A+D tag that sets `PRIM`, `ALPHA_1`, `FRAME_1` and a second tag drawing a 4-vertex triangle strip, a registers packet, a vsync):
- `parseGsDump` returns `frames 1`, `draws 1`, `byPrimitive { tristrip: 1 }`, and the JSONL holds header, state, one draw with 4 vertices and 2 primitives, one frame record.
- An A+D write to address `0x7e` appears in `unknownRegisters` as `{ '0x7e': 1 }` and parsing continues. (Review Focus 4.)
- A truncated copy of the dump throws with the walk's reason, and no `out` file exists afterwards. (Review Focus 5.)
- `formatSummary` ends with the two contract lines.
- `tools.test.mjs`: count 39, `watson_gsdump_parse` present.

Then, on the real capture `Runtime/captures/rom-0230A-clock.gs`:
- Run the CLI. Expected: `verdict: FOUND`, 4 frames, a non-zero draw count in each.
- Sanity checks against the live PNG beside it, each one read off the summary: every draw's `bbox` lies inside the frame the `FRAME` register describes; at least one draw has alpha blending enabled; the set of `frameTargets` is reported, since more than one target is the first evidence for or against a render-to-texture pass.
- Record what the summary shows in `docs/findings/rom-0230A-clock-gs.md`, as observations carrying the build id and the dump's SHA-256. No interpretation beyond what the numbers say.

Commit: `Feat(Server): Parse GS dumps into draws and a state summary`, then `Docs(Project): Record what the clock GS dump holds on ROM 2.30`.
