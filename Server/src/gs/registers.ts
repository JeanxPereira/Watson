/**
 * GS general-purpose registers: their addresses in the A+D space, their names, and the fields
 * of the ones a draw depends on. Layouts follow pcsx2/GS/GSRegs.h and the GS manual.
 */
export const REG = {
  PRIM: 0x00, RGBAQ: 0x01, ST: 0x02, UV: 0x03, XYZF2: 0x04, XYZ2: 0x05,
  TEX0_1: 0x06, TEX0_2: 0x07, CLAMP_1: 0x08, CLAMP_2: 0x09, FOG: 0x0a,
  XYZF3: 0x0c, XYZ3: 0x0d, NOP: 0x0f,
  TEX1_1: 0x14, TEX1_2: 0x15, TEX2_1: 0x16, TEX2_2: 0x17,
  XYOFFSET_1: 0x18, XYOFFSET_2: 0x19, PRMODECONT: 0x1a, PRMODE: 0x1b, TEXCLUT: 0x1c,
  SCANMSK: 0x22, MIPTBP1_1: 0x34, MIPTBP1_2: 0x35, MIPTBP2_1: 0x36, MIPTBP2_2: 0x37,
  TEXA: 0x3b, FOGCOL: 0x3d, TEXFLUSH: 0x3f,
  SCISSOR_1: 0x40, SCISSOR_2: 0x41, ALPHA_1: 0x42, ALPHA_2: 0x43,
  DIMX: 0x44, DTHE: 0x45, COLCLAMP: 0x46, TEST_1: 0x47, TEST_2: 0x48, PABE: 0x49,
  FBA_1: 0x4a, FBA_2: 0x4b, FRAME_1: 0x4c, FRAME_2: 0x4d, ZBUF_1: 0x4e, ZBUF_2: 0x4f,
  BITBLTBUF: 0x50, TRXPOS: 0x51, TRXREG: 0x52, TRXDIR: 0x53, HWREG: 0x54,
  SIGNAL: 0x60, FINISH: 0x61, LABEL: 0x62,
} as const;

const NAMES = new Map<number, string>(Object.entries(REG).map(([name, address]) => [address, name]));

export function registerName(address: number): string {
  return NAMES.get(address) ?? `0x${address.toString(16).padStart(2, '0')}`;
}

export function hex64(value: bigint): string {
  return `0x${BigInt.asUintN(64, value).toString(16).padStart(16, '0')}`;
}

/** [field name, first bit, width]. A width of 0 marks an IEEE-754 single at that bit. */
type Field = readonly [string, number, number];

const XYZ: Field[] = [['X', 0, 16], ['Y', 16, 16], ['Z', 32, 32]];
const XYZF: Field[] = [['X', 0, 16], ['Y', 16, 16], ['Z', 32, 24], ['F', 56, 8]];

const LAYOUTS: Record<string, Field[]> = {
  PRIM: [['PRIM', 0, 3], ['IIP', 3, 1], ['TME', 4, 1], ['FGE', 5, 1], ['ABE', 6, 1], ['AA1', 7, 1], ['FST', 8, 1], ['CTXT', 9, 1], ['FIX', 10, 1]],
  PRMODE: [['IIP', 3, 1], ['TME', 4, 1], ['FGE', 5, 1], ['ABE', 6, 1], ['AA1', 7, 1], ['FST', 8, 1], ['CTXT', 9, 1], ['FIX', 10, 1]],
  PRMODECONT: [['AC', 0, 1]],
  RGBAQ: [['R', 0, 8], ['G', 8, 8], ['B', 16, 8], ['A', 24, 8], ['Q', 32, 0]],
  ST: [['S', 0, 0], ['T', 32, 0]],
  UV: [['U', 0, 16], ['V', 16, 16]],
  XYZ2: XYZ, XYZ3: XYZ, XYZF2: XYZF, XYZF3: XYZF,
  FOG: [['F', 56, 8]],
  TEX0: [['TBP0', 0, 14], ['TBW', 14, 6], ['PSM', 20, 6], ['TW', 26, 4], ['TH', 30, 4], ['TCC', 34, 1], ['TFX', 35, 2], ['CBP', 37, 14], ['CPSM', 51, 4], ['CSM', 55, 1], ['CSA', 56, 5], ['CLD', 61, 3]],
  TEX1: [['LCM', 0, 1], ['MXL', 2, 3], ['MMAG', 5, 1], ['MMIN', 6, 3], ['MTBA', 9, 1], ['L', 19, 2], ['K', 32, 12]],
  CLAMP: [['WMS', 0, 2], ['WMT', 2, 2], ['MINU', 4, 10], ['MAXU', 14, 10], ['MINV', 24, 10], ['MAXV', 34, 10]],
  XYOFFSET: [['OFX', 0, 16], ['OFY', 32, 16]],
  SCISSOR: [['SCAX0', 0, 11], ['SCAX1', 16, 11], ['SCAY0', 32, 11], ['SCAY1', 48, 11]],
  ALPHA: [['A', 0, 2], ['B', 2, 2], ['C', 4, 2], ['D', 6, 2], ['FIX', 32, 8]],
  TEST: [['ATE', 0, 1], ['ATST', 1, 3], ['AREF', 4, 8], ['AFAIL', 12, 2], ['DATE', 14, 1], ['DATM', 15, 1], ['ZTE', 16, 1], ['ZTST', 17, 2]],
  FRAME: [['FBP', 0, 9], ['FBW', 16, 6], ['PSM', 24, 6], ['FBMSK', 32, 32]],
  ZBUF: [['ZBP', 0, 9], ['PSM', 24, 4], ['ZMSK', 32, 1]],
  TEXA: [['TA0', 0, 8], ['AEM', 15, 1], ['TA1', 32, 8]],
  FOGCOL: [['FCR', 0, 8], ['FCG', 8, 8], ['FCB', 16, 8]],
  TEXCLUT: [['CBW', 0, 6], ['COU', 6, 6], ['COV', 12, 10]],
  COLCLAMP: [['CLAMP', 0, 1]],
  DTHE: [['DTHE', 0, 1]],
  PABE: [['PABE', 0, 1]],
  FBA: [['FBA', 0, 1]],
  BITBLTBUF: [['SBP', 0, 14], ['SBW', 16, 6], ['SPSM', 24, 6], ['DBP', 32, 14], ['DBW', 48, 6], ['DPSM', 56, 6]],
  TRXPOS: [['SSAX', 0, 11], ['SSAY', 16, 11], ['DSAX', 32, 11], ['DSAY', 48, 11], ['DIR', 59, 2]],
  TRXREG: [['RRW', 0, 12], ['RRH', 32, 12]],
  TRXDIR: [['XDIR', 0, 2]],
};

const floatView = new DataView(new ArrayBuffer(4));

function float32(bits: number): number {
  floatView.setUint32(0, bits >>> 0);
  return floatView.getFloat32(0);
}

/** Named fields of a register value; `{}` when the register has no layout here. */
export function decodeRegister(name: string, value: bigint): Record<string, number> {
  const layout = LAYOUTS[name] ?? LAYOUTS[name.replace(/_[12]$/, '')];
  if (!layout) return {};
  const fields: Record<string, number> = {};
  for (const [field, bit, width] of layout) {
    if (width === 0) {
      fields[field] = float32(Number((value >> BigInt(bit)) & 0xffffffffn));
    } else {
      fields[field] = Number((value >> BigInt(bit)) & ((1n << BigInt(width)) - 1n));
    }
  }
  return fields;
}
