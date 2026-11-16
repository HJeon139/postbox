// The line on the rest of a turn’s tail names how to read it (#1428’s review): in a topic or side thread, the thread
// too, since the tail holds both the room’s lines and the thread’s; in a room, read_conversation alone. One sentence
// either way, and naming no one, so a copy of it wakes no one (copiedLine, #1370).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnInput } from '../server/turn-input.mjs';
import { parseMentions } from '../shared/text.mjs';

const entries = [{ id: 'en_1', threadId: 'th_t', itemId: 'it_1', source: 'person', from: 'you', at: 0 }];
const read = () => '@beta check it';
const many = Array.from({ length: 45 }, (_, i) => `[it_${i + 10}] @alpha: line ${i}`);
const topic = { id: 'th_t', kind: 'topic', title: 'Totals' };
const room = { id: 'th_r', kind: 'room' };
const restLine = (text) => text.split('\n\n').find((l) => l.startsWith('[Postbox] Also since your last turn'));

test('#1428 in a topic thread the line on the rest names the thread read_conversation reads', () => {
  const line = restLine(turnInput({ entries, thread: topic, read, tail: many }));
  assert.equal(
    line,
    '[Postbox] Also since your last turn, not addressed to you (the last 40 of 45 items; read_conversation has the rest in order, with thread: "th_t" for this thread’s items, and search_conversation finds one by its words):',
  );
  const none = restLine(turnInput({ entries, thread: topic, read, tail: [`[it_9] @alpha: ${'x'.repeat(20_000)}`] }));
  assert.equal(
    none,
    '[Postbox] Also since your last turn, not addressed to you: 1 item, not shown here. read_conversation has it in order, with thread: "th_t" for this thread’s items, and search_conversation finds one by its words.',
  );
});

test('#1428 in a room the line on the rest names read_conversation alone, and wakes no one copied', () => {
  const line = restLine(turnInput({ entries, thread: room, read, tail: many }));
  assert.equal(
    line,
    '[Postbox] Also since your last turn, not addressed to you (the last 40 of 45 items; read_conversation has the rest in order, and search_conversation finds one by its words):',
  );
  for (const thread of [room, topic]) {
    const copy = restLine(turnInput({ entries, thread, read, tail: many }));
    assert.deepEqual(parseMentions(copy, ['alpha', 'beta']), [], 'a copy of the line wakes no one');
  }
});
