// The asset store’s UAT checks (tools/uat/checks-assets.mjs): each passes a recorded run as it was, and flags the
// fault edited into it. The fixture is trimmed from two recorded runs of the assets-room scenario
// (tests/fixtures/uat-assets/recorded-runs.json says which); the stream and probe records follow the shapes the runner
// writes (server/room-checks.mjs’s facts, and the conversation action’s probes).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { apply, emptyState } from '../shared/state.mjs';
import { runChecks } from '../tools/uat/checks.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/uat-assets/recorded-runs.json', import.meta.url), 'utf8'));
const files = () => recorded.files.map((f) => ({ sha: f.sha, bytes: Buffer.from(f.text, 'utf8') }));
const copy = (x) => structuredClone(x);

/** The state the recorded log leaves, through the reducer, with `extra` events after it. */
function stateOf(log, extra = []) {
  const s = emptyState();
  for (const e of [...log, ...extra]) apply(s, e.type, e.data);
  return s;
}

/** The asset checks’ findings on these facts, by check. */
function found(facts) {
  const ids = ['asset-content-in-store', 'asset-room-orphan', 'turn-in-deleting-conversation'];
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const f of runChecks({ probes: {}, streams: [], ...facts }, { only: ids })) out[f.check].push(f);
  return out;
}

/** A recorded run’s facts, with its log edited by `edit` first. */
function facts(edit = (log) => log) {
  const log = edit(copy(recorded.log));
  return { store: { log, snapshot: null, files: files() }, state: stateOf(log) };
}

const head = recorded.log.find((e) => e.type === 'asset.version');
const room = recorded.log.find((e) => e.type === 'asset').data.room;

test('the recorded run passes all three asset checks as it was', () => {
  const f = found(facts());
  assert.deepEqual(
    Object.values(f).map((x) => x.length),
    [0, 0, 0],
  );
  assert.ok(recorded.files.length >= 3 && recorded.log.some((e) => e.type === 'asset.version'), 'it has asset files and versions to check');
});

test('#722: a version carrying its content, as hex, base64, a Buffer’s array or text, is flagged where it is', () => {
  const bytes = files().find((x) => x.sha === head.data.version.sha256).bytes;
  const forms = {
    hex: bytes.toString('hex'),
    base64: bytes.toString('base64'),
    bytes: JSON.parse(JSON.stringify(bytes)),
    text: bytes.toString('utf8'),
  };
  for (const [form, value] of Object.entries(forms)) {
    const f = found(
      facts((log) => {
        log.find((e) => e.seq === head.seq).data.version.copy = value;
        return log;
      }),
    )['asset-content-in-store'];
    assert.ok(
      f.some((x) => x.evidence.includes(`in the log #${head.seq} under asset.version.version.copy`)),
      `${form}: ${f.map((x) => x.evidence).join(' | ')}`,
    );
    assert.ok(
      f.some((x) => /Version \d+ of asset .* has the key “copy”/.test(x.evidence)),
      `${form}: the state’s version carries a key no version has`,
    );
  }
});

test('#722: content in a snapshot or the final state is flagged too, under its key', () => {
  const text = recorded.files[0].text;
  const f = facts();
  f.store.snapshot = { sessions: { se_1: { id: 'se_1', context: [{ kind: 'notice', text }] } } };
  f.state.sessions = { se_2: { id: 'se_2', context: [{ kind: 'notice', text }] } };
  const where = found(f)['asset-content-in-store'].map((x) => x.evidence);
  assert.ok(
    where.some((e) => e.includes('in the snapshot under sessions.se_1.context.0.text')),
    where.join(' | '),
  );
  assert.ok(
    where.some((e) => e.includes('in the state under sessions.se_2.context.0.text')),
    where.join(' | '),
  );
});

test('#722: someone’s own words quoting an asset aren’t flagged: the recorded lastMessage, an agent reply, the person', () => {
  const { event, file } = recorded.quotedLastMessage;
  const line = file.text.trim();
  const log = [
    event,
    { seq: 900, type: 'item.add', data: { threadId: room, item: { id: 'it_a', kind: 'agent', text: `I read it: ${line}` } } },
    { seq: 901, type: 'item.add', data: { threadId: room, item: { id: 'it_u', kind: 'user', text: `Publish exactly: ${line}` } } },
  ];
  const store = { log, snapshot: null, files: [{ sha: file.sha, bytes: Buffer.from(file.text, 'utf8') }] };
  assert.equal(found({ store, state: emptyState() })['asset-content-in-store'].length, 0);
  // The same words in a notice Postbox wrote are a copy.
  log.push({ seq: 902, type: 'item.add', data: { threadId: room, item: { id: 'it_s', kind: 'system', text: line } } });
  assert.equal(found({ store, state: emptyState() })['asset-content-in-store'].length, 1);
});

test('#722: a short asset is looked for in no form, since its forms are everywhere', () => {
  // “abc” is YWJj in base64, which an id made of random letters can hold by chance.
  const log = [{ seq: 1, type: 'item.add', data: { threadId: room, item: { id: 'it_xYWJjQ', kind: 'system', text: 'abc' } } }];
  const store = { log, snapshot: null, files: [{ sha: 'a'.repeat(64), bytes: Buffer.from('abc') }] };
  assert.equal(found({ store, state: emptyState() })['asset-content-in-store'].length, 0);
});

test('#723: a room index or asset left after its conversation is gone is flagged; a conversation in its Undo window isn’t', () => {
  const removed = { type: 'remove', data: { kind: 'thread', id: room } };
  const erase = { type: 'asset.erase', data: { room, at: 1 } };
  const left = found({ state: stateOf(recorded.log, [removed]) })['asset-room-orphan'];
  assert.deepEqual(left.map((x) => x.evidence).sort(), [`Room ${room} has no conversation, but the state keeps its room index.`]);
  assert.equal(found({ state: stateOf(recorded.log, [erase, removed]) })['asset-room-orphan'].length, 0, 'erased, then removed');
  const thread = stateOf(recorded.log).threads[room];
  const deleting = { type: 'thread', data: { ...thread, deleting: Date.now() + 10_000 } };
  assert.equal(found({ state: stateOf(recorded.log, [deleting]) })['asset-room-orphan'].length, 0, 'Undo brings them back');
  // An asset whose room index was dropped, but which is still there.
  const s = stateOf(recorded.log, [removed]);
  delete s.assetRooms[room];
  assert.match(found({ state: s })['asset-room-orphan'][0].evidence, /keeps asset as_/);
});

test('#725: a turn that starts in a delete’s window, or runs on after its purge, is flagged; one stopped at the delete isn’t', () => {
  const at = Date.parse('2026-11-03T16:30:00Z');
  const del = { do: 'delete', at, until: at + 10_000, threadId: room, handles: ['researcher'] };
  const turns = (streams, conversation = [del]) => found({ probes: { conversation }, streams })['turn-in-deleting-conversation'];
  const stream = (started, ended, handle = 'researcher') => ({ handle, events: [], started, ended });
  assert.equal(turns([stream(at - 5000, at + 300)]).length, 0, 'stopped by the delete');
  assert.match(turns([stream(at + 4000, at + 6000)])[0].evidence, /started in the window/);
  assert.match(turns([stream(at - 5000, at + 15_000)])[0].evidence, /ran on after the purge/);
  assert.equal(turns([stream(at + 4000, at + 6000, 'critic')]).length, 0, 'another conversation’s agent');
  const undo = { do: 'undo', at: at + 3000, threadId: room };
  assert.equal(turns([stream(at + 4000, at + 6000)], [del, undo]).length, 0, 'after Undo');
  assert.equal(turns([stream(at - 5000, at + 15_000)], [del, undo]).length, 0, 'no purge after Undo');
});

test('readStore: null for a run with no asset, else the whole log in order, the snapshot and the asset files', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readStore } = await import('../tools/uat/run-files.mjs');
  const data = mkdtempSync(join(tmpdir(), 'pb-uatstore-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  writeFileSync(join(data, 'events-1.jsonl'), '{"seq":1,"type":"thread","data":{}}\n');
  assert.equal(readStore(data), null, 'no asset files');
  const sha = recorded.files[0].sha;
  mkdirSync(join(data, 'assets', sha.slice(0, 2)), { recursive: true });
  writeFileSync(join(data, 'assets', sha.slice(0, 2), sha.slice(2)), recorded.files[0].text);
  // Segments sort by their first seq, not as text; a commit’s events are one line, an array.
  writeFileSync(join(data, 'events-10.jsonl'), '[{"seq":10,"type":"asset","data":{}},{"seq":11,"type":"asset.version","data":{}}]\n');
  writeFileSync(join(data, 'events-2.jsonl'), '{"seq":2,"type":"item.add","data":{}}\n{"seq":3,"type":"cut');
  writeFileSync(join(data, 'snapshot.json'), '{"seq":0}');
  const st = readStore(data);
  assert.deepEqual(
    st.log.map((e) => e.seq),
    [1, 2, 10, 11],
  );
  assert.deepEqual(st.snapshot, { seq: 0 });
  assert.deepEqual(
    st.files.map((f) => [f.sha, f.bytes.toString('utf8')]),
    [[sha, recorded.files[0].text]],
  );
});

test('#722: an agent’s item is its words only where it wrote them; a tool call’s step in it is Postbox’s record', () => {
  const line = recorded.files[0].text.split('\n')[0];
  const room = recorded.log.find((e) => e.type === 'asset').data.room;
  // The step Postbox wrote for a read_asset call in the 13d8fa0a run, with an asset’s first line edited into its detail.
  const tool = { id: 'toolu_bdrk_01SsvLsW8Vu1tKXzSsz9cNzf', label: 'read asset (postbox)', state: 'done', ms: 74, detail: line };
  const thought = { id: 'thought-1', label: 'Reading it', state: 'done', ms: null, detail: `It says: ${line}`, kind: 'thought' };
  const agent = { id: 'it_a', kind: 'agent', text: '', activity: { steps: [thought, tool] } };
  const where = (store, state = emptyState()) =>
    found({ store: { files: files(), snapshot: null, ...store }, state })['asset-content-in-store'].map((x) => x.evidence);
  const added = { seq: 1, type: 'item.add', data: { threadId: room, item: { id: 'it_a', kind: 'agent', text: '' } } };
  const step = (s, seq) => ({ seq, type: 'item.patch', data: { threadId: room, id: 'it_a', activityStep: s } });
  assert.deepEqual(where({ log: [added, step(thought, 2)] }), [], 'its thinking is its own words');
  const streamed = { seq: 6, type: 'item.text', data: { threadId: room, id: 'it_a', text: line } };
  assert.deepEqual(where({ log: [added, streamed] }), [], 'its reply, as it streams, is its own words');
  assert.match(where({ log: [added, step(tool, 3)] }).join(' | '), /in the log #3 under item\.patch\.activityStep\.detail/);
  const snapshot = { items: { [room]: [agent] } };
  assert.match(where({ log: [], snapshot }).join(' | '), /in the snapshot under items\..*\.activity\.steps\.1\.detail/);
  // Versions 1 and 2 of the recorded plan share that line, so both files are found, each in the tool step alone.
  assert.ok(
    where({ log: [], snapshot }).every((e) => e.includes('activity.steps.1.detail')),
    'the thought step at 0 isn’t counted',
  );
  // The same tool step in an item.add’s whole item, or an item.patch’s patch.
  const whole = { seq: 4, type: 'item.add', data: { threadId: room, item: { ...agent, id: 'it_b' } } };
  assert.match(where({ log: [whole] }).join(' | '), /under item\.add\.item\.activity\.steps\.1\.detail/);
  const patch = { seq: 5, type: 'item.patch', data: { threadId: room, id: 'it_a', patch: { activity: agent.activity } } };
  assert.match(where({ log: [added, patch] }).join(' | '), /under item\.patch\.patch\.activity\.steps\.1\.detail/);
});
