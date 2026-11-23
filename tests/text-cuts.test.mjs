// #675: text an agent reads is cut by UTF-16 code units, and a cut that fell between the two halves of a surrogate
// pair (an emoji, a CJK Extension B character) left half a character, which shows as two replacement characters
// (designs/developing.md, habit 7). Each cut now ends one unit earlier there, through shared/text-parts.mjs: the
// host’s read_message from the snapshot (partOf), the history cut (clipItem), the snapshot’s item text, and a reply cut
// to replyChars on either side (cutText).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipItem } from '../server/item-lines.mjs';
import { readMessage } from '../server/remote/host/broker.mjs';
import { OFFLINE_NOTE, offlineText } from '../server/remote/host/broker-offline.mjs';
import { snapshotOf } from '../server/remote/turns-snapshot.mjs';
import { READING } from '../shared/limits.mjs';
import { REMOTE_LIMITS } from '../shared/remote-protocol.mjs';
import { cutText } from '../shared/text-parts.mjs';
import * as arrange from './arrange.mjs';
import { rig } from './remote-turns-helpers.mjs';

const EMOJI = '😀'; // two code units: 😀
const endsHalf = (/** @type {string} */ s) => /[\uD800-\uDBFF]$/.test(s);
const startsHalf = (/** @type {string} */ s) => /^[\uDC00-\uDFFF]/.test(s);

test('#675 the host’s read_message never ends a part inside a character, and its parts join to the whole', () => {
  // The emoji’s first half is the part’s last unit, as a plain cut at READING.part would leave it.
  const full = `${'a'.repeat(READING.part - 1)}${EMOJI}${'b'.repeat(10)}`;
  const snap = { home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'x', text: full }] }] };
  const parts = [];
  let from = 0;
  for (let i = 0; i < 5; i++) {
    const r = readMessage(snap, { id: 'i1', from });
    assert.equal(r.ok, true);
    const [part, footer] = r.text.split('\n\n(');
    assert.ok(!endsHalf(part) && !startsHalf(part), `part ${i} holds whole characters`);
    parts.push(part);
    const next = /from: (\d+) } reads on/.exec(footer ?? '');
    if (!next) break;
    from = Number(next[1]);
  }
  assert.equal(parts.join(''), full);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, READING.part - 1, 'the pair went whole into the next part');
});

test('#675 the history cut never ends inside a character, and says how much it kept', () => {
  const t = `${'a'.repeat(READING.item - 1)}${EMOJI}rest`;
  const cut = clipItem(t, READING.item, 'it_1');
  const kept = cut.slice(0, cut.indexOf('… ('));
  assert.ok(!endsHalf(kept), JSON.stringify(kept.slice(-3)));
  assert.equal(kept.length, READING.item - 1);
  assert.match(cut, new RegExp(`\\(${(READING.item - 1).toLocaleString('en-US')} of ${t.length.toLocaleString('en-US')} characters;`));
  // A cut that splits nothing is as it was.
  assert.equal(clipItem('a'.repeat(READING.item + 5), READING.item, 'it_1').indexOf('…'), READING.item);
});

test('#675 the snapshot’s item text never ends inside a character', () => {
  const r = rig();
  const se = r.se();
  const itemIn = (/** @type {string} */ id) =>
    snapshotOf(/** @type {any} */ ({ rt: r.rt }), se)
      .threads.flatMap((/** @type {any} */ th) => th.items)
      .find((/** @type {any} */ i) => i.id === id);
  // The snapshot’s text is the item’s full line, which starts with who wrote it: measured, so the emoji’s first half
  // falls at the cut.
  const probe = arrange.post(r.rt, r.t.id, { kind: 'user', text: 'PROBE' });
  const before = itemIn(probe.id).text.indexOf('PROBE');
  assert.ok(before >= 0);
  const text = `${'a'.repeat(REMOTE_LIMITS.snapshotTextChars - 1 - before)}${EMOJI}tail`;
  const it = arrange.post(r.rt, r.t.id, { kind: 'user', text });
  const item = itemIn(it.id);
  assert.ok(item, 'the item is in the snapshot');
  assert.ok(item.text.length <= REMOTE_LIMITS.snapshotTextChars);
  assert.ok(!endsHalf(item.text), JSON.stringify(item.text.slice(-3)));
});

test('#675 a reply cut to replyChars never ends inside a character, the offline note kept at its end', () => {
  const s = `${'a'.repeat(REMOTE_LIMITS.replyChars - 1)}${EMOJI}more`;
  const cut = cutText(s, REMOTE_LIMITS.replyChars);
  assert.equal(cut.length, REMOTE_LIMITS.replyChars - 1);
  assert.ok(!endsHalf(cut));
  assert.equal(cutText('short', 10), 'short');
  // The offline answer is cut shorter, to keep its note: the emoji’s first half at that cut.
  const atNote = `${'a'.repeat(REMOTE_LIMITS.replyChars - OFFLINE_NOTE.length - 1)}${EMOJI}${'m'.repeat(OFFLINE_NOTE.length)}`;
  const offline = offlineText(atNote);
  assert.ok(offline.length <= REMOTE_LIMITS.replyChars);
  assert.ok(offline.endsWith(OFFLINE_NOTE));
  assert.ok(!endsHalf(offline.slice(0, -OFFLINE_NOTE.length)), 'no first half without its second');
});
