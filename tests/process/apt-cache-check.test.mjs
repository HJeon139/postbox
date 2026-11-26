// #869: the Chromium action keeps a cached apt package only when the signed index vouches for it. apt itself installs
// a package it finds in its archive folder by size alone, so this step is what keeps a tampered cache entry out. The
// step’s own script runs here, with apt-get, apt-cache and sudo replaced by stubs: apt-cache answers as `apt-cache show
// <name>=<version>` does, one stanza per architecture, each with a `SHA256:` line (apt-cache(8)).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../temp-dirs.mjs';

const ACTION = new URL('../../.github/actions/playwright-chromium/action.yml', import.meta.url);
const STEP = 'Keep only the cached packages the signed index vouches for';

/** The `run: |` block of the step with this name, unindented. @param {string} name */
function stepScript(name) {
  const lines = readFileSync(ACTION, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the action has the step “${name}”`);
  const next = lines.findIndex((l, i) => i > at && /^\s*- (name|uses):/.test(l));
  const run = lines.findIndex((l, i) => i > at && /^\s*run: \|$/.test(l));
  assert.ok(run > at && (next < 0 || run < next), `“${name}” has a run: | block of its own`);
  const indent = lines[run].search(/\S/);
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(pad)).join('\n');
}

const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');

/** Runs the step on a folder of packages, with the index the stubs give. @param {Record<string, string>} debs @param {Record<string, string[]>} index */
function check(debs, index) {
  const root = tempDir('pb-apt-check-');
  const archives = join(root, 'archives');
  const bin = join(root, 'bin');
  mkdirSync(archives);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(debs)) {
    mkdirSync(dirname(join(archives, name)), { recursive: true });
    writeFileSync(join(archives, name), body);
  }
  const show = Object.entries(index)
    // After the stanzas, a long description, as a large record has: written past the pipe’s buffer, it outlives a
    // reader that stops at the first match.
    .map(
      ([q, sums]) =>
        `  ${JSON.stringify(q)}) printf '%s\\n' ${sums.map((s) => `'Package: x' 'SHA256: ${s}' ''`).join(' ')}; sleep 0.2; head -c 200000 /dev/zero | tr '\\0' ' ' ;;`,
    )
    .join('\n');
  const stubs = {
    sudo: '#!/bin/bash\nexec "$@"\n',
    'apt-get': '#!/bin/bash\ntouch "$ARCHIVES/../apt-get-ran"\n',
    'apt-cache': `#!/bin/bash\n[ "$1" = show ] || exit 100\ncase "$2" in\n${show}\n  *) echo "E: No packages found" >&2; exit 100 ;;\nesac\n`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  // As the runner runs a composite action’s bash step: errexit and pipefail on.
  execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', stepScript(STEP)], {
    env: { ...process.env, ARCHIVES: archives, PATH: `${bin}:${process.env.PATH}` },
    timeout: 30_000,
  });
  return (/** @type {string} */ name) => existsSync(join(archives, name));
}

test('#869 a cached package whose SHA-256 the index gives is kept, by its name and version, epoch and all', () => {
  const kept = check(
    { 'libfoo_1.2-3ubuntu1_amd64.deb': 'foo', 'fonts-bar_1%3a2.0-1_all.deb': 'bar' },
    { 'libfoo=1.2-3ubuntu1': [sha('other arch'), sha('foo')], 'fonts-bar=1:2.0-1': [sha('bar')] },
  );
  assert.ok(kept('libfoo_1.2-3ubuntu1_amd64.deb'));
  assert.ok(kept('fonts-bar_1%3a2.0-1_all.deb'));
});

test('#869 one that differs from the index, or that the index doesn’t list, is deleted and fetched again', () => {
  const kept = check({ 'libfoo_1.2-3ubuntu1_amd64.deb': 'fob', 'libgone_9_amd64.deb': 'gone' }, { 'libfoo=1.2-3ubuntu1': [sha('foo')] });
  assert.ok(!kept('libfoo_1.2-3ubuntu1_amd64.deb'), 'a package the index doesn’t vouch for is deleted');
  assert.ok(!kept('libgone_9_amd64.deb'), 'a version the index no longer lists is deleted');
});

test('#869 a package the index vouches for is kept when apt-cache goes on writing after the match', () => {
  // Under pipefail, a grep -q that stops reading early leaves apt-cache to die of SIGPIPE, which would read as no match.
  const kept = check({ 'libbig_1_amd64.deb': 'big' }, { 'libbig=1': [sha('big')] });
  assert.ok(kept('libbig_1_amd64.deb'));
});

test('#869 a cache entry sha256sum can’t read is deleted and fetched again, not a failed job', () => {
  const kept = check({ 'libdir_1_amd64.deb/inner': 'x' }, {});
  assert.ok(!kept('libdir_1_amd64.deb'));
});

test('#869 an empty cache runs nothing, not even apt-get update', () => {
  assert.equal(check({}, {})(join('..', 'apt-get-ran')), false);
  assert.equal(check({ 'libfoo_1_amd64.deb': 'foo' }, { 'libfoo=1': [sha('foo')] })(join('..', 'apt-get-ran')), true);
});
