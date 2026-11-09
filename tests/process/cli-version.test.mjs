// A local CLI’s version is read from anywhere in what `--version` prints, as a host’s daemon reads it
// (server/remote/host/programs.mjs). Builds that print `0.167.0.945 (stable)` left Codex unavailable here, since its
// probe read only a version at the very end, and Claude Code’s `claude 2.1.319.1689 (…)` read as “claude”.

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeVersion } from '../../server/adapters/claude-code.mjs';
import { codexVersion } from '../../server/adapters/codex-models.mjs';
import { kiroVersion } from '../../server/adapters/kiro-cli-models.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** A fake CLI that prints `out` for `--version` and exits with `code`. */
function fakeCli(out, code = 0) {
  const bin = join(tempDir('pb-cli-version-'), 'cli');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${out}'\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test('a Codex build that prints its channel after the version is found, with its version', async () => {
  assert.equal(await codexVersion(fakeCli('0.167.0.945 (stable)')), '0.167.0');
  assert.equal(await codexVersion(fakeCli('codex-cli 0.167.0')), '0.167.0');
});

test('a Codex that runs but prints no version is still found', async () => {
  assert.equal(await codexVersion(fakeCli('')), 'unknown');
});

test('a Codex whose --version fails, or that isn’t there, isn’t found', async () => {
  assert.equal(await codexVersion(fakeCli('0.167.0', 1)), null);
  assert.equal(await codexVersion('/nonexistent/codex'), null);
});

test('Claude Code’s version is its version, whichever word comes first', async () => {
  assert.equal(await claudeVersion(fakeCli('claude 2.1.319.1689 (ASBX Claude Code, channel stable)')), '2.1.319');
  assert.equal(await claudeVersion(fakeCli('2.1.300 (Claude Code)')), '2.1.300');
});

test('Kiro CLI’s version is read the same way', async () => {
  assert.equal(await kiroVersion(fakeCli('kiro-cli 3.1.0')), '3.1.0');
  assert.equal(await kiroVersion(fakeCli('kiro-cli 1.2.3-beta.1 (stable)')), '1.2.3-beta.1');
});
