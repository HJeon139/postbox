// A stand-in harness for the runner’s and the daemon’s integration tests (tests/integration/): it does each argument in
// order. `out:<text>` and `err:<text>` print a line to stdout or stderr, `env:<NAME>` prints NAME=<value>, `cwd`
// prints the working folder, `stdin` prints `got:<line>` for each stdin line until end of file, `sleep:<ms>` waits, and
// `exit:<code>` exits. SIGINT is left at Node’s default, so it ends the process by that signal, as it ends a Claude Code
// turn, unless `ignore-sigint` comes first. `tool-shell` starts a process in a session of its own (setsid), as Claude
// Code starts each Bash call, and prints `shell:<pid>`; it runs until it’s killed.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

for (const arg of process.argv.slice(2)) {
  const [op, ...rest] = arg.split(':');
  const value = rest.join(':');
  if (op === 'out') process.stdout.write(`${value}\n`);
  else if (op === 'err') process.stderr.write(`${value}\n`);
  else if (op === 'env') process.stdout.write(`${value}=${process.env[value] ?? ''}\n`);
  else if (op === 'cwd') process.stdout.write(`${process.cwd()}\n`);
  else if (op === 'stdin') for await (const line of createInterface({ input: process.stdin })) process.stdout.write(`got:${line}\n`);
  else if (op === 'sleep') await new Promise((r) => setTimeout(r, Number(value)));
  else if (op === 'exit') process.exit(Number(value));
  else if (op === 'ignore-sigint') process.on('SIGINT', () => {});
  else if (op === 'tool-shell') {
    const shell = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    shell.unref();
    process.stdout.write(`shell:${shell.pid}\n`);
  }
}
