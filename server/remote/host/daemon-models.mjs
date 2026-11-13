// Postbox’s `models` (shared/remote-protocol.mjs, #1304): which models the host’s own CLI for a harness offers,
// answered `listed`. The laptop’s Model field asks it for an agent that runs here, so it suggests what this host’s
// sign-in and version run, not what the laptop’s do.

import { turnEnv } from './daemon-login.mjs';
import { send } from './daemon-reply.mjs';
import { claudeModels, codexModels, kiroModels } from './harness-models.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/** Each harness’s lister, by the adapter’s name (HARNESSES). */
const LISTERS = { 'claude-code': claudeModels, 'kiro-cli': kiroModels, codex: codexModels };

/**
 * `models`: runs the lister for the harness’s program, the one the welcome reported, and answers `listed`. It runs
 * as an argument list with no shell, in the home folder, with the login shell’s PATH as a turn has it, and the
 * process is ended with the daemon (d.checking). It isn’t awaited, so other messages go on while it runs. A harness
 * that wasn’t found, or a listing that fails, is answered with no models: the laptop then suggests the last it kept.
 * @param {Daemon} d @param {Conn} c @param {{ harness: keyof typeof LISTERS }} m
 */
export function models(d, c, m) {
  const path = d.programs?.harnesses.find((h) => h.name === m.harness)?.path;
  if (!path) return void send(c, 'listed', { harness: m.harness, models: [] });
  /** @type {any} */
  const spawnImpl = (program, args, options) => {
    const child = d.spawn(program, args, { ...options, cwd: d.home, env: { ...d.env, ...turnEnv(d, {}) }, shell: false });
    d.checking.add(child);
    child.on('close', () => d.checking.delete(child));
    return child;
  };
  void LISTERS[m.harness](path, { spawnImpl }).then((listed) => send(c, 'listed', { harness: m.harness, models: listed }));
}
