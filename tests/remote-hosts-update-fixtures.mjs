// What the automatic install’s tests share (tests/remote-hosts-update*.test.mjs, #464-b2a): the host manager over a
// temp data folder, with a fake ssh whose attach exits as a host without this version does (the recorded 127), whose
// install and token runs answer as the host would, and the laptop’s record of automatic installs
// (<data>/remote-installs/<host id>, server/remote/hosts-update.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCommand, tokenCommand } from '../server/remote/install.mjs';
import { FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { setup, VERSION } from './remote-hosts-fixtures.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/ssh/failures.json', import.meta.url), 'utf8')).failures;
const stderrOf = (/** @type {string} */ name) => FIXTURES.find((f) => f.name === name).stderr;
/** The recorded stderr of a login shell that found no launcher for this version (exit 127). */
export const NOT_INSTALLED = stderrOf('not-installed');
/** The recorded stderr of a launcher that’s there but couldn’t run (exit 126). */
export const COULD_NOT_START = stderrOf('launcher-could-not-start');
/** What the install script says before it exits 75 (install-script.mjs, busy()). */
export const BUSY = `postbox install: Postbox ${VERSION} is running on this host with different code; stop its turns, then install again\n`;
/** What the install script says before it exits 66 (tests/remote-install-run.test.mjs). */
export const MISMATCH = 'shared/limits.mjs: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match\npostbox install: checksums did not match\n';

/** The host’s record file. @param {string} dataDir @param {string} [id] */
export const recordFile = (dataDir, id = 'h1') => join(dataDir, 'remote-installs', id);

/** The record as JSON, or null with none. @param {string} dataDir @param {string} [id] */
export function readRecord(dataDir, id = 'h1') {
  const file = recordFile(dataDir, id);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Writes a record as a person’s earlier Postbox would have: an object as JSON, or a string as it is. */
export function writeRecord(/** @type {string} */ dataDir, /** @type {any} */ rec, id = 'h1') {
  mkdirSync(join(dataDir, 'remote-installs'), { recursive: true, mode: 0o700 });
  writeFileSync(recordFile(dataDir, id), typeof rec === 'string' ? rec : JSON.stringify(rec), { mode: 0o600 });
}

/** An install that answers as a host where it worked. @param {any} child */
export const installs = (child) => {
  child.stdout.write(`installed ${VERSION}\n`);
  child.exit(0);
};
/** An install that never answers, until the test calls child.answer(). @param {any} child */
export const hangs = (child) => {
  child.answer = () => installs(child);
};
/** An install that fails with an exit status and stderr. @param {number} code @param {string} stderr */
export const fails = (code, stderr) => (/** @type {any} */ child) => child.fail(code, stderr);

/**
 * The manager (remote-hosts-fixtures.mjs’s setup: h1 has a token here, h2 hasn’t), over a fake ssh that sorts each
 * run by its remote command. An attach exits 127 (attach: '127'), 126 ('126'), or reaches the fake daemon
 * ('daemon'); the install runs `install`; a test changes either on the rig. The token run prints the token. runs: the
 * install runs, each with the record as it was on disk when it was spawned (recordAtSpawn). dials: the attaches.
 * @param {{ attach?: '127' | '126' | 'daemon', install?: (child: any) => void, token?: string | null }} [o]
 */
export function rig({ attach = '127', install = installs, token = FAKE_TOKEN } = {}) {
  /** @type {any} */
  let t = null;
  const plain = fakeSsh({ script: (child) => child.plan(child) });
  /** @type {any[]} */
  const runs = [];
  /** @type {string[][]} */
  const dials = [];
  /** @type {import('../server/remote/ssh.mjs').SpawnLike} */
  const spawn = (program, args, options) => {
    const last = args.at(-1);
    if (t.attach === 'daemon' && last !== installCommand(VERSION) && last !== tokenCommand(VERSION)) {
      dials.push(args);
      return t.ssh.spawn(program, args, options);
    }
    const child = /** @type {any} */ (plain.spawn(program, args, options));
    if (last === installCommand(VERSION)) {
      try {
        child.recordAtSpawn = readRecord(t.dataDir);
      } catch {
        child.recordAtSpawn = 'unreadable';
      }
      child.plan = t.install;
      runs.push(child);
    } else if (last === tokenCommand(VERSION)) {
      child.plan = (/** @type {any} */ c) => {
        c.stdout.write(`${FAKE_TOKEN}\n`);
        c.exit(0);
      };
    } else {
      dials.push(args);
      child.plan = (/** @type {any} */ c) => (t.attach === '126' ? c.fail(126, COULD_NOT_START) : c.fail(127, NOT_INSTALLED));
    }
    return child;
  };
  t = Object.assign(setup({ spawn, token }), { attach, install, runs, dials });
  return t;
}
