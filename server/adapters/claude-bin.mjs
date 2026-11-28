// Where the claude CLI is and which version it is (server/backends.mjs reads both). Moved from claude-code.mjs.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { versionIn } from '../../shared/cli-version.mjs';
import { stopProbe } from '../remote/host/probe-stop.mjs';

/** The claude binary: POSTBOX_CLAUDE_BIN, then the native installer’s location, then the PATH. */
export function findClaude(env = process.env) {
  if (env.POSTBOX_CLAUDE_BIN) return env.POSTBOX_CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

/** The installed version, or null if the CLI can’t be run. */
export function claudeVersion(bin = findClaude()) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => stopProbe(p), 8000);
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? (versionIn(out) ?? 'unknown') : null);
    });
  });
}
