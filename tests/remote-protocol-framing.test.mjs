// The protocol’s framing (shared/remote-protocol.mjs, “Framing”): lines split on \n with their byte offsets, and
// what a line over the limit, one that isn’t UTF-8 or input that ends mid-line does to the reader.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineReader, createMessageReader, encode, message, parseLine, REMOTE_LIMITS, utf8Bytes } from '../shared/remote-protocol.mjs';

// ── Framing ─────────────────────────────────────────────────────────────────────────

/** A line reader that records what it gives. @param {object} [opts] */
const lines = (opts = {}) => {
  const got = [];
  const errors = [];
  const r = createLineReader({ onLine: (text, span) => got.push({ text, ...span }), onError: (e) => errors.push(e), ...opts });
  return { r, got, errors };
};

test('encode writes one message per line, and parseLine reads it back', () => {
  const line = encode(message('postbox-to-daemon', 'write', { turn: 't1', line: 'a "quoted"\ttext' }));
  assert.equal(line.indexOf('\n'), line.length - 1, 'one \\n, at the end');
  const r = parseLine('postbox-to-daemon', line.slice(0, -1));
  assert.ok(r.ok);
  assert.equal(r.ok && r.msg.line, 'a "quoted"\ttext');
});

test('lines split across chunks, even inside a multi-byte character, come out whole with byte offsets', () => {
  const { r, got, errors } = lines();
  const bytes = new TextEncoder().encode('héllo\n\nwörld\n');
  for (const b of bytes) r.push(Uint8Array.of(b));
  assert.deepEqual(errors, []);
  assert.deepEqual(got, [
    { text: 'héllo', offset: 0, next: 7 },
    { text: '', offset: 7, next: 8 },
    { text: 'wörld', offset: 8, next: 15 },
  ]);
});

test('a line over the limit is reported once and skipped, and the next line is read', () => {
  const { r, got, errors } = lines({ maxBytes: 8 });
  r.push('short\n0123');
  r.push('456789 and more\nok\n');
  assert.deepEqual(
    got.map((g) => g.text),
    ['short', 'ok'],
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'too-long');
  assert.equal(errors[0].offset, 6);
  assert.equal(got[1].offset, 6 + 'abcdefghij and more'.length + 1, 'offsets still count the skipped bytes');
});

test('a line that isn’t UTF-8 is reported and skipped', () => {
  const { r, got, errors } = lines();
  r.push(Uint8Array.of(0xff, 0xfe, 0x0a, 0x6f, 0x6b, 0x0a));
  assert.deepEqual(
    got.map((g) => g.text),
    ['ok'],
  );
  assert.equal(errors[0].code, 'bad-utf8');
});

test('input that ends mid-line is torn on a channel, and delivered as the last line of a finished log', () => {
  const torn = lines();
  torn.r.push('{"type":"remove"}\n{"type":');
  torn.r.end();
  assert.equal(torn.got.length, 1);
  assert.equal(torn.errors[0].code, 'torn');
  const log = lines({ trailing: true, offset: 100 });
  log.r.push('a\nlast');
  log.r.end();
  assert.deepEqual(log.got.at(-1), { text: 'last', offset: 102, next: 106 }, 'next is the file’s size, with no \\n');
});

test('the message reader reports bad JSON and refused messages, never throws, and reads on', () => {
  const got = [];
  const errors = [];
  const r = createMessageReader('postbox-to-daemon', { onMessage: (m) => got.push(m), onError: (e) => errors.push(e) });
  assert.doesNotThrow(() => r.push('not json\n{"type":"launch"}\n{"type":"stop","turn":"t1"}\n'));
  assert.deepEqual(got, [{ type: 'stop', turn: 't1' }]);
  assert.deepEqual(
    errors.map((e) => e.code),
    ['bad-json', 'bad-message'],
  );
  assert.equal(errors[1].offset, 9);
});

test('encode refuses a message over the line limit, and utf8Bytes counts as TextEncoder does', () => {
  assert.throws(() => encode({ type: 'reply', id: 'x', ok: true, text: 'x'.repeat(REMOTE_LIMITS.lineBytes) }), { name: 'RangeError' });
  for (const s of ['', 'abc', 'héllo', '日本', '👋🏽', '\ud800x', 'a\udc00']) assert.equal(utf8Bytes(s), new TextEncoder().encode(s).length, JSON.stringify(s));
});
