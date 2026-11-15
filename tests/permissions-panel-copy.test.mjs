// What the permissions panel says when it refuses a folder or a rule (#548): plain words, “this computer” and “this
// conversation”, never the runtime’s own name. A move of server code that turned `this` into `rt` once rewrote them.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './side-threads-fixture.mjs';

/** The message a call refused with. @param {Promise<any>} p */
const refusal = (p) =>
  p.then(
    () => assert.fail('it was refused'),
    (/** @type {any} */ e) => e.message,
  );

test('#548: Add folder refuses a folder that isn’t there in words the person reads', async () => {
  const f = setup();
  const said = await refusal(f.rt.changePermissionFolder({ sessionId: f.alpha.id, path: '/no/such/folder/pb-548' }));
  assert.equal(said, '/no/such/folder/pb-548 isn’t a folder on this computer.');
});

test('#548: saving a rule says where it can go, in words the person reads', async () => {
  const f = setup();
  const rule = { sessionId: f.alpha.id, behavior: 'allow', rule: 'Bash(npm test:*)' };
  assert.match(await refusal(f.rt.changePermissionRule({ ...rule, where: 'project' })), /Save the rule in this folder’s local settings, or edit/);
  assert.equal(
    await refusal(f.rt.changePermissionRule({ ...rule, where: 'elsewhere' })),
    'A rule is saved in this folder’s local settings, your user settings or this conversation.',
  );
});

test('#548: no text in server/ says “rt” where it means “this”', async () => {
  const dir = new URL('../server', import.meta.url).pathname;
  const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  // `rt` before a noun reads as the runtime’s name in a sentence: “on rt computer”, “rt conversation’s agent”.
  const word = /\brt (computer|conversation|folder|session|agent|person|thread|turn|one)\b/;
  const found = [];
  for (const f of files) {
    const lines = (await readFile(join(dir, f), 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) if (word.test(line)) found.push(`server/${f}:${i + 1}`);
  }
  assert.deepEqual(found, []);
});
