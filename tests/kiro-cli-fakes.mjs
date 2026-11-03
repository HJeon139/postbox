// The fake Kiro CLI and turn context the Kiro adapter’s tests share, moved out of tests/kiro-cli.test.mjs.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

// Streams recorded from real Kiro CLI turns (kiro-cli 2.33.1, engine v3, claude-opus-5.5), with local paths,
// steering file names and the slash command list removed.
export const fixture = (name) =>
  readFileSync(new URL(`fixtures/kiro-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

export function fakeCtx(over = {}) {
  const calls = { text: '', activity: [], status: [], reported: [], saved: {} };
  const abort = new AbortController();
  return {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'kiro', model: 'claude-opus-5-5', permissionMode: 'ask', usesHostSetup: false, tools: [], description: '', instructions: '' },
    project: null,
    handles: ['kiro', 'critic'],
    state: {},
    saveState: (p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (d) => {
      calls.text += d;
    },
    activity: (a) => calls.activity.push(a),
    status: (s) => calls.status.push(s),
    reported: (r) => calls.reported.push(r),
    ...over,
  };
}

/** A fake kiro-cli: it records its arguments and environment, and plays a recorded stream, once per spawn. */
export function fakeSpawn(streams, seen) {
  return (_bin, args, opts) => {
    const agent = args[args.indexOf('--agent') + 1];
    const home = opts.env.KIRO_HOME;
    seen.push({ args, cwd: opts.cwd, env: opts.env, agentFile: home && JSON.parse(readFileSync(join(home, 'agents', `${agent}.json`), 'utf8')) });
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    const { lines, code } = streams.shift();
    setImmediate(() => {
      for (const e of lines) child.stdout.write(`${JSON.stringify(e)}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
}
