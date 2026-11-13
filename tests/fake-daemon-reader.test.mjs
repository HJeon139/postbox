// The fake daemon reader’s next() looks once more at its deadline, after the event loop has read what the stream holds:
// a message that comes as the deadline passes, as when a busy gate stalls the process, is still found.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { encode, message } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon-reader.mjs';

const started = () => encode(message('daemon-to-postbox', 'started', { turn: 't_1' }));

test('next finds a message that comes in the same turn of the event loop as its deadline', async () => {
  const stream = new PassThrough();
  const msgs = readMessages(stream);
  const waiting = msgs.next('started', 1);
  // The write is queued just after next()’s deadline, with the same delay. Node runs the timers that are due in one
  // phase, in the order they were queued, so once both are due the deadline fires and the message comes right after.
  setTimeout(() => stream.write(started()), 1);
  // Holds the event loop until both are due, however slow the machine: the next turn runs them together.
  for (const end = Date.now() + 5; Date.now() < end; );
  assert.deepEqual(await waiting, { type: 'started', turn: 't_1' });
});

test('next still rejects, naming what came, when the message never comes', async () => {
  const stream = new PassThrough();
  const msgs = readMessages(stream);
  stream.write(started());
  await assert.rejects(msgs.next('ended', 20), /No ended from the fake daemon within 20 ms; it sent started\./);
});
