// A gh that hangs fails the sign-off instead of hanging it (#845): ghJson’s execFileSync blocks the event loop, so
// nothing else could print or stop while gh waits, and a sign-off that printed nothing for 15 minutes had its turn
// stopped. The stub gh on PATH sleeps far past the short timeout the test gives.

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { defaultDeps } from '../../tools/signoff/deps.mjs';
import { EXIT, signoff } from '../../tools/signoff.mjs';
import { EXIT as CHECKS_EXIT, GH_TIMEOUT_MS, ghJson, signoffChecks } from '../../tools/signoff-checks.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** Puts a gh on PATH that sleeps for 20 s and prints nothing, for the rest of this file’s process. */
function hungGh() {
  const bin = tempDir('pb-signoff-gh-');
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexec sleep 20\n');
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

/** ghJson with a timeout short enough for a test. @param {string[]} args */
const quickGh = (args) => ghJson(args, { timeout: 300 });

test('a gh call times out after two minutes unless told otherwise', () => {
  assert.equal(GH_TIMEOUT_MS, 120_000);
});

test('a hung gh fails A2 with its error code, naming the timeout, instead of waiting on it', { timeout: 15_000 }, () => {
  hungGh();
  const lines = [];
  const start = Date.now();
  const code = signoffChecks(845, { gh: quickGh, log: (l) => lines.push(l) });
  assert.ok(Date.now() - start < 5_000, `returned after ${Date.now() - start} ms`);
  assert.equal(code, CHECKS_EXIT.error);
  assert.match(lines.join('\n'), /gh failed: gh repo view --json nameWithOwner didn’t answer in 0\.3 s -> ERROR/);
});

test('a hung gh fails step 1 of the sign-off, and step 4 with A2’s error, instead of waiting on it', { timeout: 15_000 }, async () => {
  hungGh();
  const lines = [];
  const start = Date.now();
  const code = await signoff(['845'], { ...defaultDeps(), gh: quickGh, log: (l) => lines.push(l) });
  assert.ok(Date.now() - start < 10_000, `returned after ${Date.now() - start} ms`);
  assert.equal(code, EXIT.head, lines.join('\n'));
  assert.match(lines.find((l) => l.startsWith('✖ 1.')) ?? '', /gh pr view 845 .* didn’t answer in 0\.3 s/);
  assert.match(lines.find((l) => l.startsWith('✖ 4.')) ?? '', /error, as the line above says/);
});
