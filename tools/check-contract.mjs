// A headless Chrome check of the agent contract, in a real browser and a real sandboxed app frame:
//   #50: postbox.send with values over the event limit rejects inside the app, naming the limit, and nothing
//        reaches the conversation; the same hand-off by id goes through.
//   #94: update_block with outcome on an answered confirm shows the result as a Markdown line under the answer,
//        and the block stays answered, with no needs-you.
//   #109: asked to review another agent’s 5,000-character reply, @critic quotes its last paragraph: its history
//        cut the reply and gave its id, and read_message gave it the rest.
//   #153: asked to review the draft @researcher showed in a review block, @critic quotes how the draft ends.
//
//   node tools/check-contract.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (4420 and 9620 by default), so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4420, 9620);

// One click tries a hand-off of 1,258 pairs with their text (too large), then the same pairs by id.
const HANDOFF = `<main style="padding:12px"><button id="go" class="btn" type="button" style="display:block;width:100%;height:96px">Send all pairs</button><p id="out">Ready</p></main>
<script>
const pairs = Array.from({ length: 1258 }, (_, i) => ({ id: 'p' + i, claim: 'A claim about a protein and a disease, with its abstract. '.repeat(2) }));
document.getElementById('go').addEventListener('click', async () => {
  const st = {};
  try { await postbox.send('pairs', { pairs }, 'Sent 1,258 pairs'); st.full = 'sent'; } catch (e) { st.full = 'refused: ' + e.message; }
  try { const r = await postbox.send('pair-ids', { ids: pairs.map((p) => p.id) }, 'Sent 1,258 pair ids'); st.ids = r.held ? 'held' : 'sent'; } catch (e) { st.ids = 'refused: ' + e.message; }
  document.getElementById('out').textContent = st.full;
  postbox.saveState(st);
});
</script>`;

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-contract-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
let page = null;
const until = async (fn, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

try {
  const { rt, store } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Contract check', personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  const tools = rt.toolsFor(se.id);
  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'light' });
  await page.goto(`${app.origin}/#/t/${t.id}`);

  // ── #50: a hand-off over the event limit ──────────────────────────────────────────────
  const frame = `[...document.querySelectorAll('iframe.app-iframe')].find((f) => f.title === 'Hand-off')`;
  tools.show_app({ id: 'handoff', title: 'Hand-off', code: HANDOFF, permissions: [] });
  await until(() => ['passed', 'note'].includes(rt.s.apps.handoff?.check.status), 'the app to pass its check');
  await until(() => page.evaluate(`!!${frame}?.dataset.sized`), 'the app to load');
  const at = await page.evaluate(
    `(() => { const f = ${frame}; f.scrollIntoView({ block: 'center' }); const b = f.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 50 }; })()`,
  );
  await sleep(200);
  // A pointer rests on what it clicks for a moment, as a hand does; an app frame needs it to see you point (#38).
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await sleep(100);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await until(() => rt.s.apps.handoff.state?.ids, 'the app to record what its sends returned');
  const st = rt.s.apps.handoff.state;
  const sent = store.items(t.id).filter((x) => x.kind === 'voice' && x.appId === 'handoff');
  check(
    /^refused: postbox\.send: .*larger than the 64 KB one event can carry, so nothing was sent/.test(st.full),
    'a send over 64 KB rejects inside the app, naming the limit',
    st.full,
  );
  check(/Send ids instead/.test(st.full), 'the error says to send ids instead', st.full);
  check(st.ids === 'sent', 'the same hand-off by id goes through', st.ids);
  check(
    sent.length === 1 && sent[0].quote === 'Sent 1,258 pair ids' && /^Sent from Hand-off: \S+ · \w+: 1,258 items · \d+ KB$/.test(sent[0].text),
    'only the hand-off by id reaches the conversation',
    JSON.stringify(sent.map((x) => [x.text, x.quote])),
  );

  // ── #94: a result reported on an answered confirm ─────────────────────────────────────
  const confirm = {
    id: 'frames',
    type: 'confirm',
    version: 1,
    fallback: 'Delete the frames?',
    title: 'Delete the video frames?',
    statement: 'Delete the **23** untracked frames?',
    confirmLabel: 'Delete',
  };
  tools.show_block({ block: confirm });
  const item = store.items(t.id).find((x) => x.kind === 'block' && x.block.id === 'frames');
  const node = `document.querySelector('[data-block-item="${item.id}"]')`;
  await until(() => page.evaluate(`!!${node}`), 'the confirm to show');
  rt.act(t.id, item.id, 'confirm', {});
  await until(() => page.evaluate(`!!${node}?.querySelector('.answered-note')`), 'the answer to show');
  // An outcome reports on an answer the agent has read (#123): wait for its event to start a turn, as the agent
  // would. On a busy computer the agent is still in its last turn, and the event waits in its queue.
  await until(() => store.item(t.id, item.id)?.answer?.read, 'the answer to reach the agent');
  const said = tools.update_block({ block: { ...confirm, outcome: 'Done: **23 frames** deleted, `frames/` is empty' } });
  await until(() => page.evaluate(`!!${node}?.querySelector('.outcome')`), 'the outcome to show').catch(() => {});
  const shown = await page.evaluate(`(() => {
    const n = ${node};
    const note = n.querySelector('.answered-note');
    const out = n.querySelector('.outcome');
    return {
      answered: n.classList.contains('answered'),
      buttons: n.querySelectorAll('button').length,
      after: !!out && !!note && !!(note.compareDocumentPosition(out) & Node.DOCUMENT_POSITION_FOLLOWING),
      text: out?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      bold: out?.querySelector('strong')?.textContent ?? '',
      code: out?.querySelector('code')?.textContent ?? '',
      icon: !!out?.querySelector('.i-check'),
      title: n.querySelector('.title')?.textContent ?? '',
    };
  })()`);
  check(said.ok && shown.after, 'the outcome shows as a line under the person’s answer', JSON.stringify({ said, shown }));
  check(shown.bold === '23 frames' && shown.code === 'frames/' && shown.icon, 'the outcome renders as Markdown, with a check', JSON.stringify(shown));
  check(shown.answered && shown.buttons === 0, 'the block stays answered, with no buttons to press again', JSON.stringify(shown));
  check(shown.title === 'Delete the video frames?', 'the question the person answered stays as they saw it', shown.title);
  check(!rt.s.sessions[se.id].needs, 'the agent doesn’t need the person', JSON.stringify(rt.s.sessions[se.id].needs));
  const needsGlyph = await page.evaluate(`!!${node}.querySelector('.g-needs')`);
  check(!needsGlyph, 'the block shows no needs-you mark');

  // ── #109: a reviewer reads another agent’s long reply in full ─────────────────────────
  const room = rt.createThread({ projectId, title: 'Reading check', personaIds: ['researcher', 'critic'].map((h) => rt.personaByHandle(h).id) });
  const researcher = rt.sessionsIn(room.id).find((x) => x.handle === 'researcher');
  const LAST = 'Last, the conclusion holds only for adults over 60.';
  const long = `${Array.from({ length: 24 }, (_, i) => `Finding ${i + 1}: the claim in section ${i + 1} rests on one study, and its sample is small. `.repeat(3)).join('\n\n')}\n\n${LAST}`;
  rt.addItem(room.id, { kind: 'agent', sessionId: researcher.id, handle: 'researcher', text: long, status: 'done' });
  // A conversation made a moment ago must have reached the page first: one it hasn’t heard of opens the overview.
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${room.id}'`);
  rt.sendMessage(room.id, { text: '@critic review what researcher wrote' });
  const replied = () => store.items(room.id).find((x) => x.kind === 'agent' && x.handle === 'critic' && x.status === 'done');
  await until(replied, '@critic to reply');
  // What @critic said, as the server has it: the case is about what it read, not how the page draws it.
  const said109 = replied().text ?? '';
  check(long.length > 5000 && long.indexOf(LAST) > 2000, 'the reply is over 5,000 characters, and its last paragraph is past the cut', String(long.length));
  check(said109.includes(LAST), '@critic quotes the last paragraph of the reply, which its history cut', said109);

  // ── #153: a reviewer reads the draft another agent showed in a review block ────────────
  const room2 = rt.createThread({ projectId, title: 'Draft check', personaIds: ['researcher', 'critic'].map((h) => rt.personaByHandle(h).id) });
  const author = rt.sessionsIn(room2.id).find((x) => x.handle === 'researcher');
  const END = 'Risk: two editions with different page breaks hash apart, so compare their text, not their pages.';
  const draft = `# Dedup plan\n\n${Array.from({ length: 30 }, (_, i) => `${i + 1}. Hash passage group ${i + 1} by its normalized text, and keep the earliest edition.`).join('\n')}\n\n${END}`;
  const shownPlan = rt.toolsFor(author.id).show_block({
    block: { id: 'dedup-plan', type: 'review', version: 1, title: 'Dedup plan', format: 'markdown', content: draft, fallback: 'The dedup plan.' },
  });
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${room2.id}'`);
  rt.sendMessage(room2.id, { text: '@critic review the draft researcher showed' });
  const replied2 = () => store.items(room2.id).find((x) => x.kind === 'agent' && x.handle === 'critic' && x.status === 'done');
  await until(replied2, '@critic to reply about the draft');
  const said153 = replied2().text ?? '';
  check(shownPlan.ok && draft.indexOf(END) > 2000, 'the draft is shown as a review block, and how it ends is past the cut', JSON.stringify(shownPlan));
  check(said153.includes(END), '@critic quotes how the draft in the review block ends', said153);
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
