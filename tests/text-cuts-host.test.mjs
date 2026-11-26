// #1686, part 3: the last cuts of read text that could end inside a character. #1685 routed the host’s replies through
// cutText, but its call sites had no test of their own: a host call’s reply cut to replyChars, the reply kept for the
// daemon’s repeats (KEPT_REPLY_CHARS), and the refusal a queued call’s agent is told at its next turn. An app
// version’s summary is cut the same way. Each case puts an emoji across its site’s cut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { KEPT_REPLY_CHARS } from '../server/remote/turns-shared.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { REMOTE_LIMITS } from '../shared/remote-protocol.mjs';
import * as arrange from './arrange.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

const EMOJI = '😀';
const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s));
function whole(s, where) {
  assert.ok(typeof s === 'string' && s.length > 0, `${where} wasn’t found`);
  assert.equal(lone(s), false, `${where} ends inside a character`);
}
/** Text with an emoji starting at each index, so a cut to that index keeps half of it. @param {number[]} at @param {number} length */
function emojisAt(at, length) {
  let s = '';
  for (const i of at) s += `${'x'.repeat(i - s.length)}${EMOJI}`;
  return s + 'x'.repeat(Math.max(0, length - s.length));
}

test('#1686 a host call’s reply, the reply kept for its repeats, and the refusal its agent is told are cut whole', async () => {
  const r = rig();
  const turn = await running(r);
  // A queued call Postbox refuses with a reply long enough to be cut at each of the three places.
  // The refusal told to the agent keeps the reply’s first 1,000 characters, the kept reply its first KEPT_REPLY_CHARS.
  const long = emojisAt([1000 - 1, KEPT_REPLY_CHARS - 1, REMOTE_LIMITS.replyChars - 1], REMOTE_LIMITS.replyChars + 10);
  const toolsFor = r.rt.toolsFor.bind(r.rt);
  r.rt.toolsFor = (...a) => ({ ...toolsFor(...a), define_term: () => ({ ok: false, message: long }) });
  r.link.hear({ type: 'tool', turn, id: 'long', name: 'define_term', args: { term: 'x', definition: 'y' } });
  const reply = () => r.link.sent.find((m) => m.type === 'reply' && m.id === 'long');
  await until(reply, 'the call’s reply');
  assert.equal(reply().text.length, REMOTE_LIMITS.replyChars - 1, 'cut one short, before the emoji');
  whole(reply().text, 'the reply');
  const kept = r.store.state.sessions[r.se().id].remoteTurn?.replies?.find((x) => x.id === 'long');
  whole(kept?.text, 'the kept reply');
  // Told at the agent’s next turn, through its session’s context.
  whole(
    (r.store.state.sessions[r.se().id].context ?? []).find((c) => /define_term call from the host/.test(c)),
    'the told refusal',
  );
  r.d.end(turn);
  await settled(r);
});

test('#1686 an app version’s summary is cut whole', () => {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', async folderFor() {}, fork() {}, async deliver() {} }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'alpha' }).id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_app({ id: 'summed', title: 'S', code: '<p>1</p>' });
  assert.equal(tools.update_app({ id: 'summed', code: '<p>2</p>', summary: emojisAt([299], 320) }).ok, true);
  whole(store.state.apps.summed.versions[1].summary, 'the summary');
});
