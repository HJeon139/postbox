// Recording a room (designs/telemetry-persona.md, R1, R2, R5–R11; acceptance 1, 2, 7, 8, 10, 11): unlisted, invisible
// to the agents, kept owner-only in the data folder and never in the project, gone with the room, and read back with the
// history only when a report asks.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshInstall } from '../server/seed.mjs';
import { deleteRecordings, KEEP_MS, startRecording, stopRecording, sweep, watchTelemetry, within } from '../server/telemetry.mjs';
import { draftView } from '../server/telemetry-report.mjs';
import { saveReport } from '../server/telemetry-save.mjs';
import { held } from './side-threads-fixture.mjs';
import { CANARIES, filesUnder, flaggedRoom, labelEach, modeOf, report, settle, setup, turn } from './telemetry-fixture.mjs';

test('acceptance 1: a fresh install has no telemetry persona or boilerplate; recording lives on the conversation only', async () => {
  const fresh = freshInstall();
  assert.ok(!JSON.stringify(fresh).toLowerCase().includes('telemetry'));
  const f = setup();
  const before = Object.keys(f.store.state.personas).length;
  startRecording(f.rt, f.t.id);
  assert.equal(Object.keys(f.store.state.personas).length, before);
  assert.equal(f.store.state.threads[f.t.id].recording.on, true);
  assert.equal(f.store.items(f.t.id).length, 0, 'nothing in the room');
  f.stop();
});

/** The same room, recorded or not: a turn, a 👎, a report when recorded, and two more turns. What every agent got. */
async function inputs(recorded) {
  const f = setup({ record: recorded, answer: labelEach() });
  f.adapter.next.push(turn('First answer.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha run the tests' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((x) => x.kind === 'agent');
  f.rt.act(f.t.id, reply.id, '@react', { emoji: '👎' });
  if (recorded) await report(f, { history: true });
  f.adapter.next.push(turn('Second answer.'), turn('Third answer.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha try again, and @beta check it' });
  await settle(f.rt);
  f.stop();
  const ids = new Map();
  const stable = (s) => s.replace(/\b[a-z]{2,5}_[A-Za-z0-9]{1,8}\b/g, (m) => ids.get(m) ?? ids.set(m, `id${ids.size}`).get(m)).replace(/\d\d:\d\d/g, 'HH:MM');
  return f.adapter.calls.map((c) => stable(JSON.stringify({ handle: c.handle, message: c.message, state: c.state })));
}

test('acceptance 2: every agent’s turn input is byte-identical with recording on and off, reactions and a report included', async () => {
  const off = await inputs(false);
  const on = await inputs(true);
  assert.equal(on.length, 3);
  assert.deepEqual(on, off);
});

test('acceptance 7: the classifier’s one call sends exactly the prepared input, with its secrets trimmed; nothing is written outside telemetry/, nothing in the project', async () => {
  const f = setup({ record: true, answer: labelEach() });
  f.adapter.next.push(turn(`It read AWS_ACCESS_KEY_ID=${CANARIES.key} from .env.`));
  f.rt.sendMessage(f.t.id, { text: '@alpha what did the test read?' });
  await settle(f.rt);
  f.rt.act(f.t.id, f.store.items(f.t.id).find((x) => x.kind === 'agent').id, '@react', { emoji: '🚩' });
  const project = filesUnder(f.folder);
  const { draft } = await report(f, { history: true });
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0], draft.input);
  assert.ok(!f.prompts[0].includes(CANARIES.key), 'the key was trimmed');
  assert.match(f.prompts[0], /\[secret\]/);
  assert.ok(filesUnder(f.data).every((p) => p.startsWith(`telemetry/${f.t.id}/recording/`)));
  saveReport(f.rt, f.t.id, draft.report.id, { hash: draftView(f.rt, f.t.id, draft.report.id).hash });
  assert.ok(filesUnder(f.data).every((p) => p.startsWith(`telemetry/${f.t.id}/`)));
  assert.deepEqual(filesUnder(f.folder), project);
  f.stop();
});

test('acceptance 8: folders are 0700 and files 0600; recording is refused when the folder is inside the project', async () => {
  const f = await flaggedRoom();
  const { id } = await report(f);
  saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash });
  const root = join(f.data, 'telemetry');
  const all = filesUnder(root);
  assert.ok(all.some((p) => p.includes('/streams/')) && all.some((p) => p.endsWith('report.json')));
  for (const p of all) {
    assert.equal(modeOf(join(root, p)), 0o600, p);
    for (let d = join(root, p, '..'); d.startsWith(root); d = join(d, '..')) assert.equal(modeOf(d), 0o700, d);
  }
  const g = setup();
  g.rt.config.telemetryRoot = join(g.folder, '.postbox', 'telemetry');
  assert.throws(() => startRecording(g.rt, g.t.id), /inside this project’s folder/);
  // Through a link, and in another case where the file system doesn’t tell them apart.
  symlinkSync(g.folder, join(g.data, 'project-link'));
  assert.ok(within(join(g.data, 'project-link', 'x', 'telemetry'), g.folder));
  if (process.platform === 'darwin') assert.ok(within(join(g.folder.toUpperCase(), 'x'), g.folder));
  assert.ok(!within(join(g.data, 'telemetry'), g.folder));
  assert.ok(!existsSync(join(g.folder, '.postbox')));
  f.stop();
  g.stop();
});

test('acceptance 8: deleting the conversation deletes its telemetry folder after Undo’s window; Undo keeps it; Delete recordings keeps saved reports', async () => {
  const f = await flaggedRoom();
  const { id } = await report(f);
  saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash });
  const dir = join(f.data, 'telemetry', f.t.id);
  f.rt.deleteThread(f.t.id);
  f.rt.undoDeleteThread(f.t.id);
  assert.ok(existsSync(join(dir, 'recording')), 'Undo kept it');
  deleteRecordings(f.rt, f.t.id);
  assert.ok(!existsSync(join(dir, 'recording', 'turns.jsonl')));
  assert.ok(existsSync(join(dir, 'reports', id, 'report.json')), 'saved reports stay');
  f.rt.deleteThread(f.t.id);
  f.rt.purgeThread(f.t.id);
  assert.ok(!existsSync(dir), 'gone with the conversation');
  f.stop();
});

test('acceptance 8: a stream last written 31 days ago is swept, and a recording with nothing newer goes with it', async () => {
  const f = await flaggedRoom();
  const rec = join(f.data, 'telemetry', f.t.id, 'recording');
  const old = (Date.now() - KEEP_MS - 864e5) / 1000;
  const other = f.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [f.a.id] });
  const keep = join(f.data, 'telemetry', other.id, 'recording', 'streams');
  mkdirSync(keep, { recursive: true });
  for (const p of filesUnder(rec)) utimesSync(join(rec, p), old, old);
  const gone = sweep(f.rt);
  assert.ok(gone.some((p) => p.includes('/streams/')));
  assert.ok(!existsSync(rec));
  assert.ok(existsSync(keep), 'a recording with nothing old stays');
  f.stop();
});

test('acceptance 10: with the history, an item from before recording is labeled and each earlier turn is a gap; without it, nothing before', async () => {
  const f = setup({ answer: labelEach() });
  f.adapter.next.push(async (c) => c.text('Before recording.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha first' });
  await settle(f.rt);
  const early = f.store.items(f.t.id).find((x) => x.kind === 'agent');
  startRecording(f.rt, f.t.id);
  f.rt.act(f.t.id, early.id, '@react', { emoji: '🚩' });
  const withHistory = (await report(f, { history: true })).draft;
  assert.deepEqual(withHistory.report.reactions.length, 1);
  assert.equal(withHistory.report.labels[0].on, 'r1');
  assert.equal(withHistory.report.labels[0].mast, 'FM-3.2');
  assert.ok(withHistory.report.gaps.some((g) => g.kind === 'no-stream' && g.reason === 'before-recording'));
  const without = (await report(f)).draft;
  assert.equal(without.report.reactions, undefined);
  assert.equal(without.report.labels, undefined);
  f.stop();
});

test('acceptance 10: a turn still running when the report is drafted is a gap, not a lower count', async () => {
  const f = setup({ record: true });
  const h = held();
  f.adapter.next.push(async (c) => {
    await turn('partial')(c);
    await h.step(c);
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha take your time' });
  for (let i = 0; i < 100 && !f.store.items(f.t.id).some((x) => x.kind === 'agent'); i++) await new Promise((r) => setTimeout(r, 5));
  const { draft } = await report(f);
  const t1 = draft.report.turns.find((t) => t.ref === 't1');
  assert.equal(t1.recorded, false);
  assert.equal(t1.tokensIn, undefined, 'no count from half a stream');
  assert.ok(draft.report.gaps.some((g) => g.turn === 't1' && g.reason === 'running'));
  h.release();
  await settle(f.rt);
  f.stop();
});

test('acceptance 11: a 🚩 is recorded on the item it was put on, with its time to detect, and that item is labeled', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const [r] = draft.report.reactions;
  assert.equal(r.emoji, '🚩');
  assert.deepEqual(draft.local[r.on], { kind: 'item', id: f.reply.id });
  assert.equal(r.detectMs, 'under-1s');
  assert.equal(draft.report.labels.find((l) => l.on === r.ref).mast, 'FM-3.2');
  assert.ok(readFileSync(join(f.data, 'telemetry', f.t.id, 'recording', 'events.jsonl'), 'utf8').includes('reaction'));
  f.stop();
});

test('review 1: a recording write that fails drops the line and marks a gap; Postbox and the room carry on', async () => {
  const f = setup({ record: true });
  const rec = join(f.data, 'telemetry', f.t.id, 'recording');
  chmodSync(join(rec, 'streams'), 0o500);
  chmodSync(rec, 0o500);
  try {
    f.adapter.next.push(turn('Still here.'));
    f.rt.sendMessage(f.t.id, { text: '@alpha go' });
    await settle(f.rt);
    assert.ok(f.store.items(f.t.id).some((x) => x.kind === 'agent' && x.text === 'Still here.'));
  } finally {
    chmodSync(rec, 0o700);
    chmodSync(join(rec, 'streams'), 0o700);
  }
  const { draft } = await report(f);
  assert.ok(draft.report.gaps.some((g) => g.kind === 'events' && g.reason === 'write-failed'));
  f.stop();
});

test('review 2: saved reports go with their conversation after Delete recordings and a restart, and the sweep takes orphans', async () => {
  const f = await flaggedRoom();
  const { id } = await report(f);
  saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash });
  stopRecording(f.rt, f.t.id);
  deleteRecordings(f.rt, f.t.id);
  f.stop();
  const again = watchTelemetry(f.rt);
  const dir = join(f.data, 'telemetry', f.t.id);
  assert.ok(existsSync(join(dir, 'reports', id)));
  f.rt.deleteThread(f.t.id);
  f.rt.purgeThread(f.t.id);
  assert.ok(!existsSync(dir));
  mkdirSync(join(f.data, 'telemetry', 'th_gone', 'reports', 'rep_x'), { recursive: true });
  assert.ok(sweep(f.rt).includes('th_gone'));
  again();
});
