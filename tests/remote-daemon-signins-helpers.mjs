// The fake spawn and recorded runs for tests/remote-daemon-signins.test.mjs (server/remote/host/daemon-signins.mjs,
// #1608): children that answer as the CLIs did in tests/fixtures/remote/signin/.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { PROGRAMS_FOUND } from './remote-daemon-setup.mjs';

/** @param {string} name */
export const recorded = (name) => JSON.parse(readFileSync(new URL(`./fixtures/remote/signin/${name}.json`, import.meta.url), 'utf8'));
const FIXTURE = { claude: 'claude', codex: 'codex', 'kiro-cli': 'kiro' };

/** Programs found with each harness there. */
export const ALL_FOUND = async () => {
  const p = structuredClone(PROGRAMS_FOUND);
  p.harnesses = p.harnesses.map((h) => (h.name === 'kiro-cli' ? { ...h, path: '/home/user/.local/bin/kiro-cli', version: '3.6.2' } : h));
  return p;
};

/**
 * A spawn whose children are held until the test answers them: answer(i, how) plays recorded run `how` (such as
 * signed-in) for the call’s program, as the CLI printed it and exited.
 */
export function statusSpawn() {
  const calls = [];
  const spawn = (program, args, options) => {
    const child = Object.assign(new EventEmitter(), { kills: [], kill: (sig) => child.kills.push(sig) && true });
    if (options.stdio[1] === 'pipe') child.stdout = new PassThrough();
    calls.push({ program, args, options, child });
    return child;
  };
  /** Resolves once the child has closed. @param {any} call @param {string} how */
  const play = async (call, how) => {
    const run = recorded(`${FIXTURE[call.program.split('/').at(-1)]}-${how}`);
    call.child.stdout?.end(run.stdout);
    // As a child does: its close comes once its output has been read.
    await new Promise((resolve) => setImmediate(resolve));
    call.child.emit('close', run.exit, null);
  };
  return { spawn, calls, play };
}

/** Everything the connection carried, as text. @param {any} c */
export function carried(c) {
  let text = '';
  c.output.on('data', (b) => {
    text += String(b);
  });
  return () => text;
}
