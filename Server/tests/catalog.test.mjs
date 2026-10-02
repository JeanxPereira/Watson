import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findConfig, loadCatalog, resolveLaunch, registerState, describeStates } from '../dist/catalog.js';

function project(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-consumer-'));
  const file = path.join(dir, 'watson.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return { dir, file };
}

const VALID = {
  schema: 1,
  watson: '0.1',
  builds: [
    { id: 'rom-0230A', launch: { bios: 'bios/rom.bin' }, states: { clock: 'states/clock.p2s', menu: 'states/menu.p2s' } },
    { id: 'hddosd-1.10U', launch: { bios: 'bios/rom.bin', elf: 'elf/hddosd.elf' } },
  ],
};

test('findConfig prefers the explicit file, then walks up from the start directory', () => {
  const { dir, file } = project(VALID);
  const deep = path.join(dir, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findConfig(deep), file);
  assert.equal(findConfig(os.tmpdir(), file), file);
  assert.equal(findConfig(path.parse(dir).root), null);
});

test('loadCatalog resolves every path against the file that names it', () => {
  const { dir, file } = project(VALID);
  const catalog = loadCatalog(file);
  assert.equal(catalog.builds[0].bios, path.join(dir, 'bios', 'rom.bin'));
  assert.equal(catalog.builds[0].states.clock, path.join(dir, 'states', 'clock.p2s'));
  assert.equal(catalog.builds[1].elf, path.join(dir, 'elf', 'hddosd.elf'));
  assert.deepEqual(Object.keys(catalog.builds[1].states), []);
});

test('loadCatalog refuses a bad file and names what it refused', () => {
  const cases = [
    ['{ not json', /not valid JSON/],
    [{ ...VALID, schema: 2 }, /schema must be 1/],
    [{ ...VALID, builds: [] }, /builds must list at least one build/],
    [{ ...VALID, builds: [{ id: 'x', launch: {} }] }, /build x: launch needs a bios or an elf/],
    [{ ...VALID, builds: [VALID.builds[0], VALID.builds[0]] }, /build id rom-0230A appears twice/],
    [{ ...VALID, builds: [{ id: 'x', launch: { bios: 'b' }, states: { 'Bad Name': 's' } }] }, /build x: state name "Bad Name"/],
  ];
  for (const [config, pattern] of cases) {
    const { file } = project(config);
    assert.throws(() => loadCatalog(file), (error) => {
      assert.match(error.message, pattern);
      assert.ok(error.message.includes(file), 'the message names the file');
      return true;
    });
  }
});

test('resolveLaunch turns a build and a state name into the files to launch', () => {
  const { dir, file } = project(VALID);
  const catalog = loadCatalog(file);
  assert.deepEqual(resolveLaunch(catalog, { build: 'rom-0230A', state: 'clock' }), {
    bios: path.join(dir, 'bios', 'rom.bin'), elf: undefined, state: path.join(dir, 'states', 'clock.p2s'),
  });
  assert.deepEqual(resolveLaunch(catalog, { build: 'hddosd-1.10U' }), {
    bios: path.join(dir, 'bios', 'rom.bin'), elf: path.join(dir, 'elf', 'hddosd.elf'), state: undefined,
  });
});

test('resolveLaunch passes a state given as a file path through untouched', () => {
  const { file } = project(VALID);
  const launch = resolveLaunch(loadCatalog(file), { build: 'rom-0230A', state: 'D:/elsewhere/other.p2s' });
  assert.equal(launch.state, 'D:/elsewhere/other.p2s');
});

test('resolveLaunch names the choices when the build or the state is unknown', () => {
  const { file } = project(VALID);
  const catalog = loadCatalog(file);
  assert.throws(() => resolveLaunch(catalog, { build: 'rom-9999' }), /unknown build rom-9999; known: rom-0230A, hddosd-1\.10U/);
  assert.throws(() => resolveLaunch(catalog, { build: 'rom-0230A', state: 'browser' }), /build rom-0230A has no state browser; known: clock, menu/);
  assert.throws(() => resolveLaunch(catalog, { build: 'hddosd-1.10U', state: 'clock' }), /build hddosd-1\.10U has no state clock; known: none/);
});

test('resolveLaunch without a catalog accepts only explicit files', () => {
  assert.deepEqual(resolveLaunch(null, { bios: 'D:/b.bin', state: 'D:/s.p2s' }), { bios: 'D:/b.bin', elf: undefined, state: 'D:/s.p2s' });
  assert.throws(() => resolveLaunch(null, { build: 'rom-0230A' }), /no watson\.json was found, so build rom-0230A cannot be resolved/);
});

test('registerState adds the state to its build and keeps the rest of the file', () => {
  const { dir, file } = project({ ...VALID, note: 'kept' });
  registerState(file, 'hddosd-1.10U', 'boot', path.join(dir, 'states', 'hdd-boot.p2s'));
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.note, 'kept');
  assert.equal(written.builds[1].states.boot, 'states/hdd-boot.p2s');
  assert.equal(written.builds[0].states.clock, 'states/clock.p2s');
  assert.equal(loadCatalog(file).builds[1].states.boot, path.join(dir, 'states', 'hdd-boot.p2s'));
});

test('registerState refuses an unknown build and a malformed name', () => {
  const { dir, file } = project(VALID);
  assert.throws(() => registerState(file, 'nope', 'boot', path.join(dir, 's.p2s')), /unknown build nope/);
  assert.throws(() => registerState(file, 'rom-0230A', 'Not Valid', path.join(dir, 's.p2s')), /state name "Not Valid"/);
});

test('describeStates lists every state with whether its file exists', () => {
  const { dir, file } = project(VALID);
  fs.mkdirSync(path.join(dir, 'states'));
  fs.writeFileSync(path.join(dir, 'states', 'clock.p2s'), 'x');
  const lines = describeStates(loadCatalog(file));
  assert.deepEqual(lines, [
    `rom-0230A  clock  ${path.join(dir, 'states', 'clock.p2s')}`,
    `rom-0230A  menu  ${path.join(dir, 'states', 'menu.p2s')}  (file missing)`,
    'hddosd-1.10U  (no states)',
  ]);
});

test('loadCatalog reads how many emulators may run side by side', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-instances-'));
  const file = path.join(dir, 'watson.json');
  const write = (extra) => fs.writeFileSync(file, JSON.stringify({ schema: 1, builds: [{ id: 'a', launch: { bios: 'a.bin' } }], ...extra }));
  write({});
  assert.equal(loadCatalog(file).instances, 1);
  write({ instances: 5 });
  assert.equal(loadCatalog(file).instances, 5);
  write({ instances: 0 });
  assert.throws(() => loadCatalog(file), /instances must be a whole number from 1 to 8/);
});
