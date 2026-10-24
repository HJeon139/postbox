// A headless Chrome check of what Stop, the agent’s panel, the `!` hint and the persona sheet say of a host (#120,
// the plan’s L6), with axe at 1280 and 375 px:
// - Stop says beforehand that the host’s background jobs stop with the turn, never offers to keep them, and a job’s
//   own Stop isn’t offered; the agent’s panel says where it runs, and its Stop says what stops with it;
// - the composer’s `!` hint says it runs on this computer, not on the host;
// - the persona sheet’s Runs on offers this computer or a host, only a host for a backend not on this computer, says
//   what the host’s daemon found, and shows the server’s refusal; Codex’s `auto` reads as Codex’s default;
// - at 375 px the states, cards, notes and the sheet fit.
// The agents list, the rings and the transcript’s turn states are tools/check-remote-turns.mjs.
//
//   node tools/check-remote-stop.mjs
//
// It starts its own Postbox with a fake host manager and the seeded states, as tools/remote-turns-kit.mjs sets them
// up. PB_PORT and PB_CHROME_PORT move it (4600 and 9800 by default).

import assert from 'node:assert/strict';
import { A, B, coder, cx, dm, room, root, rt, runner, solo, store } from './remote-turns-kit.mjs';
import { axe, check, click, end, go, overflow, page, q, settle, text, until } from './remote-turns-page.mjs';

await check('#120 Stop says first that the host’s background jobs stop with the turn, keeps none, and a job has no Stop of its own', async () => {
  await go(dm.id);
  rt.sendMessage(dm.id, { text: 'Run the job, please.' });
  await page.waitFor(`!!${q('.bg-jobs li')}`, { label: 'the background job row' });
  assert.equal(await text(q('.bg-jobs li')), 'Background job · Run the whole test suite A job on a host stops with its turn. Stop @runner to stop it.');
  assert.equal(await page.evaluate(`!!${q('.bg-jobs li button')}`), false, 'no Stop of its own');
  await page.waitFor(`!!${q('.stop-note')}`, { label: 'the note before Stop' });
  const note = 'Stop also stops @runner’s background job on host.example.com: a job on a host stops with its turn.';
  assert.equal(await text(q('.stop-note')), note);
  assert.equal(await page.evaluate(`document.getElementById(${q('.composer .btn.stop')}.getAttribute('aria-describedby'))?.textContent`), note);
  // A job’s own Stop on a remote turn is refused by the runtime too, in the same words.
  await assert.rejects(rt.stopJob(runner.id, 'bgjob1'), /A job on a host stops with its turn/);
  assert.deepEqual(await axe(), [], 'axe, with the note and the job row');
  await click(q('.composer .btn.stop'));
  await until(() => !rt.turns.has(runner.id), 'the turn to stop');
  assert.equal(await page.evaluate(`!!${q('.stop-ask')}`), false, 'it never asks whether to keep the jobs');
  assert.equal(store.state.sessions[runner.id].stopAsk ?? null, null);
});

await check('#120 the agent’s panel says where it runs, and its Stop says what stops with it', async () => {
  rt.sendMessage(dm.id, { text: 'Run the job again.' });
  await page.waitFor(`!!${q('.bg-jobs li')}`, { label: 'the job row' });
  await click(q('.agent-row .agent-btn'));
  await page.waitFor(`!!${q('.qp-stop-note')}`, { label: 'the panel’s note' });
  assert.match(await text(q('.qp-host')), /^On host\.example\.com · Connected · last heard from 2 min ago$/);
  assert.match(await text(q('.qp-stop-note')), /a job on a host stops with its turn\.$/);
  assert.deepEqual(await axe(), [], 'axe, with the panel open');
  await click(`[...document.querySelectorAll('.qp-actions button')].find((b) => b.textContent === 'Stop')`);
  await until(() => !rt.turns.has(runner.id), 'the turn to stop');
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await settle();
});

await check('#120 the ! hint says it runs on this computer, in the project’s folder, not on the host', async () => {
  await go(dm.id);
  await page.evaluate(
    `(() => { const ta = ${q('#composer-input')}; ta.focus(); ta.value = '!ls'; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await settle();
  assert.equal(
    await text(q('[data-mode="shell"]')),
    `Runs in ${root} on this computer, not on host.example.com, as you, with Enter. The agents read it and its output on their next turn.`,
  );
  await page.evaluate(`(() => { const ta = ${q('#composer-input')}; ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
});

await check('#120 the persona sheet’s Runs on: this computer or a host, and Codex only on a host, with what the daemon found', async () => {
  await go(solo.id);
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${JSON.stringify(coder.id)}))`);
  await page.waitFor(`!!${q('#pe-where')}`, { label: 'Runs on' });
  const opts = () => page.evaluate(`[...${q('#pe-where')}.options].map((o) => [o.textContent, o.disabled, o.selected])`);
  assert.deepEqual(await opts(), [
    ['This computer', false, false],
    ['host.example.com', false, true],
    ['build.example.com', false, false],
    ['gpu.example.com', false, false],
  ]);
  assert.match(await text(q('#pe-where-help')), /^Its turns run on host\.example\.com, over your own ssh; Postbox and its tools stay on this computer\.$/);
  assert.equal(await page.evaluate(`${q('label[for="pe-b"]')}.textContent`), 'Backend');
  // Codex isn’t on this computer: only a host, and the model reads as Codex’s default.
  await page.evaluate(
    `import('/app/js/sheets.mjs').then((m) => { document.querySelector('.dialog .x, .dialog [aria-label="Close"]')?.click(); m.openSettings('personas', ${JSON.stringify(cx.id)}); })`,
  );
  await page.waitFor(`${q('#pe-b')}?.value === 'codex'`, { label: 'Codex’s sheet' });
  assert.deepEqual((await opts())[0], ['This computer (Codex isn’t here)', true, false]);
  assert.equal(await page.evaluate(`${q('#pe-b')}.selectedOptions[0].textContent`), 'Codex (on a host only)');
  assert.equal(await page.evaluate(`${q('#pe-m')}.value`), 'auto');
  assert.match(await text(`${q('#pe-m')}.closest('.field')`), /auto is Codex’s default/);
  assert.deepEqual(await axe(), [], 'axe, on the persona sheet');
  // On a host whose daemon didn’t find Codex: said before saving, and the server’s refusal shows under Runs on.
  await page.evaluate(`(() => { const s = ${q('#pe-where')}; s.value = ${JSON.stringify(A.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await settle();
  assert.match(
    await text(`${q('#pe-where')}.closest('.field').querySelector('.err')`),
    /^Codex wasn’t found on host\.example\.com: Postbox’s daemon looked in \/home\/user\/\.local\/bin, \/usr\/local\/bin\. Install it there, or set its path in the host’s settings\.$/,
  );
  await click(`[...document.querySelectorAll('.dialog button.send')].find((b) => b.textContent === 'Save')`);
  await page.waitFor(`!!${q('#pe-where-err')}`, { label: 'the server’s refusal' });
  assert.match(await text(q('#pe-where-err')), /^Codex isn’t installed on host\.example\.com, so this agent can’t run there\./);
  assert.equal(await page.evaluate(`document.activeElement?.id`), 'pe-where', 'focus on Runs on');
  assert.equal(rt.persona(cx.id).remote.hostId, B.id, 'unchanged');
});

await check('#120 at 375 px the states, cards, notes and the sheet fit, and axe finds no violations', async () => {
  await page.size(375, 800);
  await settle();
  // Within the sheet, and the sheet within the window: its tabs row wraps at 375 px.
  const spill = await page.evaluate(
    `(() => { const d = document.querySelector('.dialog').getBoundingClientRect(); const f = document.querySelector('#pe-where').closest('.field'); return [f, ...f.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().right > d.right + 1).map((n) => n.className || n.tagName).concat(d.right > innerWidth + 1 ? ['the sheet'] : []); })()`,
  );
  assert.deepEqual(spill, []);
  assert.deepEqual(await axe(), [], 'axe, on the persona sheet');
  await page.evaluate(`document.querySelector('.dialog [aria-label="Close"]')?.click()`);
  await go(room.id);
  assert.deepEqual(await overflow('.host-callout, .host-callout button, .host-notice, .stopped-tag, .host-turn, .block.answered, .cmd-where'), []);
  assert.deepEqual(await axe(), [], 'axe, in the room');
  await go(dm.id);
  rt.sendMessage(dm.id, { text: 'Run the job once more.' });
  await page.waitFor(`!!${q('.stop-note')} && !!${q('.bg-jobs li')}`, { label: 'the note and the job row' });
  assert.deepEqual(await overflow('.stop-note, .bg-jobs li, .job-host'), []);
  assert.deepEqual(await axe(), [], 'axe, with the note');
  rt.stop(runner.id);
  await until(() => !rt.turns.has(runner.id), 'the turn to stop');
});

await end();
