// #1896, #623's rule (a read that decides a write reads the session as written, held writes included): Allow once on a
// denial card adds its rule to the session's allowOnce, for the agent's next turn. While a turn runs, both answers wait
// for that next turn; two answered behind one held commit each keep their rule, where building the list from the
// published session let the second drop the first.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDenial } from '../server/permission-cards.mjs';
import * as arrange from './arrange.mjs';
import { heldStore, setup, until } from './stop-reply-fixture.mjs';

test('#1896 two refusals allowed once behind one held commit each keep their rule for the next turn', async () => {
  const h = await heldStore();
  // A turn that runs until the test lets it end, so the answers' notes wait for the next one, and so do their rules.
  let end = () => {};
  const { rt, t, se } = await setup(
    () =>
      new Promise((r) => {
        end = () => r(undefined);
      }),
    h.store,
  );
  rt.sendMessage(t.id, { text: 'Run the checks.' });
  await until(() => Boolean(rt.turns.get(se.id)), 'the turn to run');
  const denial = (/** @type {string} */ command) =>
    arrange.post(rt, t.id, {
      kind: 'denial',
      sessionId: se.id,
      handle: se.handle,
      turnId: 'turn_last',
      summary: `run ${command}`,
      status: 'open',
      rules: { once: `Bash(${command})`, always: `Bash(${command})`, alwaysWords: command, why: null },
    });
  const first = denial('npm test');
  const second = denial('npm run lint');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  await resolveDenial(rt, t.id, first.id, 'once'); // its allowOnce write is held behind the commit
  await resolveDenial(rt, t.id, second.id, 'once');
  h.release();
  await commit;
  await h.store.flush();
  assert.deepEqual(rt.s.sessions[se.id].allowOnce, ['Bash(npm test)', 'Bash(npm run lint)'], 'both rules kept for the next turn');
  // The turn waits for its stop once its step resolves (Scripted.deliver): stop it, so nothing runs as the store closes.
  end();
  rt.stop(se.id);
  await until(() => !rt.turns.get(se.id), 'the turn to end');
  await h.store.close();
});
