import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GsState } from '../dist/gs/state.js';
import { DrawAssembler } from '../dist/gs/draws.js';
import { REG } from '../dist/gs/registers.js';

const OFFSET = 0x0000800000008000n;
const xyz = (px, py, z = 0) => BigInt(0x8000 + px * 16) | (BigInt(0x8000 + py * 16) << 16n) | (BigInt(z) << 32n);

function assembler(prim) {
  const state = GsState.empty();
  const draws = new DrawAssembler(state);
  draws.apply(REG.XYOFFSET_1, OFFSET);
  draws.apply(REG.XYOFFSET_2, OFFSET);
  draws.apply(REG.PRIM, BigInt(prim));
  return draws;
}
const finish = (draws) => { draws.endFrame(); return draws.take(); };

test('a triangle strip of five kicks is one draw of three triangles', () => {
  const draws = assembler(4);
  [[0, 0], [10, 0], [0, 10], [10, 10], [0, 20]].forEach(([x, y]) => draws.apply(REG.XYZ2, xyz(x, y)));
  const [draw, ...rest] = finish(draws);
  assert.equal(rest.length, 0);
  assert.equal(draw.primitive, 'tristrip');
  assert.equal(draw.primitives, 3);
  assert.equal(draw.vertices.length, 5);
  assert.deepEqual(draw.indices, [0, 1, 2, 1, 2, 3, 2, 3, 4]);
  assert.deepEqual(draw.bbox, [0, 0, 10, 20]);
  assert.equal(draw.frame, 0);
});

test('a triangle fan keeps its first vertex in every triangle', () => {
  const draws = assembler(5);
  [[5, 5], [10, 0], [10, 10], [0, 10], [0, 0]].forEach(([x, y]) => draws.apply(REG.XYZ2, xyz(x, y)));
  const [draw] = finish(draws);
  assert.equal(draw.primitives, 3);
  assert.deepEqual(draw.indices, [0, 1, 2, 0, 2, 3, 0, 3, 4]);
});

test('a sprite is two kicks, and its box is the two corners in pixels', () => {
  const draws = assembler(6);
  draws.apply(REG.XYZ2, xyz(16, 32));
  draws.apply(REG.XYZ2, xyz(48, 64));
  const [draw] = finish(draws);
  assert.equal(draw.primitive, 'sprite');
  assert.equal(draw.primitives, 1);
  assert.deepEqual(draw.bbox, [16, 32, 48, 64]);
  assert.deepEqual([draw.vertices[0].px, draw.vertices[0].py, draw.vertices[0].x], [16, 32, 0x8000 + 16 * 16]);
});

test('separate triangles and lines take three and two kicks each', () => {
  const triangles = assembler(3);
  for (let i = 0; i < 7; i++) triangles.apply(REG.XYZ2, xyz(i, i));
  assert.equal(finish(triangles)[0].primitives, 2);
  const lines = assembler(1);
  for (let i = 0; i < 5; i++) lines.apply(REG.XYZ2, xyz(i, i));
  assert.equal(finish(lines)[0].primitives, 2);
  const strip = assembler(2);
  for (let i = 0; i < 5; i++) strip.apply(REG.XYZ2, xyz(i, i));
  assert.equal(finish(strip)[0].primitives, 4);
});

test('a kick without drawing fills the queue but draws nothing', () => {
  const draws = assembler(4);
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.XYZ2, xyz(10, 0));
  draws.apply(REG.XYZ3, xyz(0, 10));
  draws.apply(REG.XYZ2, xyz(10, 10));
  const [draw] = finish(draws);
  assert.equal(draw.primitives, 1);
  assert.deepEqual(draw.vertices.map((v) => [v.px, v.py]), [[10, 0], [0, 10], [10, 10]]);
});

test('XYZF carries fog in the vertex and still kicks', () => {
  const draws = assembler(6);
  draws.apply(REG.XYZF2, xyz(0, 0) & 0xffffffffffffffn | (0x40n << 56n));
  draws.apply(REG.XYZF2, xyz(8, 8) & 0xffffffffffffffn | (0x40n << 56n));
  const [draw] = finish(draws);
  assert.equal(draw.primitives, 1);
  assert.equal(draw.vertices[0].fog, 0x40);
});

test('rewriting PRIM restarts the queue: no primitive spans the write', () => {
  const draws = assembler(4);
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.XYZ2, xyz(10, 0));
  draws.apply(REG.PRIM, 4n);
  draws.apply(REG.XYZ2, xyz(0, 10));
  draws.apply(REG.XYZ2, xyz(10, 10));
  assert.deepEqual(finish(draws), []);
});

test('a vertex takes the colour and texture coordinates current at its kick', () => {
  const draws = assembler(6);
  draws.apply(REG.RGBAQ, 0x3f800000_80402010n);
  draws.apply(REG.UV, (0x0200n << 16n) | 0x0100n);
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.RGBAQ, 0x3f800000_ff000000n);
  draws.apply(REG.ST, 0x3f0000003e800000n);
  draws.apply(REG.XYZ2, xyz(8, 8));
  const [draw] = finish(draws);
  assert.deepEqual(draw.vertices[0].rgba, [0x10, 0x20, 0x40, 0x80]);
  assert.deepEqual([draw.vertices[0].u, draw.vertices[0].v], [16, 32]);
  assert.deepEqual(draw.vertices[1].rgba, [0, 0, 0, 0xff]);
  assert.deepEqual([draw.vertices[1].s, draw.vertices[1].t, draw.vertices[1].q], [0.25, 0.5, 1]);
});

test('a state change between primitives splits the draw, each with its own state', () => {
  const draws = assembler(3);
  draws.apply(REG.ALPHA_1, 0x44n);
  for (let i = 0; i < 3; i++) draws.apply(REG.XYZ2, xyz(i, i));
  draws.apply(REG.ALPHA_1, 0x64n);
  for (let i = 0; i < 3; i++) draws.apply(REG.XYZ2, xyz(i, i));
  const [first, second, ...rest] = finish(draws);
  assert.equal(rest.length, 0);
  assert.equal(first.state.ALPHA, '0x0000000000000044');
  assert.equal(second.state.ALPHA, '0x0000000000000064');
  assert.deepEqual([first.index, second.index], [0, 1]);
});

test('rewriting a register with the same value does not split the draw', () => {
  const draws = assembler(3);
  draws.apply(REG.ALPHA_1, 0x44n);
  for (let i = 0; i < 3; i++) draws.apply(REG.XYZ2, xyz(i, i));
  draws.apply(REG.ALPHA_1, 0x44n);
  for (let i = 0; i < 3; i++) draws.apply(REG.XYZ2, xyz(i, i));
  const all = finish(draws);
  assert.equal(all.length, 1);
  assert.equal(all[0].primitives, 2);
});

test('a context-2 primitive takes its state from context 2', () => {
  const draws = assembler(3 | (1 << 9));
  draws.apply(REG.ALPHA_1, 0x44n);
  draws.apply(REG.ALPHA_2, 0x64n);
  for (let i = 0; i < 3; i++) draws.apply(REG.XYZ2, xyz(i, i));
  const [draw] = finish(draws);
  assert.equal(draw.context, 1);
  assert.equal(draw.state.ALPHA, '0x0000000000000064');
});

test('endFrame closes the open draw and numbers the next frame', () => {
  const draws = assembler(6);
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.XYZ2, xyz(8, 8));
  draws.endFrame();
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.XYZ2, xyz(8, 8));
  draws.endFrame();
  assert.deepEqual(draws.take().map((d) => d.frame), [0, 1]);
  assert.deepEqual(draws.take(), []);
});

test('a transfer between two primitives of equal state ends the draw', () => {
  const draws = assembler(6);
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.XYZ2, xyz(8, 8));
  draws.apply(REG.TRXDIR, 0n);
  draws.apply(REG.XYZ2, xyz(0, 0));
  draws.apply(REG.XYZ2, xyz(8, 8));
  assert.deepEqual(finish(draws).map((d) => d.primitives), [1, 1]);
});

test('an XYZF kick leaves its fog for a later XYZ kick', () => {
  const draws = assembler(6);
  draws.apply(REG.XYZF2, xyz(0, 0) & 0xffffffffffffffn | (0x40n << 56n));
  draws.apply(REG.XYZ2, xyz(8, 8));
  const [draw] = finish(draws);
  assert.deepEqual(draw.vertices.map((v) => v.fog), [0x40, 0x40]);
});

test('primitive type 7 draws nothing and keeps no vertices', () => {
  const draws = assembler(7);
  for (let i = 0; i < 1000; i++) draws.apply(REG.XYZ2, xyz(i % 10, 0));
  assert.deepEqual(finish(draws), []);
  assert.equal(draws.queued, 0);
});
