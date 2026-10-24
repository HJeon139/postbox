// A headless Chrome check of Stop with background jobs (#126, #129), driven with real key presses and clicks:
// - a background job the agent started shows under its reply, running, with its own Stop;
// - Stop asks “@developer has 1 background job running. Stop it too?”, focus on its first choice, and Escape leaves
//   the agent running, with focus back on Stop;
// - Keep running stops the agent (it reads “stopping” until its process exits) and the job stays listed; its own Stop
//   then stops it;
// - a kept job Postbox couldn’t tell apart from another process (#164) says so under its row, and its Stop stops both;
// - Stop it too stops both; the ask’s colors are the tokens’, with amber only on its first choice; at 375 px it fits;
// - each stopped reply says why (#215, #249): “Stopped by you”, with its background work kept running after Keep
//   running, and “Interrupted by Send now” after a queued message’s Send now, whose job keeps running;
// - two kept jobs Postbox couldn’t tell apart share their processes (#167): stopping one ends the other as stopped.
//
//   node tools/check-stop.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a scripted Claude Code agent (no real
// turns or processes: the job’s process group is a fake). PB_PORT and PB_CHROME_PORT move it (5037 and 10237 by
// default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(5037, 10237);

process.env.POSTBOX_BACKENDS = 'mock';
const root = await mkdtemp(join(tmpdir(), 'pb-check-stop-'));
const app = await start({ port: PORT, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true, claudeHome: root });
const { rt, store } = app;
// The job’s process group: signals are recorded, nothing is sent.
const signals = [];
rt.signalProcess = (pid, sig) => {
  if (sig !== 0) signals.push([pid, sig]);
  return true;
};
// …and ps shows the kept job’s shell, so Postbox knows the group is still the job’s, and a foreground call’s (#164).
const PROCS = [
  { pid: 4242, ppid: 1, pgid: 4242, command: "/bin/zsh -c source snapshot.sh && eval 'node tools/uat-run.mjs' < /dev/null" },
  { pid: 4343, ppid: 1, pgid: 4343, command: "/bin/zsh -c source snapshot.sh && eval 'sleep 600' < /dev/null" },
];
rt.listProcesses = async () => PROCS;

// A Claude Code agent that starts a background job, then works until it’s stopped, and takes a moment to exit.
let n = 0;
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return root;
  },
  async deliver(_session, message, ctx) {
    if (!/job/.test(message.text ?? '')) return ctx.text('Done.');
    n += 1;
    // Asked for two, it starts a second job beside the first (#167).
    const jobs = [{ id: `bgjob${n}`, label: 'Run the mixed-room UAT scenario live', command: 'node tools/uat-run.mjs' }];
    if (/two jobs/.test(message.text ?? '')) jobs.push({ id: `bgjob${n}b`, label: 'Tail the UAT log', command: 'tail -f uat.log' });
    ctx.text('Starting the UAT run in the background.');
    for (const j of jobs) {
      ctx.activity({ id: `tu_${j.id}`, label: j.label, state: 'running', job: j.id });
      ctx.job({ id: j.id, toolUseId: `tu_${j.id}`, label: j.label, command: j.command, outputFile: '/tmp/out.txt', state: 'running' });
    }
    await new Promise((r) => ctx.signal.addEventListener('abort', r));
    // Asked to say it’s unsure, it keeps both shells, as for a job Postbox couldn’t tell apart (#164), for each job.
    const groups = /unsure/.test(message.text ?? '') ? PROCS.map((p) => ({ pgid: p.pgid, command: p.command })) : undefined;
    for (const { id } of jobs) ctx.job(ctx.signal.reason?.keepJobs?.length ? { id, kept: true, pgid: 4242, groups } : { id, state: 'stopped' });
    await new Promise((r) => setTimeout(r, 400));
  },
});
store.emit('project', { id: 'pr_stop', name: 'Stop', folder: root });
const dev = rt.createPersona({ handle: 'developer', backend: 'claude-code', permissionMode: 'auto' });
const room = rt.createThread({ projectId: 'pr_stop', title: 'Stop check', personaIds: [dev.id] });
const [se] = rt.sessionsIn(room.id);

const page = await launch({ port: CHROME_PORT });
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
const KEYS = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 } };
async function press(key) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = (expr) => page.evaluate(`(${expr})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const focused = () => page.evaluate('document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || ""');
const until = async (fn, label) => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const state = () => store.state.sessions[se.id].state;
// The last stopped reply’s tag, once the page has heard everything the server has said.
const lastTag = async () => {
  await page.synced(store.state.seq);
  return page.evaluate(`[...document.querySelectorAll('.stopped-tag')].at(-1)?.innerText ?? ''`);
};
const step = () =>
  store
    .items(room.id)
    .filter((i) => i.kind === 'agent' && i.activity?.steps?.length)
    .at(-1)?.activity.steps[0];

async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 30 s')), 30000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
  await page.send('Page.bringToFront');
}
async function startJob(text = 'Run the UAT job, please.') {
  rt.sendMessage(room.id, { text });
  await until(() => state() === 'tool' || state() === 'gen' || state() === 'think', 'the turn');
  await page.waitFor(`!!${q('.bg-jobs li')}`, { label: 'the background job row' });
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${room.id}`);
await page.waitFor(`!!${q('#composer-input')}`, { label: 'the composer' });

await check('#129 a background job shows under its reply, running, with its own Stop', async () => {
  await startJob();
  assert.match(await text(q('.bg-jobs li')), /^Background job · Run the mixed-room UAT scenario live Stop$/);
  assert.equal(await page.evaluate(`!!${q('.bg-jobs li button[aria-label^="Stop the background job"]')}`), true);
  // Calm: the glyph holds still, in the quiet color, not amber.
  const g = await page.evaluate(`(() => { const s = getComputedStyle(${q('.bg-jobs .g-running')}); return { anim: s.animationName, color: s.color }; })()`);
  assert.equal(g.anim, 'none');
  const dim = await page.evaluate(
    `(() => { const p = document.createElement('span'); p.style.color = 'var(--dim)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`,
  );
  assert.equal(g.color, dim);
});

await check('#129 Stop asks first, with focus on its first choice; Escape leaves the agent running, focus back on Stop', async () => {
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  assert.match(await text(q('.stop-ask')), /^@developer has 1 background job running\. Stop it too\? Stop it too Keep running$/);
  assert.equal(await focused(), 'Stop it too');
  assert.equal(rt.turns.has(se.id), true, 'nothing stopped yet');
  // Amber only on the interactive control: the row’s edge is a token line, the first choice’s the accent.
  const colors = await page.evaluate(
    `(() => { const probe = (v) => { const p = document.createElement('span'); p.style.color = v; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }; const row = getComputedStyle(${q('.stop-ask')}); const first = getComputedStyle(${q('.stop-ask .btn.send')}); return { row: row.borderTopColor, first: first.borderTopColor, accent: probe('var(--accent)'), line: probe('var(--line)'), bg: row.backgroundColor }; })()`,
  );
  assert.equal(colors.first, colors.accent);
  assert.equal(colors.row, colors.line);
  assert.notEqual(colors.row, colors.accent);
  await press('Escape');
  // The ask goes once the server has cleared it and the page has heard so.
  await until(() => store.state.sessions[se.id].stopAsk === null, 'the server to clear the ask');
  await page.synced(store.state.seq);
  await settle();
  assert.equal(await page.evaluate(`!!${q('.stop-ask')}`), false);
  assert.equal(await page.evaluate(`document.activeElement === ${q('.composer .btn.stop')}`), true, 'focus back on Stop');
  assert.equal(rt.turns.has(se.id), true, 'the agent carries on');
  assert.equal(store.state.sessions[se.id].stopAsk, null);
});

await check('#126 #129 Keep running, by keyboard: the agent reads stopping until it exits, and the job stays listed with its Stop', async () => {
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  await press('Tab');
  assert.equal(await focused(), 'Keep running');
  await press('Enter');
  await until(() => state() === 'stopping', 'stopping');
  await page.waitFor(`[...document.querySelectorAll('.who-state')].some((n) => /stopping/.test(n.textContent))`, { label: '“· stopping” beside the name' });
  await until(() => state() === 'idle', 'the process to exit');
  await page.waitFor(`!${q('.stop-ask')} && !!${q('.composer .btn.send')}`, { label: 'Send back' });
  assert.equal(step().state, 'running');
  assert.equal(await page.evaluate(`!!${q('.bg-jobs li button')}`), true, 'still listed, with its own Stop');
  assert.match(store.state.sessions[se.id].context.join('\n'), /bgjob1 .* is still running/);
  assert.match(await lastTag(), /^Stopped by you at \d\d:\d\d · its background work kept running$/);
});

await check('#129 the kept job’s own Stop stops its process group, and its step reads stopped', async () => {
  await click(q('.bg-jobs li button'));
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'the row to go' });
  assert.deepEqual(signals.at(-1), [-4242, 'SIGINT']);
  assert.equal(step().state, 'stopped');
  await page.evaluate(`${q('details.activity')}.open = true`);
  await settle();
  assert.match(await text(q('details.activity .steps li')), /Run the mixed-room UAT scenario live Stopped/);
});

await check('#129 Stop it too stops the agent and its job', async () => {
  await startJob();
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  await click(q('.stop-ask .btn.send'));
  await until(() => state() === 'idle', 'the process to exit');
  await page.waitFor(`!${q('.bg-jobs li')} && !${q('.stop-ask')}`, { label: 'no job row, no ask' });
  assert.equal(step().state, 'stopped');
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
  assert.match(await lastTag(), /^Stopped by you at \d\d:\d\d$/);
});

await check('#164 a kept job Postbox couldn’t tell apart says so under its row, and its own Stop stops every process it kept', async () => {
  await startJob('Run the UAT job, unsure which shell.');
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  await click(q('.stop-ask .btn:not(.send):not(.ghost)'));
  await until(() => state() === 'idle', 'the process to exit');
  await page.waitFor(`!!${q('.bg-jobs .job-note')}`, { label: 'the note under the job' });
  assert.match(
    await text(q('.bg-jobs li')),
    /^Background job · Run the mixed-room UAT scenario live Postbox couldn’t tell which of 2 processes is this job, so it kept them all running; stopping the job stops them all\. Stop$/,
  );
  // PB_SHOT=<file.png> saves the reply with its job row, in light mode as the UAT docs’ screenshots are.
  if (process.env.PB_SHOT) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await settle();
    const clip = await page.evaluate(
      `(() => { const r = ${q('.bg-jobs')}.parentElement.getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8 + scrollY), width: Math.min(r.width + 16, innerWidth), height: r.height + 16, scale: 1 }; })()`,
    );
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    await writeFile(process.env.PB_SHOT, Buffer.from(data, 'base64'));
  }
  const before = signals.length;
  await click(q('.bg-jobs li button'));
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'the row to go' });
  assert.deepEqual(signals.slice(before), [
    [-4242, 'SIGINT'],
    [-4343, 'SIGINT'],
  ]);
  assert.equal(step().state, 'stopped');
});

await check('#167 two kept jobs Postbox couldn’t tell apart: stopping one stops both, and the other’s step says why', async () => {
  await startJob('Run two jobs, unsure which shell.');
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  await click(q('.stop-ask .btn:not(.send):not(.ghost)'));
  await until(() => state() === 'idle', 'the process to exit');
  await page.waitFor(`document.querySelectorAll('.bg-jobs li').length === 2`, { label: 'both job rows' });
  await click(q('.bg-jobs li button'));
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'both rows to go' });
  const rows = await page.evaluate(
    `(() => { const d = [...document.querySelectorAll('details.activity')].at(-1); d.open = true; return [...d.querySelectorAll('.steps li .step-text')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim()); })()`,
  );
  assert.deepEqual(rows, [
    'Run the mixed-room UAT scenario live Stopped',
    'Tail the UAT log Stopped: Postbox couldn’t tell its processes from those of the background job “Run the mixed-room UAT scenario live”, so stopping that job stopped this one too.',
  ]);
});

await check('#215 a queued message’s Send now: the reply it interrupted says so, and its job keeps running', async () => {
  await startJob();
  rt.sendMessage(room.id, { text: 'A one-line status, please.' });
  await page.waitFor(`!!${q('.queued')}`, { label: 'the queued message' });
  await click(q('.queued .btn.sm:not(.ghost)'));
  await until(() => state() === 'idle' && store.state.sessions[se.id].jobs.some((j) => j.kept), 'the next turn, with the job kept');
  assert.match(await lastTag(), /^Interrupted by Send now at \d\d:\d\d$/);
  assert.equal(await page.evaluate(`!!${q('.bg-jobs li button')}`), true, 'still listed, with its own Stop');
  await click(q('.bg-jobs li button'));
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'the row to go' });
});

await check('#129 #215 at 375 px the ask, the job row and each stopped reply’s tag fit without scrolling sideways', async () => {
  await page.size(375, 800);
  await startJob();
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  const over = await page.evaluate(
    `[...document.querySelectorAll('.stop-ask, .stop-ask button, .bg-jobs li, .stopped-tag')].filter((n) => { const b = n.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1 || n.scrollHeight > n.clientHeight + 1; }).map((n) => n.className || n.textContent)`,
  );
  assert.deepEqual(over, []);
  await click(q('.stop-ask .btn.send'));
  await until(() => state() === 'idle', 'the process to exit');
});

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
