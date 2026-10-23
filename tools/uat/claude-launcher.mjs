#!/usr/bin/env node
// A launcher in front of Claude Code, like the toolbox shim #126 was found under: it starts the real CLI as its own
// child and doesn’t pass SIGINT on. Stopping only this process leaves the CLI running, as it did in #126; stopping its
// process group, as the fix does, reaches the CLI too. On a machine where `claude` is the CLI itself, a P0 run needs
// this to put Stop in #126’s conditions:
//
//   POSTBOX_CLAUDE_BIN=tools/uat/claude-launcher.mjs node tools/uat-run.mjs --scenario p0
//
// It runs POSTBOX_UAT_REAL_CLAUDE, or `claude` on the PATH, with the same arguments, input and output.

import { spawn } from 'node:child_process';

const child = spawn(process.env.POSTBOX_UAT_REAL_CLAUDE || 'claude', process.argv.slice(2), { stdio: 'inherit' });
// SIGINT to this process alone does nothing, as with the shim; a signal to the group reaches the child directly.
process.on('SIGINT', () => {});
child.on('error', (e) => {
  console.error(`The launcher couldn’t start Claude Code: ${e.message}`);
  process.exit(127);
});
child.on('exit', (code) => process.exit(code ?? 1));
