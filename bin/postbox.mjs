#!/usr/bin/env node
// The postbox command (#157): starts Postbox on this computer, with the person’s data in ~/.postbox (#90). npm links it
// when Postbox is installed, `npm start` runs it in a clone, and `node server/index.mjs` hands its flags to it.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildInfo } from '../server/build-info.mjs';
import { dataFolder, lockData, moveData, postboxHome } from '../server/home.mjs';
import { checkPlatform } from '../server/redis-platform.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const HELP = `Usage: postbox [options]

Starts Postbox at http://127.0.0.1:<port>/. It listens on this computer only.

Options:
  --port <n>       The port to listen on (4173).
  --data <folder>  The data folder: conversations, attachments and agents’ workspaces.
                   Without it, Postbox uses $POSTBOX_HOME, else ~/.postbox.
  --fresh          Start from an empty store (keeps attachments and workspaces).
  --demo           Seed the demo’s agents and conversations, with scripted agents only.
  --move-data      Move a clone’s data/ folder to ~/.postbox, then exit.
  -v, --version    Print the version.
  -h, --help       Print this help.`;

/**
 * Reads the flags and runs: prints help or the version, moves a clone’s data when asked, or starts Postbox and stops
 * it on Ctrl-C.
 * @param {string[]} argv  the flags, without node and the script
 * @param {typeof import('../server/index.mjs').start} start  passed in: server/index.mjs runs this while it’s still loading
 * @param {{ platform: string, arch: string }} [host]  where it runs; tests pass another
 */
export async function main(argv, start, host = { platform: process.platform, arch: process.arch }) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        data: { type: 'string' },
        fresh: { type: 'boolean' },
        demo: { type: 'boolean' },
        'move-data': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(buildInfo({ root: ROOT }).version);
  if (values['move-data']) {
    try {
      const { from, to, leftover } = await moveData({ root: ROOT });
      console.log(
        `Moved ${from} to ${to}, and left a link in its place. Postbox uses ${to} from now on.\nAn agent that works in its own workspace folder, rather than a project’s, starts a new Claude Code session on its next turn, since its folder moved; its conversation in Postbox stays as it was.`,
      );
      if (leftover) console.log(`Couldn’t remove the original, now at ${leftover}. Remove it yourself once you’ve checked ${to}.`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }
  const port = values.port === undefined ? 4173 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port takes a port number from 1 to 65535, not “${values.port}”.`);
    process.exit(2);
  }
  // Postbox’s store is a Redis 8 build it has only for some platforms: refuse the others before anything is written
  // or downloaded (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”).
  const where = checkPlatform(host);
  if (!where.ok) {
    console.error(where.message);
    process.exit(1);
  }
  const { dataDir, from } = dataFolder({ data: values.data, root: ROOT });
  let release;
  try {
    release = lockData(dataDir);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  process.on('exit', release);
  const app = await start({ port, dataDir, fresh: values.fresh, demo: values.demo });
  if (from === 'clone')
    console.log(
      `This clone’s data/ folder has your conversations, so Postbox keeps using it. Postbox now keeps its data in ${postboxHome()}: to move it there, stop Postbox and run \`npm start -- --move-data\`.`,
    );
  const bye = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

// Run as the command. npm links it from its bin folder, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { start } = await import('../server/index.mjs');
  await main(process.argv.slice(2), start);
}
