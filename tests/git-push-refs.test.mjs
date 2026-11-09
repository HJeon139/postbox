// #1032: SENT_REF (shared/git-push.mjs) read git push’s ref lines with `^\s*…\s*` under the m flag, and \s takes
// newlines, so every line start re-scanned the blank lines after it: 2,000 blank lines after a `To` line took about
// 3 s of synchronous time, and the text is whatever the command printed. A ref line is one line, so it’s now read
// with spaces and tabs only, in time linear in the output. The cases pin what it reads, before and after.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushesIn } from '../shared/git-push.mjs';

const TO = 'To https://example.com/r.git\n';

test('#1032 git push’s sent refs are read; rejected and up-to-date ones aren’t', () => {
  const out = `${TO} * [new branch]      feat/a -> feat/a\n   1a2b3c4..5d6e7f8  main -> main\n * [new tag]         v1.0 -> v1.0\n ! [rejected]        old -> old (fetch first)\n = [up to date]      same -> same\n`;
  assert.deepEqual(pushesIn(out), [{ remote: 'https://example.com/r.git', refs: ['feat/a → feat/a', 'main → main', 'v1.0 → v1.0'], branch: 'feat/a' }]);
  const forced = `${TO} + 1a2b3c4...5d6e7f8 main -> main (forced update)\n`;
  assert.deepEqual(pushesIn(forced)[0].refs, ['main → main']);
  const tabbed = `${TO}\t*\t[new branch]\tx -> x\n`;
  assert.deepEqual(pushesIn(tabbed)[0].refs, ['x → x'], 'tabs between fields, as git may print');
});

test('#1032 a ref line split over two lines isn’t read as one', () => {
  assert.deepEqual(pushesIn(`${TO} * [new branch]\n a -> a\n`)[0].refs, []);
});

test('#1032 blank lines after a To line are read in linear time', () => {
  // 4,000 first, the issue’s count, so the old cubic pattern fails fast; then 100,000, which a quadratic one can’t pass.
  for (const lines of [4_000, 100_000]) {
    for (const tail of ['', ' ! [rejected]        main -> main (fetch first)\n']) {
      const out = `${TO}${'\n'.repeat(lines)}${tail}`;
      const t0 = performance.now();
      pushesIn(out);
      const ms = performance.now() - t0;
      assert.ok(ms < 250, `${lines.toLocaleString('en-US')} blank lines took ${Math.round(ms)} ms`);
    }
  }
});

// #1032: a flag class that held a space let a long line of spaces split three ways before failing.
test('#1032 one line of 100,000 spaces after a To line is read in linear time', () => {
  const out = `${TO}${' '.repeat(100_000)}\n`;
  const t0 = performance.now();
  pushesIn(out);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `100,000 spaces took ${Math.round(ms)} ms`);
});
