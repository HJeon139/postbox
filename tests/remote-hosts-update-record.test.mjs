// The record of automatic installs (server/remote/hosts-update.mjs, #464-b2a; design note 464b, §3.3 and revision 4’s
// strict read): `<data>/remote-installs/<host id>`, `{ keepUpdated, installs: [{ version, at, outcome }] }`, newest
// first, read fail-closed, written before the install starts, and “tried” per version since the last other version.

import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { readRecord, recordFile, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);
const ok = (/** @type {any} */ over = {}) => ({ keepUpdated: true, installs: [], ...over });
const entry = (/** @type {string} */ version, /** @type {string} */ outcome, at = 1) => ({ version, at, outcome });

test('#464-b2a: a valid record with the consent on, written by hand, installs (the strict read’s control)', async () => {
  const t = rig();
  try {
    writeRecord(t.dataDir, ok());
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'installed', 'installed');
    assert.equal(t.runs.length, 1);
  } finally {
    t.done();
  }
});

/** Each record the strict read refuses: consent off and this version tried, so nothing installs. */
const REFUSED = {
  'a symbolic link to a valid record': (/** @type {string} */ dataDir) => {
    writeRecord(dataDir, ok(), 'elsewhere');
    symlinkSync(recordFile(dataDir, 'elsewhere'), recordFile(dataDir));
  },
  'a directory': (/** @type {string} */ dataDir) => mkdirSync(recordFile(dataDir), { recursive: true }),
  'bad JSON': (/** @type {string} */ dataDir) => writeRecord(dataDir, '{"keepUpdated": true, "installs": ['),
  'an extra key': (/** @type {string} */ dataDir) => writeRecord(dataDir, ok({ token: 'x' })),
  '17 installs': (/** @type {string} */ dataDir) =>
    writeRecord(dataDir, ok({ installs: Array.from({ length: 17 }, (_, i) => entry(`0.${i + 1}.0`, 'installed', 100 - i)) })),
  'an unknown outcome': (/** @type {string} */ dataDir) => writeRecord(dataDir, ok({ installs: [entry('0.9.0', 'maybe')] })),
  'a bad version': (/** @type {string} */ dataDir) => writeRecord(dataDir, ok({ installs: [entry('../0.9.0', 'installed')] })),
  'a version that isn’t one': (/** @type {string} */ dataDir) => writeRecord(dataDir, ok({ installs: [entry('not a version', 'installed')] })),
  'a time that isn’t a number': (/** @type {string} */ dataDir) =>
    writeRecord(dataDir, ok({ installs: [entry('0.9.0', 'installed', /** @type {any} */ ('1'))] })),
  'keepUpdated “false”': (/** @type {string} */ dataDir) => writeRecord(dataDir, ok({ keepUpdated: 'false' })),
  'keepUpdated 1': (/** @type {string} */ dataDir) => writeRecord(dataDir, ok({ keepUpdated: 1 })),
  'a valid record padded past 8 KB': (/** @type {string} */ dataDir) => writeRecord(dataDir, `${JSON.stringify(ok())}${' '.repeat(9000)}`),
};

for (const [what, make] of Object.entries(REFUSED)) {
  test(`#464-b2a: a record that’s ${what} is no consent: no install, and the status says it couldn’t be read`, async () => {
    const t = rig();
    try {
      make(t.dataDir);
      await t.mgr.connect('h1').catch(() => {});
      await settle();
      assert.equal(t.runs.length, 0);
      const st = t.mgr.status('h1');
      assert.equal(st.keepUpdated, false);
      assert.equal(typeof st.update?.error, 'string');
    } finally {
      t.done();
    }
  });
}

test('#464-b2a: the record says started, for this version, before the ssh install begins', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started');
    assert.deepEqual(t.runs[0].recordAtSpawn, { keepUpdated: true, installs: [entry(VERSION, 'started', t.clock.now())] });
  } finally {
    t.done();
  }
});

test('#464-b2a: no record, no install: a failing first write leaves the install unstarted, and the status says why', async () => {
  const t = rig();
  const dir = join(t.dataDir, 'remote-installs');
  try {
    await t.mgr.setKeepUpdated('h1', true);
    // The consent is read (and cached); then the folder can’t be written: a file stands where it was.
    renameSync(dir, `${dir}.away`);
    writeFileSync(dir, 'not a folder');
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0, 'nothing installed');
    assert.equal(typeof t.mgr.status('h1').update?.error, 'string');
  } finally {
    rmSync(dir, { force: true });
    t.done();
  }
});

test('#464-b2a: tried: the same version failing 127 again after its install gets no second install', async () => {
  // The install answers, but the attach after it still exits 127 (the folder keeps disappearing).
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'installed', 'installed');
    await until(() => t.dials.length >= 2, 'the install’s reconnect, which exits 127 again');
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 1, 'one install for this version');
    assert.equal(readRecord(t.dataDir).installs.length, 1);
  } finally {
    t.done();
  }
});

test('#464-b2a: tried: a record left started by a kill installs nothing by itself', async () => {
  const t = rig();
  try {
    writeRecord(t.dataDir, ok({ installs: [entry(VERSION, 'started')] }));
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0);
    const st = t.mgr.status('h1');
    assert.equal(st.keepUpdated, true);
    assert.equal(st.update.outcome, 'started');
  } finally {
    t.done();
  }
});

test('#464-b2a: tried: A, then B, then A again installs A once more, exactly once', async () => {
  const t = rig();
  try {
    // Newest first: this version (A) installed, then 0.9.0 (B) after it.
    writeRecord(t.dataDir, ok({ installs: [entry('0.9.0', 'installed', 2), entry(VERSION, 'installed', 1)] }));
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'installed' && t.runs.length === 1, 'A installed again');
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 1, 'once');
    const rec = readRecord(t.dataDir);
    assert.deepEqual(
      rec.installs.map((/** @type {any} */ i) => [i.version, i.outcome]),
      [
        [VERSION, 'installed'],
        ['0.9.0', 'installed'],
        [VERSION, 'installed'],
      ],
    );
  } finally {
    t.done();
  }
});
