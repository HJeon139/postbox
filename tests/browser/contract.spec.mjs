// The agent contract, in a real browser and a real sandboxed app frame:
// - #50: postbox.send with values over the event limit rejects inside the app, naming the limit, and nothing reaches
//   the conversation; the same hand-off by id goes through.
// - #94: update_block with outcome on an answered confirm shows the result as a Markdown line under the answer, and the
//   block stays answered, with no needs-you.
// - #109: asked to review another agent’s 5,000-character reply, @critic quotes its last paragraph: its history cut the
//   reply and gave its id, and read_message gave it the rest.
// - #153: asked to review the draft @researcher showed in a review block, @critic quotes how the draft ends.
// On the demo’s mock agents, each case in a conversation of its own. Moved from tools/check-contract.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

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

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('contract');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A conversation of its own with these demo agents, open in the page. */
async function conversation(page, title, handles) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: handles.map((h) => rt.personaByHandle(h).id) });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const sessionOf = (handle) => rt.sessionsIn(t.id).find((x) => x.handle === handle);
  return { t, sessionOf };
}

test('#50 a send over the event limit rejects inside the app, naming the limit and saying to send ids, and only the hand-off by id goes through', async ({
  page,
}) => {
  const { rt, store } = app;
  const { t, sessionOf } = await conversation(page, 'Hand-off', ['librarian']);
  const id = `handoff-${t.id}`;
  rt.toolsFor(sessionOf('librarian').id).show_app({ id, title: 'Hand-off', code: HANDOFF, permissions: [] });
  await expect.poll(() => rt.s.apps[id]?.check.status, { message: 'the app to pass its check' }).toMatch(/^(passed|note)$/);
  const frame = page.locator('iframe.app-iframe[title="Hand-off"]');
  await expect(frame).toHaveAttribute('data-sized', '1');
  // A frame takes no pointer events until the page sees the pointer over it (#38).
  await frame.scrollIntoViewIfNeeded();
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 50);
  await expect(frame).toHaveClass(/\blive\b/);
  await page.frameLocator('iframe.app-iframe[title="Hand-off"]').locator('#go').click();
  await expect.poll(() => rt.s.apps[id].state?.ids, { message: 'the app to record what its sends returned' }).toBeTruthy();
  const st = rt.s.apps[id].state;
  expect(st.full, 'it rejects inside the app, naming the limit').toMatch(
    /^refused: postbox\.send: .*larger than the 64 KB one event can carry, so nothing was sent/,
  );
  expect(st.full, 'and says to send ids instead').toMatch(/Send ids instead/);
  expect(st.ids, 'the same hand-off by id goes through').toBe('sent');
  const sent = store.items(t.id).filter((x) => x.kind === 'voice' && x.appId === id);
  expect(
    sent.map((x) => x.quote),
    'only the hand-off by id reaches the conversation',
  ).toEqual(['Sent 1,258 pair ids']);
  expect(sent[0].text).toMatch(/^Sent from Hand-off: \S+ · \w+: 1,258 items · \d+ KB$/);
});

test('#94 an outcome on an answered confirm shows as a Markdown line under the answer, and the block stays answered, with no needs-you', async ({ page }) => {
  const { rt, store } = app;
  const { t, sessionOf } = await conversation(page, 'Outcome', ['librarian']);
  const se = sessionOf('librarian');
  const tools = rt.toolsFor(se.id);
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
  const node = page.locator(`[data-block-item="${item.id}"]`);
  await expect(node).toBeVisible();
  rt.act(t.id, item.id, 'confirm', {});
  await expect(node.locator('.answered-note')).toBeVisible();
  // An outcome reports on an answer the agent has read (#123): wait for its event to start a turn, as the agent would.
  await expect.poll(() => !!store.item(t.id, item.id)?.answer?.read, { message: 'the answer to reach the agent' }).toBe(true);
  const said = tools.update_block({ block: { ...confirm, outcome: 'Done: **23 frames** deleted, `frames/` is empty' } });
  expect(said.ok, said.message).toBe(true);
  const out = node.locator('.outcome');
  await expect(out).toBeVisible();
  expect(
    await node.evaluate(
      (n) =>
        !!(
          /** @type {Element} */ (
            n.querySelector('.answered-note').compareDocumentPosition(/** @type {Element} */ (n.querySelector('.outcome'))) & Node.DOCUMENT_POSITION_FOLLOWING
          )
        ),
    ),
    'under the person’s answer',
  ).toBe(true);
  await expect(out.locator('strong'), 'rendered as Markdown').toHaveText('23 frames');
  await expect(out.locator('code')).toHaveText('frames/');
  await expect(out.locator('.i-check'), 'with a check').toHaveCount(1);
  await expect(node).toHaveClass(/\banswered\b/);
  await expect(node.locator('button'), 'no buttons to press again').toHaveCount(0);
  await expect(node.locator('.title'), 'the question the person answered stays as they saw it').toHaveText('Delete the video frames?');
  expect(rt.s.sessions[se.id].needs, 'the agent doesn’t need the person').toBeFalsy();
  await expect(node.locator('.g-needs'), 'no needs-you mark').toHaveCount(0);
});

test('#109 asked to review another agent’s reply of over 5,000 characters, @critic quotes its last paragraph, past the cut', async ({ page }) => {
  const { rt, store } = app;
  const { t, sessionOf } = await conversation(page, 'Reading', ['researcher', 'critic']);
  const LAST = 'Last, the conclusion holds only for adults over 60.';
  const long = `${Array.from({ length: 24 }, (_, i) => `Finding ${i + 1}: the claim in section ${i + 1} rests on one study, and its sample is small. `.repeat(3)).join('\n\n')}\n\n${LAST}`;
  expect(long.length > 5000 && long.indexOf(LAST) > 2000, 'its last paragraph is past the cut').toBe(true);
  rt.addItem(t.id, { kind: 'agent', sessionId: sessionOf('researcher').id, handle: 'researcher', text: long, status: 'done' });
  rt.sendMessage(t.id, { text: '@critic review what researcher wrote' });
  // What @critic said, as the server has it: the case is about what it read, not how the page draws it.
  const replied = () => store.items(t.id).find((x) => x.kind === 'agent' && x.handle === 'critic' && x.status === 'done')?.text;
  await expect.poll(replied, { message: '@critic to reply' }).toBeTruthy();
  expect(replied(), '@critic quotes the last paragraph').toContain(LAST);
});

test('#153 asked to review the draft @researcher showed in a review block, @critic quotes how the draft ends', async ({ page }) => {
  const { rt, store } = app;
  const { t, sessionOf } = await conversation(page, 'Draft', ['researcher', 'critic']);
  const END = 'Risk: two editions with different page breaks hash apart, so compare their text, not their pages.';
  const draft = `# Dedup plan\n\n${Array.from({ length: 30 }, (_, i) => `${i + 1}. Hash passage group ${i + 1} by its normalized text, and keep the earliest edition.`).join('\n')}\n\n${END}`;
  const shown = rt.toolsFor(sessionOf('researcher').id).show_block({
    block: { id: 'dedup-plan', type: 'review', version: 1, title: 'Dedup plan', format: 'markdown', content: draft, fallback: 'The dedup plan.' },
  });
  expect(shown.ok && draft.indexOf(END) > 2000, 'the draft is a review block, and how it ends is past the cut').toBe(true);
  rt.sendMessage(t.id, { text: '@critic review the draft researcher showed' });
  const replied = () => store.items(t.id).find((x) => x.kind === 'agent' && x.handle === 'critic' && x.status === 'done')?.text;
  await expect.poll(replied, { message: '@critic to reply about the draft' }).toBeTruthy();
  expect(replied(), '@critic quotes how the draft ends').toContain(END);
});
