// A reply still being written, as another agent reads it (designs/architecture/live-progress.md, “What reads the store
// while a turn runs”): a running turn’s words are stored in windows, so another agent’s catch-up, read_message and
// read_conversation give them to the last window, and the line says the reply isn’t done and how to read all of it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './blocks-fixture.mjs';
import { readOf } from './turn-parts.mjs';

/** Waits for `done`, a bound of 2 s. @param {() => unknown} done */
async function until(done) {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(done(), 'it happened within 2 s');
}

test('another agent reads a reply still being written as not done, and reads all of it once it is', async () => {
  const { store, rt, adapter, t } = setup();
  const other = rt.createPersona({ handle: 'researcher' });
  rt.ensureSession(t.id, other.id);
  const researcher = arrange.sessionsIn(rt, t.id).find((x) => x.handle === 'researcher');
  /** @type {() => void} */
  let finish = () => {};
  adapter.next.push(async (/** @type {any} */ c) => {
    c.text('The first half of my report. ');
    await new Promise((r) => {
      finish = () => r(undefined);
    });
    c.text('The second half.');
  });
  rt.sendMessage(t.id, { text: '@critic write the report' });
  const reply = () => store.items(t.id).find((/** @type {any} */ i) => i.kind === 'agent' && i.handle === 'critic');
  await until(() => reply()?.text);
  const id = reply().id;
  assert.equal(reply().status, 'streaming');
  const writing = new RegExp(
    `^@critic \\(still writing this reply: .*read_message \\{ id: "${id}" \\} reads all of it once it’s done\\): The first half of my report\\.`,
  );

  const read = arrange.readMessage(rt, researcher, { id });
  assert.ok(read.ok, read.message);
  assert.match(read.message, writing);
  assert.match(arrange.readConversation(rt, researcher, {}), new RegExp(`\\[${id}\\] ${writing.source.slice(1)}`));

  // The researcher’s turn, while the critic still writes: its catch-up says so too.
  adapter.next.push(async (/** @type {any} */ c) => c.text('ok'));
  rt.sendMessage(t.id, { text: '@researcher what has critic said?' });
  await until(() => adapter.calls.length === 2);
  const sent = readOf(adapter.calls[1]);
  assert.ok(sent.includes('still writing this reply') && sent.includes('The first half of my report.'), sent);

  finish();
  await settle(rt);
  const done = arrange.readMessage(rt, researcher, { id });
  assert.equal(done.message, '@critic: The first half of my report. The second half.');
});
