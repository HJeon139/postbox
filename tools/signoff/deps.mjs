// What tools/signoff.mjs does to the world, in one object, so its tests drive every path with fakes (#845): the
// commands it runs, its reads from GitHub, the clock and timers, the machine’s load and free inodes, and files.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from '../heavy-lock.mjs';
import { ghJson } from '../signoff-checks.mjs';
import { SIGNALS } from './stop.mjs';

/**
 * @typedef {{ code: number, out: string }} RunResult
 * @typedef {{ cwd?: string, env?: Record<string, string>, stream?: boolean, stop?: import('./stop.mjs').Stop,
 *   started?: (kill: (signal: string) => void) => void }} RunOptions
 * @typedef {{
 *   run: (argv: string[], o?: RunOptions) => Promise<RunResult>,
 *   gh: (args: string[]) => any,
 *   now: () => number,
 *   every: (ms: number, fn: () => void) => () => void,
 *   loadavg: () => number[],
 *   cores: () => number,
 *   statfs: (path: string) => { ffree: number },
 *   readFile: (path: string) => string,
 *   writeFile: (path: string, text: string) => void,
 *   list: (dir: string) => string[],
 *   exists: (path: string) => boolean,
 *   mkdtemp: (prefix: string) => string,
 *   rm: (path: string) => void,
 *   link: (target: string, path: string) => void,
 *   tmpdir: () => string,
 *   home: string,
 *   execPath: string,
 *   nodeVersion: string,
 *   acquire: (o: { label: string, dir?: string, log: (m: string) => void }) => Promise<() => void>,
 *   log: (line: string) => void,
 *   onSignal: (fn: (signal: string) => void) => () => void,
 *   exit: (code: number) => void,
 * }} Deps
 */

/**
 * Runs argv, never through a shell. With stream, its output goes straight to this terminal and out is empty; else
 * out is its stdout and stderr together. A command that can’t start exits 127, as a shell reports it. o.started gets
 * the function that sends the running child a signal.
 * @param {string[]} argv @param {RunOptions} [o]
 * @returns {Promise<RunResult>}
 */
function run(argv, o = {}) {
  return new Promise((ok) => {
    const stdio = o.stream ? 'inherit' : ['ignore', 'pipe', 'pipe'];
    const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: /** @type {any} */ (stdio) });
    o.started?.((signal) => child.kill(/** @type {NodeJS.Signals} */ (signal)));
    let out = '';
    child.stdout?.on('data', (b) => (out += b));
    child.stderr?.on('data', (b) => (out += b));
    child.on('error', (e) => ok({ code: 127, out: `${out}${e.message}` }));
    child.on('close', (code, signal) => ok({ code: code ?? (signal ? 1 : 0), out }));
  });
}

/** @returns {Deps} */
export function defaultDeps() {
  return {
    run,
    gh: ghJson,
    now: Date.now,
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    loadavg,
    cores: () => cpus().length,
    statfs: (path) => fs.statfsSync(path),
    readFile: (path) => fs.readFileSync(path, 'utf8'),
    writeFile: (path, text) => {
      fs.mkdirSync(join(path, '..'), { recursive: true });
      fs.writeFileSync(path, text);
    },
    list: (dir) => fs.readdirSync(dir),
    exists: (path) => fs.existsSync(path),
    mkdtemp: (prefix) => fs.mkdtempSync(prefix),
    rm: (path) => fs.rmSync(path, { recursive: true, force: true }),
    link: (target, path) => fs.symlinkSync(target, path),
    tmpdir,
    home: homedir(),
    execPath: process.execPath,
    nodeVersion: process.version,
    acquire,
    log: (line) => process.stdout.write(`${line}\n`),
    onSignal: (fn) => {
      for (const s of SIGNALS) process.on(s, fn);
      return () => {
        for (const s of SIGNALS) process.off(s, fn);
      };
    },
    exit: (code) => process.exit(code),
  };
}
