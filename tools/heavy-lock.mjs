// At most a few heavy suites at once on this machine: Playwright, the integration and the process tests. Several
// agents run the gate from worktrees of their own on one computer, and with every suite at once the load average
// reached 90 to 150 on 18 cores, enough to fail tests that touch nothing a change did. Each run takes one of
// POSTBOX_HEAVY_SLOTS slots (2 unless it says otherwise) and waits for one to come free, rather than adding to the load.
//
//   node tools/heavy-lock.mjs <label> -- <command> [args…]   runs the command holding a slot, and exits with its code
//
// A slot is a file in the temp folder naming the pid that holds it; one whose pid has exited is free, so a run that’s
// killed holds nothing. Playwright takes its slot in tests/browser/heavy-slot.mjs. POSTBOX_HEAVY_HELD tells a run
// started inside one that holds a slot not to wait for a second.

import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SLOT_DIR = join(tmpdir(), 'postbox-heavy');

/** Whether a process runs: signal 0 checks without sending anything. @param {number} pid */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/** A slot’s holder, or null where it’s free: no file, one damaged, or one whose pid has exited. */
function holder(/** @type {string} */ path, /** @type {(pid: number) => boolean} */ alive) {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(h?.pid) && alive(h.pid) ? h : null;
  } catch {
    return null;
  }
}

/**
 * Takes a slot, waiting `every` ms at a time until one is free, and returns the function that lets it go. The slot’s
 * file is written whole beside it, then linked into place, which fails if another run got there first.
 * @param {{ label: string, dir?: string, slots?: number, pid?: number, alive?: (pid: number) => boolean,
 *   log?: (m: string) => void, sleep?: () => Promise<void>, every?: number }} o
 * @returns {Promise<() => void>}
 */
export async function acquire({
  label,
  dir = SLOT_DIR,
  slots = Number(process.env.POSTBOX_HEAVY_SLOTS) || 2,
  pid = process.pid,
  alive = isAlive,
  log = (m) => process.stderr.write(`${m}\n`),
  every = 1000,
  sleep = () => new Promise((ok) => setTimeout(ok, every)),
}) {
  mkdirSync(dir, { recursive: true });
  const mine = join(dir, `.${pid}.json`);
  writeFileSync(mine, JSON.stringify({ pid, label, since: new Date().toISOString() }));
  let said = false;
  try {
    for (;;) {
      /** @type {{ pid: number, label: string }[]} */
      const held = [];
      for (let i = 0; i < slots; i++) {
        const path = join(dir, `slot-${i}.json`);
        const h = holder(path, alive);
        if (h) {
          held.push(h);
          continue;
        }
        // Two runs that both find a slot’s holder gone can both take it, one removing the other’s: then three suites
        // run for a while, not two, which is the cost of a lock with no daemon.
        try {
          unlinkSync(path);
        } catch {}
        try {
          linkSync(mine, path);
        } catch {
          continue; // another run took it between the look and the link
        }
        return () => {
          if (holder(path, () => true)?.pid === pid) unlinkSync(path);
        };
      }
      if (!said) log(`Waiting for a heavy-suite slot (${held.length} of ${slots} in use: ${held.map((h) => `pid ${h.pid}, ${h.label}`).join('; ')}).`);
      said = true;
      await sleep();
    }
  } finally {
    unlinkSync(mine);
  }
}

/** Runs argv holding a slot, passing on the signals that would end it, and exits with its code. */
async function main(/** @type {string[]} */ args) {
  const at = args.indexOf('--');
  const [label, argv] = [args[0], args.slice(at + 1)];
  if (at !== 1 || !argv.length) {
    process.stderr.write('Usage: node tools/heavy-lock.mjs <label> -- <command> [args…]\n');
    process.exit(2);
  }
  const release = process.env.POSTBOX_HEAVY_HELD ? () => {} : await acquire({ label });
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env, POSTBOX_HEAVY_HELD: '1' } });
  for (const s of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(s, () => child.kill(s));
  child.on('exit', (code, signal) => {
    release();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
