// Where this copy of Postbox’s host code is, and the paths it works with (#120). Installed, the code is at
// ~/.postbox-remote/<version>/ with the repo’s layout, so its version is that folder’s name. Run from a checkout (the
// tests, a developer), the version is package.json’s. Every host program (the daemon, a runner, the shim) finds its
// files here, so they all agree on one layout (shared/remote-protocol.mjs, hostPaths).
//
// Tests give the daemon, runner and shim a HOME of their own, which homedir() reads, so they never touch the real
// ~/.postbox-remote.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths } from '../../../shared/remote-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The top of this copy of the code: ~/.postbox-remote/<version>/ installed, the repo in a checkout. */
const CODE = join(HERE, '..', '..', '..');

/** This copy’s programs, beside this file, whichever way it runs. */
export const PROGRAMS = Object.freeze({ host: join(HERE, 'host'), runner: join(HERE, 'runner.mjs'), shim: join(HERE, 'shim.mjs') });

/** The version this code is: its folder’s name when installed, else package.json’s. */
export function hostVersion() {
  const name = basename(CODE);
  if (/^\d+\.\d+\.\d+$/.test(name)) return name;
  return JSON.parse(readFileSync(join(CODE, 'package.json'), 'utf8')).version;
}

/** The host’s paths for this version. @param {{ home?: string }} [opts] */
export function paths({ home = homedir() } = {}) {
  return hostPaths(home, hostVersion());
}
