// #780: agentFile opens a file the agent names with O_NONBLOCK, so a FIFO named as one is refused at once instead of
// holding the read until something writes to it. Making the FIFO takes `mkfifo`, and a read that hangs can only be
// stopped from outside, so the read runs in a child of its own, killed after 5 seconds: the mutant without
// O_NONBLOCK fails this test rather than hanging the gate.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hasMkfifo = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v mkfifo'], { timeout: 5000 }).status === 0;

test('#780: a FIFO named as a file is refused at once, not waited on', { skip: !hasMkfifo && 'no mkfifo here' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pb-test-agent-fifo-'));
  try {
    assert.equal(spawnSync('mkfifo', ['-m', '600', join(folder, 'pipe.png')], { timeout: 5000 }).status, 0);
    const mod = new URL('../../server/agent-files.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(mod)}).then(({ agentFile }) =>
      agentFile({ agentFolders: async () => [${JSON.stringify(folder)}] }, 's', 'pipe.png', 1024, 'the image')
        .then(() => 'read', (e) => e.message).then((m) => { process.stdout.write(m); process.exit(0); }));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const ended = await new Promise((r) => child.on('exit', (code, signal) => r(signal ?? code)));
    clearTimeout(killer);
    assert.equal(ended, 0, 'the read returned at once instead of waiting on the FIFO');
    assert.equal(out, 'pipe.png isn’t a file (the image).');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
