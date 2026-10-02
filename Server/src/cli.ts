#!/usr/bin/env node
/**
 * Watson's offline tools, without the MCP server.
 *
 *   watson-gsdump parse <file.gs> [--out <file.jsonl>] [--writes]
 *
 * Exit codes: 0 FOUND or EMPTY, 2 NOT VERIFIED (the dump could not be read whole), 1 failed.
 */
import { parseGsDump, formatSummary } from './gs/parse.js';
import { walkGsDump } from './gsdump.js';

const USAGE = 'usage: watson-gsdump parse <file.gs> [--out <file.jsonl>] [--writes]';

function main(argv: string[]): number {
  const [command, file] = argv;
  if (command !== 'parse' || !file || file.startsWith('--')) {
    console.error(USAGE);
    return 1;
  }
  let out = file.replace(/\.gs$/i, '') + '.jsonl';
  const flag = argv.indexOf('--out');
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (!value || value.startsWith('--')) {
      console.error(`--out needs a file\n${USAGE}`);
      return 1;
    }
    out = value;
  }

  const walk = walkGsDump(file);
  if (!walk.complete) {
    console.log(`dump: ${file}\nbuild: unknown\nverdict: NOT VERIFIED ${walk.reason}  coverage ${walk.packets}/?`);
    return 2;
  }
  try {
    const summary = parseGsDump(file, out, { writes: argv.includes('--writes') });
    console.log(formatSummary(summary, file, out));
    return 0;
  } catch (error: any) {
    console.error(`failed: ${error.message}`);
    console.log(`dump: ${file}\nbuild: unknown\nverdict: PARTIAL ${error.message}  coverage ?/${walk.packets}`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
