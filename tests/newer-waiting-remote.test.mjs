// #694 on a host: the note reaches a host turn on the next tool reply the agent waits for (server/remote/turns-tools.mjs),
// never on a queued call’s reply, and only the turn that made the call. The rig is tests/remote-turns-helpers.mjs; the
// laptop’s cases are in tests/newer-waiting.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig, running, settled, starts, until } from './remote-turns-helpers.mjs';
import { sleep } from './side-threads-fixture.mjs';

const PERSON = '[Postbox] A newer message from the person is waiting for you; it reaches you when this turn ends, unless it’s removed.';

test('#694: on a host too, the person’s newer queued message is named on the next tool reply the agent waits for', async () => {
  const r = rig();
  const turn = await running(r);
  r.rt.sendMessage(r.t.id, { text: 'actually, the other one' });
  r.d.tool(turn, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.length === 1, 'the search’s reply');
  assert.match(
    r.d.replies[0].text,
    /^\[Postbox\] A newer message from the person is waiting for you; it reaches you when this turn ends, unless it’s removed\.\n\n/,
  );
  r.d.end(turn);
  // The queued message then starts the next turn, which the fake daemon ends too.
  await until(() => starts(r.d).length === 2, 'the queued message’s turn');
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
});

test('#694: on a host, a slow tool call of a turn Send now replaced names nothing; the turn now running hears it', async () => {
  const r = rig();
  const turn = await running(r);
  let open = () => {};
  const gate = new Promise((ok) => {
    open = () => ok(undefined);
  });
  const toolsFor = r.rt.toolsFor.bind(r.rt);
  r.rt.toolsFor = (...a) => {
    const tools = toolsFor(...a);
    return {
      ...tools,
      corpus_search: async (...b) => {
        await gate;
        return tools.corpus_search(...b);
      },
    };
  };
  // corpus_search is a call the agent waits for; a queued one, such as define_term, never gets the note on a host.
  r.d.tool(turn, 'corpus_search', { query: 'whales' });
  await sleep(20);
  r.rt.sendMessage(r.t.id, { text: 'change of course', sendNow: true });
  r.d.end(turn);
  await until(() => starts(r.d).length === 2 && r.rt.turns.size === 1, 'the next turn to start');
  const next = starts(r.d)[1].turn;
  r.rt.sendMessage(r.t.id, { text: 'and also this' });
  open();
  await sleep(20);
  const stale = r.d.replies.find((x) => x.turn === turn);
  assert.ok(stale, 'the stopped turn’s call is answered');
  assert.doesNotMatch(stale.text, /newer message/, 'and its reply names nothing');
  r.rt.toolsFor = toolsFor;
  r.d.tool(next, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.some((x) => x.turn === next), 'the next turn’s reply');
  assert.ok(r.d.replies.find((x) => x.turn === next).text.startsWith(PERSON), 'the running turn hears it');
  r.d.end(next);
  await until(() => starts(r.d).length === 3, 'the queued message’s turn');
  r.d.end(starts(r.d)[2].turn);
  await settled(r);
});

test('#694: on a host, a queued call’s reply, which the agent never reads, doesn’t use up the note', async () => {
  const r = rig();
  const turn = await running(r);
  r.rt.sendMessage(r.t.id, { text: 'actually, the other one' });
  r.d.tool(turn, 'define_term', { term: 'X', definition: 'A word.' });
  await until(() => r.d.replies.length === 1, 'the queued call’s reply');
  assert.doesNotMatch(r.d.replies[0].text, /newer message/);
  r.d.tool(turn, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.length === 2, 'the search’s reply');
  assert.ok(r.d.replies[1].text.startsWith(PERSON), 'the reply the agent waits for names it');
  r.d.end(turn);
  await until(() => starts(r.d).length === 2, 'the queued message’s turn');
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
});
