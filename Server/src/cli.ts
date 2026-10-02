#!/usr/bin/env node
/**
 * Watson's offline tools, without the MCP server.
 *
 *   watson-gsdump parse <file.gs> [--out <file.jsonl>]
 *
 * Exit codes: 0 FOUND or EMPTY, 2 NOT VERIFIED (the dump could not be read whole), 1 failed.
 */
import { parseGsDump, formatSummary } from './gs/parse.js';
import { walkGsDump } from './gsdump.js';

function main(argv: string[]): number {
  const [command, file] = argv;
  if (command !== 'parse' || !file) {
    console.error('usage: watson-gsdump parse <file.gs> [--out <file.jsonl>]');
    return 1;
  }
  const flag = argv.indexOf('--out');
  const out = flag >= 0 && argv[flag + 1] ? argv[flag + 1] : file.replace(/\.gs$/i, '') + '.jsonl';

  const walk = walkGsDump(file);
  if (!walk.complete) {
    console.log(`dump: ${file}\nbuild: unknown\nverdict: NOT VERIFIED ${walk.reason}  coverage ${walk.packets}/?`);
    return 2;
  }
  try {
    const summary = parseGsDump(file, out);
    console.log(formatSummary(summary, file, out));
    return 0;
  } catch (error: any) {
    console.error(`failed: ${error.message}`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
