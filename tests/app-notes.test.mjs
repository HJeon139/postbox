// #1488: one click starts one turn. What an app sends without the person’s click, or past the first send of a click, is
// a note its agent reads with read_app: no turn, no line in the person’s voice, no card, nobody needs them. A click’s
// event goes to the agent however many came before it, with no limit a minute and no card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { clickEvent, EVENTS_PER_MINUTE, NOTE_BYTES, noteApp } from '../server/app-notes.mjs';
import { readApp } from '../server/app-publish.mjs';
import { publicFrame, publicState } from '../server/public-state.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { APP_NOTES_MAX } from '../shared/app-notes.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import * as arrange from './arrange.mjs';
import { sources } from './server-sources-fixture.mjs';

class QuietAdapter {
  name = 'mock';
  calls = [];
  async folderFor() {
    return null;
  }
  async deliver(_session, message) {
    this.calls.push(message);
  }
}

function withApp() {
  const store = new Store(null);
  const adapter = new QuietAdapter();
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const b = rt.createPersona({ handle: 'beta' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  const [se, other] = arrange.sessionsIn(rt, t.id);
  rt.toolsFor(se.id).show_app({ id: 'list', title: 'Reading list', code: '<p>x</p>', permissions: [] });
  return { rt, store, se, other, t, adapter };
}

/** read_app’s answer, as the JSON inside its fence. */
function readOut(rt, sessionId, from) {
  const { message } = readApp(rt, sessionId, { appId: 'list', from });
  return JSON.parse(message.split(/^```+$/m)[1]);
}

const notices = (rt, se) => rt.delivery.waiting(se.id).filter((e) => e.source === 'notice' && e.text.startsWith('[app list]'));

test('#1488 a note waits for the agent’s next turn as one notice: no turn, no line in your voice, no card, nobody needs you', () => {
  const { rt, store, se, t, adapter } = withApp();
  const calls = adapter.calls.length;
  for (let i = 0; i < 7; i++) assert.deepEqual(noteApp(rt, 'list', 'step', { i }), { ok: true, noted: true });
  assert.equal(adapter.calls.length, calls, 'no turn started');
  assert.equal(notices(rt, se).length, 1, 'a burst of notes is one notice');
  assert.match(
    notices(rt, se)[0].text,
    /Reading list has notes for you from sends that started no turn \(no click, or a click’s later sends\) since you last looked\. Call read_app/,
  );
  assert.deepEqual(
    store
      .items(t.id)
      .filter((x) => x.kind !== 'block')
      .map((x) => x.kind),
    [],
    'no line in your voice, and no card',
  );
  assert.equal(rt.s.sessions[se.id].needs ?? null, null);
});

test('#1488 read_app gives the app’s own agent its notes, with the summary each came with, and reading takes them', () => {
  const { rt, se, other } = withApp();
  noteApp(rt, 'list', 'loaded', { rows: 3, summary: 'Loaded 3 books' });
  noteApp(rt, 'list', 'tick', {});
  assert.equal(readOut(rt, other.id).notes, undefined, 'another agent doesn’t get, or take, the app’s notes');
  const out = readOut(rt, se.id);
  assert.deepEqual(
    out.notes.map(({ at: _, ...n }) => n),
    [
      { action: 'loaded', values: { rows: 3 }, summary: 'Loaded 3 books' },
      { action: 'tick', values: {} },
    ],
  );
  assert.match(readApp(rt, se.id, { appId: 'list' }).message, /^App “list”, “Reading list”, v1: what it has published nothing yet, and its saved state/);
  assert.equal(readOut(rt, se.id).notes, undefined, 'read once, they’re gone');
});

test(`#1488 an app keeps ${APP_NOTES_MAX} unread notes; past them read_app counts the ones dropped`, () => {
  const { rt, se } = withApp();
  for (let i = 0; i < APP_NOTES_MAX + 3; i++) noteApp(rt, 'list', 'step', { i });
  const out = readOut(rt, se.id);
  assert.equal(out.notes.length, APP_NOTES_MAX);
  assert.equal(out.notes[0].values.i, 0, 'the unread ones stay');
  assert.equal(out.droppedNotes, 3);
});

test('#1488 a note at its cap adds about its bytes to the log, one past the unread cap adds a count with no payload, and a larger one is refused', () => {
  const { rt, store } = withApp();
  const logged = [];
  store.subscribe((ev) => logged.push(Buffer.byteLength(JSON.stringify(ev))));
  const big = { text: 'x'.repeat(NOTE_BYTES - 20) };
  noteApp(rt, 'list', 'step', big);
  assert.ok(logged[0] < NOTE_BYTES + 1024, `a ${NOTE_BYTES}-byte note wrote ${logged[0]} bytes to the log`);
  for (let i = 1; i < APP_NOTES_MAX; i++) noteApp(rt, 'list', 'step', { i });
  logged.length = 0;
  for (let i = 0; i < 100; i++) noteApp(rt, 'list', 'step', big);
  const past = logged.reduce((n, b) => n + b, 0);
  assert.ok(past < 100 * 200, `100 notes past the cap wrote ${past} bytes to the log`);
  assert.equal(rt.s.appNotes.list.dropped, 100);
  assert.throws(
    () => noteApp(rt, 'list', 'step', { text: 'é'.repeat(NOTE_BYTES / 2) }),
    (e) => e.status === 413 && /16 KB/.test(e.message),
    'bytes, not characters',
  );
});

test('#1488 a note gathered from several in the browser says how many it replaced', () => {
  const { rt, se } = withApp();
  noteApp(rt, 'list', 'step', { i: 7 }, 5);
  noteApp(rt, 'list', 'step', { i: 8 }, 'many');
  assert.deepEqual(
    readOut(rt, se.id).notes.map((n) => n.replaced),
    [5, undefined],
  );
});

test('#1488 reading takes only the notes the read showed: one that comes after stays for the next read', () => {
  const { rt, se } = withApp();
  noteApp(rt, 'list', 'step', { i: 1 });
  assert.deepEqual(
    readOut(rt, se.id).notes.map((n) => n.values.i),
    [1],
  );
  noteApp(rt, 'list', 'step', { i: 2 });
  assert.deepEqual(
    readOut(rt, se.id).notes.map((n) => n.values.i),
    [2],
  );
});

test('#1488 notes read in parts go only once the agent has read to the end, and one sent between parts stays', () => {
  const { rt, se } = withApp();
  for (let i = 0; i < 6; i++) noteApp(rt, 'list', 'big', { text: 'a'.repeat(15_000), i });
  const first = readApp(rt, se.id, { appId: 'list' }).message;
  const next = first.match(/read_app \{ appId: "list", from: (\d+), notes: 6 \} reads on\./);
  assert.ok(next, first.slice(-200));
  assert.ok(rt.s.appNotes.list, 'a first part leaves them');
  noteApp(rt, 'list', 'late', { i: 99 });
  let from = Number(next[1]);
  for (let guard = 0; guard < 10 && rt.s.appNotes.list?.notes.length > 1; guard++) {
    const m = readApp(rt, se.id, { appId: 'list', from, notes: 6 }).message;
    from = Number(m.match(/from: (\d+), notes: 6 \} reads on\./)?.[1] ?? 1e9);
  }
  assert.deepEqual(
    rt.s.appNotes.list?.notes.map((n) => n.action),
    ['late'],
    'the last part takes the six it read, and the late one waits',
  );
});

test('#1488 past 30 events in a minute, an app’s next click is a note: never a card or an error', () => {
  const { rt, store, t } = withApp();
  const now = Date.now();
  for (let i = 0; i < EVENTS_PER_MINUTE; i++) assert.equal(clickEvent(rt, 'list', 'clicked', { i }, now).noted, undefined, `click ${i + 1}`);
  assert.deepEqual(clickEvent(rt, 'list', 'clicked', { i: 'over' }, now), { ok: true, noted: true });
  assert.equal(store.items(t.id).filter((x) => x.kind === 'voice').length, EVENTS_PER_MINUTE);
  assert.deepEqual(
    rt.s.appNotes.list.notes.map((n) => n.values.i),
    ['over'],
  );
  assert.equal(clickEvent(rt, 'list', 'clicked', { i: 'later' }, now + 61_000).ok, true, 'a minute on, a click starts a turn again');
  assert.equal(rt.s.appNotes.list.notes.length, 1);
});

test('#1488 a note is checked as an event is; a retired app can’t send one', () => {
  const { rt, se } = withApp();
  assert.throws(
    () => noteApp(rt, 'list', 'not an id!', {}),
    (e) => e.status === 422,
  );
  assert.throws(
    () => noteApp(rt, 'nope', 'x', {}),
    (e) => e.status === 404,
  );
  rt.toolsFor(se.id).retire_app({ id: 'list', reason: 'Replaced.' });
  assert.throws(
    () => noteApp(rt, 'list', 'x', {}),
    (e) => e.status === 409,
  );
  assert.equal(rt.s.appNotes.list, undefined, 'nothing was kept');
});

test('#1488 a click’s event goes to the agent however many came in the last minute: no limit and no card', () => {
  const { rt, store, se, t } = withApp();
  const sent = [];
  const send = rt.delivery.send.bind(rt.delivery);
  rt.delivery.send = (e, o) => {
    if (e.source === 'event') sent.push(e);
    return send(e, o);
  };
  for (let i = 0; i < 8; i++) {
    const r = rt.appEvent('list', 'clicked', { i }, { now: 1000 + i });
    assert.equal(r.ok, true, `send ${i + 1}`);
    assert.equal(r.held, undefined, `send ${i + 1} wasn’t held`);
  }
  assert.equal(store.items(t.id).filter((x) => x.kind === 'voice').length, 8, 'each in your voice');
  assert.equal(sent.filter((e) => e.sessionId === se.id).length, 8, 'each reached the agent');
  assert.equal(store.items(t.id).filter((x) => !['block', 'voice', 'agent'].includes(x.kind)).length, 0, 'no card');
});

test('#1488 notes are private: no page hears one, and /api/state carries none', () => {
  const { rt, store } = withApp();
  const logged = [];
  store.subscribe((ev) => logged.push(ev));
  noteApp(rt, 'list', 'secret', { marker: 'note-marker' });
  assert.ok(
    logged.some((ev) => JSON.stringify(ev).includes('note-marker')),
    'the log has it',
  );
  assert.ok(
    !logged
      .map((ev) => publicFrame(ev))
      .join('')
      .includes('note-marker'),
    'no page hears it',
  );
  assert.ok(!JSON.stringify(publicState(store.state)).includes('note-marker'), '/api/state carries none of it');
});

test('#1488 only server/app-notes.mjs reads apps’ notes, so no route answers the page with them', () => {
  const readers = sources()
    .filter(([, text]) => /\.appNotes\b|\[\s*['"`]appNotes['"`]\s*\]/.test(text))
    .map(([path]) => path);
  assert.deepEqual(readers, ['app-notes.mjs']);
});

test('#1488 the reducer keeps an app’s notes off its public record, and removing the app removes them', () => {
  const s = emptyState();
  apply(s, 'app', { id: 'a', title: 'A', versions: [] });
  apply(s, 'app.note', { id: 'a', note: { action: 'x', values: {}, at: 1 } });
  assert.deepEqual(s.appNotes.a, { id: 'a', notes: [{ action: 'x', values: {}, at: 1 }], dropped: 0 });
  assert.equal(s.apps.a.notes, undefined, 'not on the app’s public record');
  apply(s, 'app.notes.read', { id: 'a' });
  assert.equal(s.appNotes.a, undefined);
  apply(s, 'app.note', { id: 'a', note: { action: 'x', values: {}, at: 2 } });
  apply(s, 'remove', { kind: 'app', id: 'a' });
  assert.equal(s.appNotes.a, undefined);
});
