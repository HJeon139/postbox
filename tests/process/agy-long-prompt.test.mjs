// #362 item 5, with a real spawn and a fake agy binary: a prompt the operating system takes reaches agy whole, and one
// it refuses with E2BIG tells the person so. Linux refuses one argument past 128 KiB and macOS about 1 MiB in all.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AntigravityCliAdapter } from '../../server/adapters/antigravity-cli.mjs';
import { AGY_TURN, tooLongMessage, turnContext } from '../agy-long-prompt-fixture.mjs';

/** An adapter on a fake agy that keeps its arguments and prints a recorded turn. */
function fakeAgy(t) {
  const root = mkdtempSync(join(tmpdir(), 'pb-test-agy-long-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'agy');
  const seen = join(root, 'args');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\nexec /bin/cat "${fileURLToPath(AGY_TURN)}"\n`);
  chmodSync(bin, 0o755);
  return { seen, adapter: new AntigravityCliAdapter({ bin, workRoot: join(root, 'work'), settingsFile: join(root, 'settings.json'), env: {} }) };
}

test('#362: a 120 KB prompt reaches a real agy process whole, under every limit', async (t) => {
  const { adapter, seen } = fakeAgy(t);
  const text = 'x'.repeat(120_000);
  await adapter.deliver({}, { kind: 'user', text }, turnContext());
  assert.ok(readFileSync(seen, 'utf8').includes(text));
});

test('#362: a 400 KB prompt reaches a real agy process whole where one argument can be that long', {
  skip: process.platform === 'linux' && 'Linux refuses one argument past 128 KiB',
}, async (t) => {
  const { adapter, seen } = fakeAgy(t);
  const text = 'x'.repeat(400_000);
  await adapter.deliver({}, { kind: 'user', text }, turnContext());
  assert.ok(readFileSync(seen, 'utf8').includes(text));
});

test('#362: a prompt past every operating system’s limit gets the real E2BIG’s message, and agy never starts', async (t) => {
  const { adapter, seen } = fakeAgy(t);
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'x'.repeat(3_000_000) }, turnContext()), { message: tooLongMessage(3000) });
  assert.equal(existsSync(seen), false);
});
