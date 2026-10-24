// --move-data with clones’ telemetry folders in the person’s Postbox folder (designs/telemetry-persona.md, R11;
// server/home-clones.mjs): it’s the person’s real data, so every case here ends with nothing lost. A name that’s taken
// stops the move before anything moves, a failure puts back what moved, a live Postbox stops it at the lock, and what an
// earlier move left set aside is put back first. Everything runs in temp folders.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cloneTelemetry, moveData } from '../server/home.mjs';
import { telemetryRoot } from '../server/telemetry.mjs';

/** A clone with a store and a report in its telemetry folder, and a home folder holding another clone’s. */
function scene() {
  const base = mkdtempSync(join(tmpdir(), 'pb-move-'));
  const root = join(base, 'postbox');
  const home = join(base, 'home');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'events-1.jsonl'), '{"seq":1}\n');
  const to = join(home, '.postbox');
  const own = cloneTelemetry(data, to);
  const other = join(to, 'telemetry-clone-0123456789ab');
  mkdirSync(join(own, 'th_mine', 'reports', 'rep_a'), { recursive: true });
  writeFileSync(join(own, 'th_mine', 'reports', 'rep_a', 'report.json'), '{"mine":true}');
  mkdirSync(join(other, 'th_theirs'), { recursive: true });
  return { base, root, home, data, to, own, other, done: () => rmSync(base, { recursive: true, force: true }) };
}

test('R11: a clone’s telemetry folder is the same for a path in another case, where the file system ignores case', {
  skip: process.platform !== 'darwin',
}, () => {
  const s = scene();
  assert.equal(cloneTelemetry(s.data.toUpperCase(), s.to), cloneTelemetry(s.data, s.to));
  s.done();
});

test('R11: a clone reached through a link is still a clone: its telemetry isn’t in data/', () => {
  const s = scene();
  // A link to the checkout, so its data/ is the clone’s data/ by another path.
  const link = join(s.base, 'linked-checkout');
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link);
  const root = telemetryRoot({ config: {}, store: { dir: join(link, 'data') } });
  assert.ok(!root.startsWith(link) && /telemetry-clone-[0-9a-f]{12}$/.test(root), root);
  s.done();
});

test('--move-data: the data goes in beside other clones’ folders, and this clone’s conversations join telemetry/', async () => {
  const s = scene();
  await moveData({ root: s.root, env: {}, home: s.home });
  assert.ok(existsSync(join(s.to, 'events-1.jsonl')));
  assert.equal(readFileSync(join(s.to, 'telemetry', 'th_mine', 'reports', 'rep_a', 'report.json'), 'utf8'), '{"mine":true}');
  assert.ok(existsSync(join(s.other, 'th_theirs')), 'another clone’s stays where it was');
  assert.ok(!existsSync(s.own) && !existsSync(`${s.to}.incoming`));
  s.done();
});

test('--move-data: a conversation in both this clone’s folder and data/telemetry stops it before anything moves', async () => {
  const s = scene();
  mkdirSync(join(s.data, 'telemetry', 'th_mine'), { recursive: true });
  await assert.rejects(moveData({ root: s.root, env: {}, home: s.home }), /both hold th_mine/);
  assert.ok(existsSync(join(s.data, 'events-1.jsonl')), 'the data is where it was');
  assert.equal(readFileSync(join(s.own, 'th_mine', 'reports', 'rep_a', 'report.json'), 'utf8'), '{"mine":true}', 'the report is kept');
  assert.ok(!existsSync(join(s.data, 'postbox.lock')), 'the lock is let go');
  s.done();
});

test('--move-data: a move that fails partway puts back what moved, and loses nothing', async () => {
  const s = scene();
  writeFileSync(join(s.data, 'snapshot.json'), '{}');
  // A folder that can’t be moved to another parent, last: what moved before it has to go back.
  mkdirSync(join(s.data, 'zz-locked'));
  chmodSync(join(s.data, 'zz-locked'), 0o500);
  try {
    await assert.rejects(moveData({ root: s.root, env: {}, home: s.home }), /EACCES|EPERM|permission/i);
  } finally {
    chmodSync(join(existsSync(join(s.data, 'zz-locked')) ? s.data : s.to, 'zz-locked'), 0o700);
  }
  assert.deepEqual(readdirSync(s.data).sort(), ['events-1.jsonl', 'snapshot.json', 'zz-locked']);
  assert.ok(!existsSync(`${s.to}.incoming`));
  assert.deepEqual(readdirSync(s.to).sort(), [s.own.split('/').at(-1), 'telemetry-clone-0123456789ab'].sort());
  assert.ok(existsSync(join(s.own, 'th_mine', 'reports', 'rep_a', 'report.json')));
  // A retry once the folder can move goes through.
  await moveData({ root: s.root, env: {}, home: s.home });
  assert.ok(existsSync(join(s.to, 'telemetry', 'th_mine', 'reports', 'rep_a', 'report.json')));
  s.done();
});

test('--move-data: a Postbox still running on data/ stops it at the lock, before anything moves', async () => {
  const s = scene();
  writeFileSync(join(s.data, 'postbox.lock'), String(process.ppid));
  await assert.rejects(moveData({ root: s.root, env: {}, home: s.home }), /Another Postbox/);
  assert.ok(existsSync(join(s.own, 'th_mine')) && existsSync(join(s.other, 'th_theirs')) && !existsSync(`${s.to}.clones`));
  s.done();
});

test('--move-data: clones’ folders an earlier move left in .clones are put back first, and the move goes on', async () => {
  const s = scene();
  const aside = `${s.to}.clones`;
  mkdirSync(aside);
  const name = s.other.split('/').at(-1);
  rmSync(join(s.to, name), { recursive: true });
  mkdirSync(join(aside, name, 'th_theirs'), { recursive: true });
  await moveData({ root: s.root, env: {}, home: s.home });
  assert.ok(existsSync(join(s.other, 'th_theirs')) && !existsSync(aside));
  s.done();
});
