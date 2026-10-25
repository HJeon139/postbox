// A headless Chrome check that a stopped reply settles its steps (#288), driven with real clicks. The agent has a
// background job and a foreground call running when you press Stop, as in the p0 UAT:
// - Stop it too: the reply’s header doesn’t say “running”, and the foreground call reads as stopped;
// - Keep running: the header says its background work is running, not that the reply is, and the job keeps its row;
//   so it does when a card split the reply, and the steps are on its first part, which isn’t the stopped one.
//
//   node tools/check-stop-steps.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a scripted Claude Code agent (no real
// turns or processes: the job’s process group is a fake). PB_PORT and PB_CHROME_PORT move it (5550 and 10850 by
// default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { js, launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(5550, 10850);

process.env.POSTBOX_BACKENDS = 'mock';
const root = await mkdtemp(join(tmpdir(), 'pb-check-stop-steps-'));
const app = await start({ port: PORT, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true, claudeHome: root });
const { rt, store } = app;
// The job’s process group: nothing is signaled, and ps shows its shell, so a kept job stays the job’s.
rt.signalProcess = () => true;
rt.listProcesses = async () => [{ pid: 4242, ppid: 1, pgid: 4242, command: "/bin/zsh -c source snapshot.sh && eval 'sh heartbeat.sh' < /dev/null" }];

// The reply’s steps as the p0 UAT recorded them at its Stop (Postbox 0.30.1): a background loop with its job, a wait
// that had finished, and the same wait running when the person pressed Stop.
const BG = 'Append timestamps to heartbeat-2.log every 5 seconds for 3 minutes';
const WAIT = 'Wait 20 seconds, then count lines in heartbeat-2.log';
let n = 0;
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return root;
  },
  async deliver(_session, message, ctx) {
    const id = `bgheart${++n}`;
    ctx.text('Started the loop.');
    ctx.activity({ id: `tu_${id}`, label: BG, state: 'running', job: id });
    ctx.job({ id, toolUseId: `tu_${id}`, label: BG, command: 'sh heartbeat.sh', outputFile: '/tmp/out.txt', state: 'running' });
    ctx.activity({ id: `tu_${id}_w1`, label: WAIT, state: 'done', ms: 21237 });
    // Asked for a card, it shows one and writes on: the reply is in two parts, with its steps on the first.
    if (/card/.test(message.text ?? '')) {
      ctx.tools.show_block({ block: { id: `card${n}`, type: 'card', version: 1, title: 'Heartbeat', fallback: 'The loop is running.' } });
      ctx.text('Checking it again.');
    }
    ctx.activity({ id: `tu_${id}_w2`, label: WAIT, state: 'running' });
    await new Promise((r) => ctx.signal.addEventListener('abort', r));
    ctx.job(ctx.signal.reason?.keepJobs?.length ? { id, kept: true, pgid: 4242 } : { id, state: 'stopped' });
  },
});
store.emit('project', { id: 'pr_steps', name: 'Stop steps', folder: root });
const dev = rt.createPersona({ handle: 'developer', backend: 'claude-code', permissionMode: 'auto' });
const room = rt.createThread({ projectId: 'pr_steps', title: 'Stop steps check', personaIds: [dev.id] });
const [se] = rt.sessionsIn(room.id);

const page = await launch({ port: CHROME_PORT });
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
const q = (sel) => `document.querySelector(${js(sel)})`;
const until = async (fn, label) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const state = () => store.state.sessions[se.id].state;
// The last reply’s header and its steps, and the last stopped tag, once the page has heard everything the server has said.
async function lastReply() {
  await page.synced(store.state.seq);
  return page.evaluate(
    `(() => { const d = [...document.querySelectorAll('details.activity')].at(-1); d.open = true; const t = (n) => n.innerText.replace(/\\s+/g, ' ').trim(); return { header: t(d.querySelector('summary')), steps: [...d.querySelectorAll('.steps li .step-text')].map(t), tag: t([...document.querySelectorAll('.stopped-tag')].at(-1)) }; })()`,
  );
}

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
}
/** Starts the turn, waits for its job row and the running wait, then presses Stop and picks `choice` in its ask. */
async function stopWith(choice, text = 'Start a background loop that appends the time to heartbeat-2.log, and check it every 20 seconds.') {
  rt.sendMessage(room.id, { text });
  await page.waitFor(`!!${q('.bg-jobs li')} && !!${q('.composer .btn.stop')}`, { label: 'the job row and Stop' });
  await click(q('.composer .btn.stop'));
  await page.waitFor(`!!${q('.stop-ask')}`, { label: 'the ask' });
  await click(q(choice === 'stop' ? '.stop-ask .btn.send' : '.stop-ask .btn:not(.send):not(.ghost)'));
  await until(() => state() === 'idle', 'the process to exit');
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${room.id}`);
await page.waitFor(`!!${q('#composer-input')}`, { label: 'the composer' });

await check('#288 Stop it too: the stopped reply’s header doesn’t say running, and its foreground call reads stopped', async () => {
  await stopWith('stop');
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'the job row to go' });
  const r = await lastReply();
  assert.match(r.tag, /^Stopped by you at \d\d:\d\d$/);
  // Before #288: “Used 3 tools · 21 s in tools · running”.
  assert.doesNotMatch(r.header, /running/);
  assert.deepEqual(r.steps, [`${BG} Stopped`, WAIT, `${WAIT} Stopped`]);
});

await check('#288 Keep running: the header says its background work runs on, not the reply, and the wait reads stopped', async () => {
  await stopWith('keep');
  const r = await lastReply();
  assert.match(r.tag, /^Stopped by you at \d\d:\d\d · its background work kept running$/);
  assert.match(r.header, /^Used 3 tools · 21 s in tools · background work running$/);
  assert.deepEqual(r.steps, [`${BG} Running in the background`, WAIT, `${WAIT} Stopped`]);
  assert.equal(await page.evaluate(`!!${q('.bg-jobs li button')}`), true, 'the kept job keeps its row, with its own Stop');
  await click(q('.bg-jobs li button'));
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'the row to go' });
});

await check('#288 Keep running, with a card between: the reply’s first part, which has its steps, doesn’t say running either', async () => {
  await stopWith('keep', 'Start the heartbeat loop, show me a card, and check it every 20 seconds.');
  const r = await lastReply();
  assert.match(r.tag, /^Stopped by you at \d\d:\d\d · its background work kept running$/);
  assert.match(r.header, /^Used 3 tools · 21 s in tools · background work running$/);
  assert.deepEqual(r.steps, [`${BG} Running in the background`, WAIT, `${WAIT} Stopped`]);
  await click(q('.bg-jobs li button'));
  await page.waitFor(`!${q('.bg-jobs li')}`, { label: 'the row to go' });
});

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
