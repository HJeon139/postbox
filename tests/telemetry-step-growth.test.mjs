// Recorded activity events grow with the number of tool-step changes, not with every accumulated step list (#452).

import assert from 'node:assert/strict';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLines } from '../server/telemetry.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { labelEach, report, settle, setup } from './telemetry-fixture.mjs';

const turnOf = (count) => async (ctx) => {
  ctx.text('Working.');
  for (let i = 0; i < count; i++) {
    const step = { id: `s${i}`, label: `Read file ${i}`, detail: 'x'.repeat(300) };
    ctx.activity({ ...step, state: 'running' });
    ctx.activity({ ...step, state: 'done', ms: 120 });
  }
};

async function recordedBytes(count) {
  const fixture = setup({ record: true });
  try {
    fixture.adapter.next.push(turnOf(count));
    fixture.rt.sendMessage(fixture.t.id, { text: '@alpha go' });
    await settle(fixture.rt);
    const file = join(fixture.data, 'telemetry', fixture.t.id, 'recording', 'events.jsonl');
    return statSync(file).size;
  } finally {
    fixture.stop();
    rmSync(fixture.folder, { recursive: true, force: true });
    rmSync(fixture.data, { recursive: true, force: true });
  }
}

test('doubling a recorded turn’s steps grows its event file by less than three times', async () => {
  const small = await recordedBytes(40);
  const large = await recordedBytes(80);

  assert.ok(large < small * 3, `40 steps wrote ${small} bytes; 80 wrote ${large} bytes`);
});

test('readLines reads bounded chunks, joins split values, and skips malformed lines', () => {
  const long = { id: 1, text: 'x'.repeat(70_000) };
  const input = Buffer.from(`${JSON.stringify(long)}\nnot json\n${JSON.stringify({ id: 2 })}\n`);
  const reads = [];
  let offset = 0;
  let closed = false;
  const io = {
    existsSync: () => true,
    openSync: () => 7,
    readSync: (_fd, buffer, start, length) => {
      reads.push(length);
      const bytes = Math.min(length, input.length - offset);
      input.copy(buffer, start, offset, offset + bytes);
      offset += bytes;
      return bytes;
    },
    closeSync: () => {
      closed = true;
    },
  };

  assert.deepEqual(readLines('virtual-events.jsonl', io), [long, { id: 2 }]);
  assert.ok(reads.length > 2, 'the value crossed a chunk and a final read found EOF');
  assert.ok(Math.max(...reads) <= 64 * 1024, 'no read asks for the whole file');
  assert.equal(closed, true);
});

test('nine turns of four hundred steps keep a report buildable', async () => {
  const fixture = setup({ record: true, answer: labelEach() });
  try {
    for (let turn = 0; turn < 9; turn++) {
      fixture.adapter.next.push(turnOf(400));
      fixture.rt.sendMessage(fixture.t.id, { text: '@alpha go' });
      await settle(fixture.rt);
    }

    const file = join(fixture.data, 'telemetry', fixture.t.id, 'recording', 'events.jsonl');
    assert.ok(statSync(file).size < 20 * 1024 * 1024, 'the recording stays below 20 MB');
    const built = await report(fixture, { history: true });
    assert.ok(built.id);
  } finally {
    fixture.stop();
    rmSync(fixture.folder, { recursive: true, force: true });
    rmSync(fixture.data, { recursive: true, force: true });
  }
});

test('incremental activity events replay new, updated, and post-turn job steps exactly', async () => {
  const fixture = setup();
  try {
    fixture.adapter.next.push(async (ctx) => {
      ctx.text('Working.');
      ctx.activity({ id: 'first', label: 'Read one', state: 'running', detail: 'started' });
      ctx.activity({ id: 'second', label: 'Read two', state: 'running' });
      ctx.activity({ id: 'first', label: 'Read one', state: 'done', ms: 9 });
    });
    fixture.rt.sendMessage(fixture.t.id, { text: '@alpha go' });
    await settle(fixture.rt);
    const reply = fixture.store.items(fixture.t.id).find((item) => item.kind === 'agent' && item.activity?.steps?.length);
    fixture.rt.setJobStep(
      { sessionId: fixture.alpha.id, turnId: reply.turnId, threadId: fixture.t.id, itemId: reply.id, toolUseId: 'second' },
      { state: 'done', ms: 12, detail: 'finished after the turn' },
    );
    const expected = [
      { id: 'first', label: 'Read one', state: 'done', ms: 9, detail: 'started' },
      { id: 'second', label: 'Read two', state: 'done', ms: 12, detail: 'finished after the turn' },
    ];
    assert.deepEqual(fixture.store.item(fixture.t.id, reply.id).activity.steps, expected);

    const replayed = emptyState();
    for (const event of fixture.store.since(0)) apply(replayed, event.type, event.data);
    assert.deepEqual(replayed.items[fixture.t.id].find((item) => item.id === reply.id).activity.steps, expected);
  } finally {
    fixture.stop();
    rmSync(fixture.folder, { recursive: true, force: true });
    rmSync(fixture.data, { recursive: true, force: true });
  }
});
