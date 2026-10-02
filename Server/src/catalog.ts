import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The consumer's watson.json: which builds it knows, how each one is launched, and the save
 * states it has named for each. A state belongs to a build; a state made on one BIOS does not
 * load on another, so a name is only meaningful inside its build.
 */
export interface Build {
  id: string;
  bios?: string;
  elf?: string;
  states: Record<string, string>;
}

export interface Catalog {
  file: string;
  builds: Build[];
  /** How many emulators may run side by side for this consumer; 1 unless it says otherwise. */
  instances: number;
}

export interface LaunchRequest { build?: string; state?: string; bios?: string; elf?: string; }
export interface LaunchFiles { bios: string | undefined; elf: string | undefined; state: string | undefined; }

const STATE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function checkStateName(name: string, where: string): void {
  if (!STATE_NAME.test(name)) {
    throw new Error(`${where}state name "${name}" must be lowercase letters, digits and hyphens`);
  }
}

/** The explicit file when given, else the first watson.json walking up from `start`. */
export function findConfig(start: string, explicit?: string): string | null {
  if (explicit) return path.resolve(explicit);
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, 'watson.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadCatalog(file: string): Catalog {
  const refuse = (why: string): never => { throw new Error(`${file}: ${why}`); };

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error: any) {
    if (error.code === 'ENOENT') refuse('file not found');
    refuse(`not valid JSON (${error.message})`);
  }

  if (raw.schema !== 1) refuse('schema must be 1');
  if (!Array.isArray(raw.builds) || raw.builds.length === 0) refuse('builds must list at least one build');
  const instances = raw.instances ?? 1;
  if (!Number.isInteger(instances) || instances < 1 || instances > 8) refuse('instances must be a whole number from 1 to 8');

  const base = path.dirname(file);
  const resolve = (relative: string) => path.resolve(base, relative);
  const seen = new Set<string>();
  const builds: Build[] = [];

  for (const entry of raw.builds) {
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0) refuse('every build needs a non-empty id');
    if (seen.has(id)) refuse(`build id ${id} appears twice`);
    seen.add(id);

    const launch = entry.launch ?? {};
    if (typeof launch.bios !== 'string' && typeof launch.elf !== 'string') refuse(`build ${id}: launch needs a bios or an elf`);

    const states: Record<string, string> = {};
    for (const [name, relative] of Object.entries(entry.states ?? {})) {
      try { checkStateName(name, `build ${id}: `); } catch (error: any) { refuse(error.message); }
      if (typeof relative !== 'string') refuse(`build ${id}: state ${name} must be a path`);
      states[name] = resolve(relative as string);
    }

    builds.push({
      id,
      bios: typeof launch.bios === 'string' ? resolve(launch.bios) : undefined,
      elf: typeof launch.elf === 'string' ? resolve(launch.elf) : undefined,
      states,
    });
  }
  return { file, builds, instances };
}

const looksLikePath = (value: string) => /[\\/]/.test(value) || /\.p2s$/i.test(value);

/** Turn what the agent asked for into the files Run.ps1 needs. */
export function resolveLaunch(catalog: Catalog | null, request: LaunchRequest): LaunchFiles {
  if (!request.build) {
    return { bios: request.bios, elf: request.elf, state: request.state };
  }
  if (!catalog) {
    throw new Error(`no watson.json was found, so build ${request.build} cannot be resolved; pass bios, elf and state as files`);
  }
  const build = catalog.builds.find((candidate) => candidate.id === request.build);
  if (!build) {
    throw new Error(`unknown build ${request.build}; known: ${catalog.builds.map((b) => b.id).join(', ')}`);
  }

  let state: string | undefined;
  if (request.state) {
    if (looksLikePath(request.state)) {
      state = request.state;
    } else {
      state = build.states[request.state];
      if (!state) {
        const known = Object.keys(build.states);
        throw new Error(`build ${build.id} has no state ${request.state}; known: ${known.length ? known.join(', ') : 'none'}`);
      }
    }
  }
  return { bios: request.bios ?? build.bios, elf: request.elf ?? build.elf, state };
}

/** Record a named state in the consumer's file, as a path relative to it. */
export function registerState(file: string, buildId: string, name: string, statePath: string): void {
  checkStateName(name, '');
  loadCatalog(file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = raw.builds.find((candidate: any) => candidate.id === buildId);
  if (!entry) {
    throw new Error(`unknown build ${buildId}; known: ${raw.builds.map((b: any) => b.id).join(', ')}`);
  }
  entry.states = entry.states ?? {};
  entry.states[name] = path.relative(path.dirname(file), statePath).split(path.sep).join('/');
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

/** One line per named state, saying when its file is not on disk. */
export function describeStates(catalog: Catalog): string[] {
  const lines: string[] = [];
  for (const build of catalog.builds) {
    const names = Object.keys(build.states);
    if (names.length === 0) {
      lines.push(`${build.id}  (no states)`);
      continue;
    }
    for (const name of names) {
      const file = build.states[name];
      lines.push(`${build.id}  ${name}  ${file}${fs.existsSync(file) ? '' : '  (file missing)'}`);
    }
  }
  return lines;
}
