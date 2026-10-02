#!/usr/bin/env node
/**
 * Watson's offline tools, without the MCP server.
 *
 *   watson-gsdump parse <file.gs> [--out <file.jsonl>] [--trace <file.trace.jsonl>] [--writes]
 *
 * Exit codes: 0 FOUND or EMPTY, 2 NOT VERIFIED (the dump could not be read whole), 1 failed.
 */
import { parseGsDump, formatSummary, TraceRefused } from './gs/parse.js';
import { walkGsDump } from './gsdump.js';

const USAGE = 'usage: watson-gsdump parse <file.gs> [--out <file.jsonl>] [--trace <file.trace.jsonl>] [--writes]';

function main(argv: string[]): number {
  const [command, file] = argv;
  if (command !== 'parse' || !file || file.startsWith('--')) {
    console.error(USAGE);
    return 1;
  }
  const valueOf = (flag: string): string | null | undefined => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const value = argv[at + 1];
    return !value || value.startsWith('--') ? null : value;
  };
  const given = { out: valueOf('--out'), trace: valueOf('--trace') };
  for (const [name, value] of Object.entries(given)) {
    if (value === null) {
      console.error(`--${name} needs a file\n${USAGE}`);
      return 1;
    }
  }
  const out = given.out ?? file.replace(/\.gs$/i, '') + '.jsonl';
  const trace = given.trace ?? undefined;

  const walk = walkGsDump(file);
  if (!walk.complete) {
    console.log(`dump: ${file}\nbuild: unknown\nverdict: NOT VERIFIED ${walk.reason}  coverage ${walk.packets}/?`);
    return 2;
  }
  try {
    const summary = parseGsDump(file, out, { writes: argv.includes('--writes'), trace });
    console.log(formatSummary(summary, file, out));
    return 0;
  } catch (error: any) {
    if (error instanceof TraceRefused) {
      console.log(`dump: ${file}\nbuild: unknown\nverdict: NOT VERIFIED ${error.message}  coverage 0/${walk.packets}`);
      return 2;
    }
    console.error(`failed: ${error.message}`);
    console.log(`dump: ${file}\nbuild: unknown\nverdict: PARTIAL ${error.message}  coverage ?/${walk.packets}`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
