import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRecordBatch } from '../shared/record-batch.mjs';
import { attemptIdentity } from '../shared/record-events.mjs';
import { askHeaders, attentionHeaders, deliveryHeaders, dispatchManifest, receiptRows } from '../shared/record-selectors.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { ask, change, close, delivery, reserved } from './records-fixture.mjs';

function run(state, events) {
  const batch = buildRecordBatch(state, events);
  for (const e of batch.events) apply(state, e.type, e.data);
  return batch;
}

test('two asks remain distinct without transcript items, and closing one leaves the other', () => {
  const s = emptyState();
  delete s.items;
  const a = ask(),
    b = ask('ask_2', { at: 5 });
  run(s, [change('open', a), change('open', b)]);
  assert.deepEqual(
    askHeaders(s).map((x) => x.id),
    [b.id, a.id],
  );
  run(s, [close(a)]);
  assert.deepEqual(
    askHeaders(s).map((x) => x.id),
    [b.id],
  );
});

test('duplicate source and cross-conversation holds reject without applying a partial group', () => {
  const s = emptyState();
  run(s, [change('open', ask())]);
  assert.throws(() => run(s, [change('open', ask('duplicate', { sourceId: ask().sourceId }))]), { code: 'ERECORD' });
  assert.throws(() => run(s, [change('open', delivery('held', { state: 'held', heldBy: ask().id, reason: 'held', conversationId: 'elsewhere' }))]), {
    code: 'ERECORD',
  });
  assert.deepEqual(Object.keys(s.records), [ask().id]);
});

test('an ask close must release every held delivery in its atomic batch', () => {
  const s = emptyState(),
    a = ask();
  const d = delivery('held', { state: 'held', heldBy: a.id, reason: 'held' });
  run(s, [change('open', a), change('open', d)]);
  assert.throws(() => run(s, [close(a)]), { code: 'ERECORD' });
  const { heldBy: _, ...released } = { ...d, version: 2, state: 'waiting', reason: 'busy' };
  run(s, [close(a), change('release', released)]);
  assert.equal(s.records[a.id], undefined);
  assert.equal(s.records[d.id].state, 'waiting');
});

test('stale versions cannot close or resurrect a record and add no receipt', () => {
  const s = emptyState(),
    a = ask();
  run(s, [change('open', a)]);
  const stale = run(s, [close(a, 'answered', { previousVersion: 0 })]);
  assert.equal(stale.outcome, 'stale');
  assert.deepEqual(receiptRows(stale.events), []);
  const accepted = run(s, [close(a)]);
  assert.equal(receiptRows([...accepted.events, ...accepted.events]).length, 1);
  assert.equal(run(s, [change('revise', { ...a, version: 2, rev: 2 })]).outcome, 'stale');
  assert.equal(s.records[a.id], undefined);
});

test('editing a sent source preserves pinned bytes and exact evidence leaves a newer amendment waiting', () => {
  const s = emptyState(),
    d = delivery();
  run(s, [change('open', d)]);
  const sent = reserved(d);
  run(s, [change('reserve', sent)]);
  const edited = { ...sent, version: 3, rev: 2, parts: [{ text: 'Edited message', at: 11 }] };
  run(s, [change('revise', edited)]);
  assert.equal(s.dispatches[sent.dispatchId].entries[0].parts[0].text, 'Original message');
  assert.equal(deliveryHeaders(s, d.to)[0].rev, 2);
  assert.equal(run(s, [close(edited, 'delivered', { attemptIdentity: { ...attemptIdentity(sent), turnId: 'old_turn' } })]).outcome, 'stale');
  assert.throws(() => run(s, [close(edited, 'delivered', { attemptIdentity: attemptIdentity(sent) })]), { code: 'ERECORD' });
  const waiting = delivery(d.id, { version: 4, rev: 2, attempt: 1, parts: edited.parts, reason: 'amendment' });
  const acknowledged = run(s, [change('requeue', waiting, 3, { attemptIdentity: attemptIdentity(sent), final: 'delivered', at: 20 })]);
  assert.equal(receiptRows(acknowledged.events)[0].id, d.id);
  assert.equal(receiptRows(acknowledged.events)[0].attemptIdentity.sentRev, 1);
  assert.equal(s.records[d.id].state, 'waiting');
  assert.equal(s.dispatches[sent.dispatchId], undefined);
});

test('the reducer boundary enforces UTF-8 pin ceilings even without a dispatch selector', () => {
  const s = emptyState(),
    d = delivery('large', { parts: [{ text: '界'.repeat(22000) }] });
  run(s, [change('open', d)]);
  assert.throws(() => run(s, [change('reserve', reserved(d))]), { code: 'ERECORD' });
  assert.equal(s.records[d.id].state, 'waiting');
  assert.equal(Object.keys(s.dispatches).length, 0);
});

test('binding cannot collide with an already-owned source or change a bound recipient', () => {
  const s = emptyState();
  const unbound = delivery('unbound', { to: { persona: 'persona_1' }, sourceId: 'same_source' });
  const bound = delivery('bound', { sourceId: 'same_source' });
  run(s, [change('open', unbound), change('open', bound)]);
  assert.throws(() => run(s, [change('bind', { ...unbound, version: 2, to: bound.to })]), { code: 'ERECORD' });
  assert.throws(() => run(s, [change('bind', { ...bound, version: 2, to: { ...bound.to, session: 'another_session' } })]), { code: 'ERECORD' });
  assert.equal(Object.keys(s.records).length, 2);
});

test('unknown schemas and fields, unsafe identities and generic removes fail explicitly', () => {
  const s = emptyState();
  for (const extra of [{ schema: 2 }, { extra: 'field' }, { id: '__proto__' }]) {
    assert.throws(() => run(s, [change('open', ask('bad', extra))]), { code: 'ERECORD' });
  }
  run(s, [change('open', ask())]);
  assert.throws(() => apply(s, 'remove', { kind: 'record', id: 'ask_1' }), /explicit close/);
  assert.ok(s.records.rec_ask_1);
});

test('four unresolved dispatches per recipient turn are allowed and the fifth stays waiting', () => {
  const s = emptyState();
  for (let n = 0; n < 5; n++) {
    const d = delivery(`d${n}`);
    run(s, [change('open', d)]);
    if (n < 4) run(s, [change('reserve', reserved(d))]);
    else assert.throws(() => run(s, [change('reserve', reserved(d))]), { code: 'ERECORD' });
  }
  assert.equal(Object.keys(s.dispatches).length, 4);
  assert.equal(s.records.rec_d4.state, 'waiting');
});

test('one manifest can pin several sources in order without transferring its consumer', () => {
  const s = emptyState(),
    a = delivery('a'),
    b = delivery('b');
  run(s, [change('open', a), change('open', b)]);
  const sa = reserved(a),
    sb = reserved(b, { dispatchId: sa.dispatchId });
  run(s, [change('reserve', sa), change('reserve', sb)]);
  assert.deepEqual(
    s.dispatches[sa.dispatchId].entries.map((r) => r.recordId),
    [a.id, b.id],
  );
  const before = dispatchManifest(s, sa.dispatchId);
  run(s, [close(sa, 'delivered', { attemptIdentity: attemptIdentity(sa) })]);
  assert.deepEqual(dispatchManifest(s, sa.dispatchId), before, 'a partial settlement cannot change replay bytes');
  run(s, [close(sb, 'delivered', { attemptIdentity: attemptIdentity(sb) })]);
  assert.equal(dispatchManifest(s, sa.dispatchId), null);
});

test('failure status and distinct asks are ordered without reading transcript items', () => {
  const s = emptyState();
  delete s.items;
  run(s, [change('open', ask())]);
  s.sessions.failed = { id: 'failed', threadId: 'conv', updatedAt: 5, needs: { kind: 'failed' } };
  s.sessions.denial = { id: 'denial', threadId: 'conv', updatedAt: 15, needs: { kind: 'denial' } };
  assert.deepEqual(
    attentionHeaders(s).map((h) => h.askKind),
    ['failed', 'block', 'denial'],
  );
  assert.equal(Object.keys(s.records).length, 1);
});

test('manifest replay is immutable after a source disappears and refuses an unknown renderer', () => {
  const s = emptyState(),
    d = delivery();
  run(s, [change('open', d), change('reserve', reserved(d))]);
  delete s.items;
  const copy = dispatchManifest(s, `dispatch_${d.id}`);
  copy.entries[0].parts[0].text = 'caller edit';
  assert.equal(dispatchManifest(s, copy.id).entries[0].parts[0].text, 'Original message');
  s.dispatches[copy.id].renderVersion = 2;
  assert.throws(() => dispatchManifest(s, copy.id), { code: 'ERECORD' });
});

test('a manifest cannot be shared with a different consumer target', () => {
  const s = emptyState(),
    a = delivery('a'),
    b = delivery('b');
  run(s, [change('open', a), change('open', b)]);
  const first = reserved(a);
  run(s, [change('reserve', first)]);
  assert.throws(() => run(s, [change('reserve', reserved(b, { dispatchId: first.dispatchId, target: { callId: 'other_call' } }))]), { code: 'ERECORD' });
  assert.equal(s.records.rec_b.state, 'waiting');
  assert.equal(s.dispatches[first.dispatchId].entries.length, 1);
});

test('one dispatch cannot bypass the recipient-turn byte ceiling by grouping many sources', () => {
  const s = emptyState();
  const sources = Array.from({ length: 5 }, (_, n) => delivery(`bytes_${n}`, { parts: [{ text: 'x'.repeat(60000) }] }));
  run(
    s,
    sources.map((d) => change('open', d)),
  );
  assert.throws(
    () =>
      run(
        s,
        sources.map((d) => change('reserve', reserved(d, { dispatchId: 'one_dispatch' }))),
      ),
    { code: 'ERECORD' },
  );
  assert.equal(
    Object.values(s.records).every((r) => r.state === 'waiting'),
    true,
  );
  assert.equal(Object.keys(s.dispatches).length, 0);
});

test('canonical parts refuse sparse arrays and route targets refuse unrelated or oversized identities', () => {
  const s = emptyState();
  assert.throws(() => run(s, [change('open', delivery('sparse', { parts: new Array(1) }))]), { code: 'ERECORD' });
  const d = delivery();
  run(s, [change('open', d)]);
  for (const target of [{ callId: 'call_1', hostId: 'h' }, { callId: 'call_1', inputId: 'unrelated' }, { callId: 'x'.repeat(257) }]) {
    assert.throws(() => run(s, [change('reserve', reserved(d, { target }))]), { code: 'ERECORD' });
  }
  assert.equal(s.records[d.id].state, 'waiting');
});

test('an empty batch reports noop and a record id needs its server prefix', () => {
  const s = emptyState();
  assert.deepEqual(buildRecordBatch(s, []), { outcome: 'noop', events: [] });
  assert.throws(() => run(s, [change('open', ask('bad', { id: 'caller_chosen_id' }))]), { code: 'ERECORD' });
});

test('a published manifest cannot gain another source in a later commit', () => {
  const s = emptyState(),
    a = delivery('published_a'),
    b = delivery('published_b');
  run(s, [change('open', a), change('open', b)]);
  const sa = reserved(a);
  run(s, [change('reserve', sa)]);
  const before = dispatchManifest(s, sa.dispatchId);
  assert.throws(() => run(s, [change('reserve', reserved(b, { dispatchId: sa.dispatchId }))]), { code: 'ERECORD' });
  assert.deepEqual(dispatchManifest(s, sa.dispatchId), before);
  assert.equal(s.records[b.id].state, 'waiting');
});
