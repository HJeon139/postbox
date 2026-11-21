// The install record’s writes (server/remote/install-record.mjs, #464-b2a): capped at MAX_INSTALLS so the next
// Postbox still reads them, 0600 in a 0700 folder, one after another per host, and a write that fails leaves the
// record kept in memory as it was. Most go to install-record.mjs directly, over a record state of their own.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHostManager } from '../server/remote/hosts.mjs';
import { consentStillOn, setKeepUpdated } from '../server/remote/hosts-update.mjs';
import { changeRecord, MAX_INSTALLS, recordOf } from '../server/remote/install-record.mjs';
import { until, VERSION } from './remote-hosts-fixtures.mjs';
import { readRecord, recordFile, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

const POSIX = process.platform !== 'win32';
const entry = (/** @type {string} */ version, /** @type {string} */ outcome, at = 1) => ({ version, at, outcome });

/** A record state over a temp data folder of its own, as a manager keeps it. */
function records() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-test-record-writes-'));
  const m = { dataDir, installRecords: new Map(), recordWrites: new Map() };
  return { m, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('#464-b2a: a 17th try keeps 16 on disk, so a Postbox started after it still reads the consent', async () => {
  const t = rig();
  /** @type {any} */
  let next = null;
  try {
    const older = Array.from({ length: MAX_INSTALLS }, (_, i) => entry(`0.0.${i + 1}`, 'installed', 100 - i));
    writeRecord(t.dataDir, { keepUpdated: true, installs: older });
    await t.mgr.connect('h1').catch(() => {});
    const newest = () => readRecord(t.dataDir)?.installs?.[0];
    await until(() => newest()?.version === VERSION && newest().outcome === 'installed', 'this version installed');
    assert.equal(readRecord(t.dataDir).installs.length, MAX_INSTALLS);
    // A restart: a new manager on the same data folder, which reads the record afresh.
    next = createHostManager({
      getHost: (/** @type {string} */ id) => t.hosts[id] ?? null,
      dataDir: t.dataDir,
      version: VERSION,
      spawn: t.ssh.spawn,
      now: t.clock.now,
      setTimer: t.clock.setTimer,
      clearTimer: t.clock.clearTimer,
      delay: () => 5,
    });
    const st = next.status('h1');
    assert.equal(st.keepUpdated, true, 'the consent survived the restart');
    assert.equal(st.update?.error, undefined, 'and the record read');
    assert.equal(st.update?.version, VERSION);
  } finally {
    next?.close();
    t.done();
  }
});

test('#464-b2a: a write leaves the record’s folder 0700 and its file 0600, even over a folder that was 0755', { skip: !POSIX && 'POSIX modes' }, async () => {
  const r = records();
  // With no umask, the modes are the ones Postbox asks for, not the ones a umask of 077 would make of any.
  const umask = process.umask(0);
  try {
    const dir = join(r.m.dataDir, 'remote-installs');
    mkdirSync(dir, { mode: 0o755 });
    await changeRecord(r.m, 'h1', () => ({ keepUpdated: true, installs: [] }));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(recordFile(r.m.dataDir)).mode & 0o777, 0o600);
  } finally {
    process.umask(umask);
    r.done();
  }
});

test('#464-b2a: writes queued on one host run one after another: a third queued during the second waits for it', async () => {
  const r = records();
  /** @type {string[]} */
  const events = [];
  /** A change that adds this try, and notes what it was given. @param {string} version */
  const add = (version) => (/** @type {any} */ was) => {
    events.push(`start ${version} over ${was.installs.map((/** @type {any} */ i) => i.version).join(',') || 'none'}`);
    return { keepUpdated: true, installs: [entry(version, 'installed'), ...was.installs] };
  };
  try {
    const first = changeRecord(r.m, 'h1', add('0.0.1'));
    const second = changeRecord(r.m, 'h1', add('0.0.2')).then(() => events.push('end 0.0.2'));
    await first;
    // Microtasks only, so the first’s chain entry settles while the second’s file write is still under way.
    for (let i = 0; i < 10; i++) await null;
    const third = changeRecord(r.m, 'h1', add('0.0.3'));
    await Promise.all([second, third]);
    assert.deepEqual(events, ['start 0.0.1 over none', 'start 0.0.2 over 0.0.1', 'end 0.0.2', 'start 0.0.3 over 0.0.2,0.0.1']);
    assert.deepEqual(
      readRecord(r.m.dataDir).installs.map((/** @type {any} */ i) => i.version),
      ['0.0.3', '0.0.2', '0.0.1'],
      'none overwrote another',
    );
  } finally {
    r.done();
  }
});

const ROOT = process.getuid?.() === 0;

test('#464-b2a: a write that fails leaves the record kept in memory as it was, not as the disk now reads', {
  skip: (!POSIX || ROOT) && 'POSIX modes, not root',
}, async () => {
  const r = records();
  try {
    await changeRecord(r.m, 'h1', () => ({ keepUpdated: true, installs: [entry('0.0.1', 'installed')] }));
    // The folder can’t be reached any more. Write permission alone isn’t enough: the write chmods the record’s own
    // folder back to 0700, so it’s Postbox’s data folder that’s shut, which fails the write and any read of it.
    chmodSync(r.m.dataDir, 0o000);
    await assert.rejects(
      changeRecord(r.m, 'h1', (was) => ({ keepUpdated: false, installs: was.installs })),
      (/** @type {any} */ e) => e?.code === 'EACCES',
    );
    const kept = recordOf(r.m, 'h1');
    assert.equal(kept.keepUpdated, true, 'the consent as the last good write left it');
    assert.equal(kept.refused, undefined, 'not re-read from a folder it can’t reach');
    assert.deepEqual(kept.installs, [entry('0.0.1', 'installed')]);
  } finally {
    chmodSync(r.m.dataDir, 0o700);
    r.done();
  }
});

test('#1530: the consent the person turned off counts at once, while its write waits, and a write that fails leaves it as kept', async () => {
  const { m: state, done } = records();
  /** A manager closed to status (update() returns at once), over the record state. */
  const m = /** @type {any} */ ({ ...state, consentAsked: new Map(), links: new Map(), getHost: () => ({ id: 'h1' }), closed: true });
  try {
    m.installRecords.set('h1', { keepUpdated: true, installs: [] });
    const off = setKeepUpdated(m, 'h1', false);
    assert.equal(consentStillOn(m, 'h1'), false, 'off, before the write has landed');
    await off;
    assert.equal(consentStillOn(m, 'h1'), false, 'and once it has');
    assert.equal(m.consentAsked.size, 0, 'the record holds it now');
    if (POSIX) {
      // A write that fails, as writeRecordFile refuses a records folder that’s a link: the person’s choice isn’t kept,
      // so the record’s consent stands, and nothing of the choice is left counting.
      const folder = join(m.dataDir, 'remote-installs');
      rmSync(folder, { recursive: true, force: true });
      const elsewhere = mkdtempSync(join(tmpdir(), 'pb-test-record-elsewhere-'));
      symlinkSync(elsewhere, folder);
      try {
        await assert.rejects(setKeepUpdated(m, 'h1', true), { code: 'ENOTDIR' });
      } finally {
        rmSync(folder, { force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
      assert.equal(consentStillOn(m, 'h1'), false, 'the record’s consent stands');
      assert.equal(m.consentAsked.size, 0);
    }
  } finally {
    done();
  }
});

test('#1530: a request that fails clears only its own pending choice, not a later one with the same value', async () => {
  if (!POSIX) return;
  const { m: state, done } = records();
  const m = /** @type {any} */ ({ ...state, consentAsked: new Map(), links: new Map(), getHost: () => ({ id: 'h1' }), closed: true });
  const folder = join(m.dataDir, 'remote-installs');
  const elsewhere = mkdtempSync(join(tmpdir(), 'pb-test-record-elsewhere-'));
  try {
    m.installRecords.set('h1', { keepUpdated: true, installs: [] });
    // Two tabs turn it off at once; the record folder is a link, so writeRecordFile refuses each in turn.
    symlinkSync(elsewhere, folder);
    const first = setKeepUpdated(m, 'h1', false);
    const second = setKeepUpdated(m, 'h1', false);
    await assert.rejects(first, { code: 'ENOTDIR' });
    assert.equal(consentStillOn(m, 'h1'), false, 'the second, still waiting its turn, still counts');
    await assert.rejects(second, { code: 'ENOTDIR' });
    assert.equal(consentStillOn(m, 'h1'), true, 'with both refused, the record’s consent stands');
    assert.equal(m.consentAsked.size, 0);
  } finally {
    rmSync(folder, { force: true });
    rmSync(elsewhere, { recursive: true, force: true });
    done();
  }
});
