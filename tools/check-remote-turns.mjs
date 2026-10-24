// A headless Chrome check of agents whose turns run on a host (#120, the plan’s L6), with axe at 1280 and 375 px:
// - the agents list and each ring say where an agent runs, when Postbox last heard from the host, and the
//   connection in words: Connected, Reconnecting, Disconnected (working) and Disconnected (idle) (G3);
// - the transcript shows each turn state in words: “Sign-in needed on <host>” and “Interrupted on <host>”, each with
//   Resume, which goes through the runtime’s resumeRemote and starts with why the last turn stopped; a hung turn’s
//   note; Lost, with no Retry; a stop the host hasn’t confirmed; and a replayed reply once, not twice;
// - permission cards a host ended say how: expired with nobody answering, canceled by the agent, or ended unrecorded;
// - a Kiro CLI turn on a host shows its warning as a notice; a `!` command says it ran on this computer, and the
//   composer’s hint says where it will;
// - Stop says beforehand that the host’s background jobs stop with the turn, never offers to keep them, and a job’s
//   own Stop isn’t offered;
// - the persona sheet’s Runs on offers this computer or a host, only a host for a backend not on this computer, says
//   what the host’s daemon found, and shows the server’s refusal; Codex’s `auto` reads as Codex’s default.
//
//   node tools/check-remote-turns.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a fake host manager (no ssh, no host,
// no daemon: each host’s status is set here, as the real manager reports it) and a scripted Claude Code agent whose
// turns run “on” a host through the runtime’s remote path. The other states are seeded on the sessions as
// server/remote/turns.mjs keeps them. PB_PORT and PB_CHROME_PORT move it (4600 and 9800 by default).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4600, 9800);

/** The host manager, as the runtime uses it: each host’s status is what this check sets, and its link takes anything. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Map<string, any>} */
    this.links = new Map();
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  set(id, status) {
    this.statuses.set(id, status);
    this.emit('status', id, status);
  }
  link(id) {
    if (!this.links.has(id)) {
      const link = Object.assign(new EventEmitter(), { connected: true, sent: /** @type {any[]} */ ([]) });
      link.send = (m) => {
        link.sent.push(m);
        return true;
      };
      this.links.set(id, link);
    }
    return this.links.get(id);
  }
  async ensureWelcome(id) {
    return this.statuses.get(id)?.welcome ?? { home: '/home/user', turns: [] };
  }
  async signInCheck() {
    return null;
  }
  need() {}
  release() {}
  wake() {}
  async forget() {}
  async refresh() {
    return false;
  }
  destinationOf(id) {
    return this.statuses.get(id)?.name ?? null;
  }
  async close() {}
}

const none = async () => null;
const nothing = async () => [];
const hosts = new FakeHosts();
const root = await mkdtemp(join(tmpdir(), 'pb-check-remote-'));
// Claude Code is on this computer (the stand-in below runs its turns); Kiro CLI and Codex only on a host.
const app = await start({
  port: PORT,
  dataDir: join(root, 'data'),
  fresh: true,
  quiet: true,
  claudeHome: root,
  hosts: /** @type {any} */ (hosts),
  probes: { claude: async () => '2.1.300', sdk: none, kiro: none, kiroModels: nothing, agy: none, agyModels: nothing, codex: none, codexModels: nothing },
});
const { rt, store } = app;

// The scripted Claude Code agent: its capabilities are the real adapter’s, so it can run on a host. Asked for a job,
// it starts one in the background and works until it’s stopped; otherwise it replies at once. It records each
// message it’s given, with the lines the runtime put before it.
const delivered = [];
const caps = rt.adapters.get('claude-code').capabilities;
rt.adapters.register({
  name: 'claude-code',
  capabilities: caps,
  async folderFor() {
    return root;
  },
  async deliver(_session, message, ctx) {
    delivered.push({ text: message.text ?? '', context: message.context ?? [], remote: !!ctx.remote });
    if (!/job/.test(message.text ?? '')) return ctx.text('Carrying on where I left off.');
    ctx.text('Starting the test run in the background.');
    ctx.activity({ id: 'tu_job', label: 'Run the whole test suite', state: 'running', job: 'bgjob1' });
    ctx.job({ id: 'bgjob1', toolUseId: 'tu_job', label: 'Run the whole test suite', command: 'npm test', outputFile: '/tmp/out.txt', state: 'running' });
    await new Promise((r) => ctx.signal.addEventListener('abort', r));
    ctx.job({ id: 'bgjob1', state: 'stopped' });
  },
});

// ── Seeded state ───────────────────────────────────────────────────────────────────────

const now = Date.now();
const MIN = 60_000;
store.emit('project', { id: 'pr_remote', name: 'Remote', folder: root });
const A = rt.addHost({ name: 'host.example.com' });
const B = rt.addHost({ name: 'build.example.com' });
const C = rt.addHost({ name: 'gpu.example.com' });
// The welcome as the daemon sends it (shared/remote-protocol.mjs), trimmed: Claude Code and Kiro CLI found, Codex not.
const welcome = {
  version: '0.10.0',
  home: '/home/user',
  node: { version: '22.12.0', path: '/usr/bin/node' },
  harnesses: [
    { name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300' },
    { name: 'kiro-cli', path: '/home/user/.local/bin/kiro-cli' },
    { name: 'codex', path: null, looked: ['/home/user/.local/bin', '/usr/local/bin'] },
  ],
  problems: [],
  turns: [],
};
hosts.set(A.id, { state: 'connected', failure: null, welcome, lastHeard: now - 2 * MIN, name: A.name });
hosts.set(B.id, { state: 'disconnected', failure: null, welcome: null, lastHeard: now - 40 * MIN, name: B.name });
hosts.set(C.id, { state: 'reconnecting', failure: null, welcome: null, lastHeard: now - 5 * MIN, name: C.name });

const on = (hostId) => ({ remote: { hostId } });
const persona = (handle, hostId, backend = 'claude-code') => rt.createPersona({ handle, backend, ...(hostId ? on(hostId) : {}) });
const coder = persona('coder', A.id); // Sign-in needed
const fixer = persona('fixer', A.id); // Interrupted
const watcher = persona('watcher', A.id); // hung
const stopper = persona('stopper', A.id); // stopping, unconfirmed
const builder = persona('builder', B.id); // lost: Disconnected (working)
const idler = persona('idler', B.id); // Disconnected (idle)
const tester = persona('tester', C.id); // Reconnecting
const scout = persona('scout', A.id, 'kiro-cli'); // a Kiro turn’s notice, and a replayed reply
const cx = persona('cx', B.id, 'codex'); // Codex’s default; Runs on only a host
// A Codex persona from before `auto`: its Claude model is ignored by Codex, and reads as Codex’s default.
store.emit('persona', { ...rt.persona(cx.id), model: 'claude-opus-5-5' });
const local = persona('local', null);
const room = rt.createThread({
  projectId: 'pr_remote',
  title: 'Remote turns',
  personaIds: [coder, fixer, watcher, stopper, builder, idler, tester, scout, cx].map((p) => p.id),
});
const dm = rt.createThread({ projectId: 'pr_remote', title: 'Runner', personaIds: [persona('runner', A.id).id] });
const solo = rt.createThread({ projectId: 'pr_remote', title: 'Local', personaIds: [local.id] });
const ses = Object.fromEntries(rt.sessionsIn(room.id).map((se) => [se.handle, se]));
const [runner] = rt.sessionsIn(dm.id);
const remoteTurn = (se, hostId, rtTurn, patch) =>
  rt.updateSession(se.id, {
    remoteTurn: {
      hostId,
      turn: `ht_${rtTurn}`,
      offset: 0,
      rtTurn,
      threadId: room.id,
      folder: '/home/user/postbox-work',
      at: now,
      replies: [],
      stopping: [],
      ...patch,
    },
  });
const reply = (se, turnId, patch) =>
  rt.addItem(room.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, turnId, text: '', status: 'done', ...patch });

remoteTurn(ses.coder, A.id, 'tu_signin', { state: 'signin', resume: { why: 'signin', at: now }, autoResumes: 0 });
reply(ses.coder, 'tu_signin', {
  status: 'failed',
  error: 'Sign-in needed on host.example.com. Sign in there, then resume @coder.',
  remote: { state: 'signin', hostId: A.id },
});
// Interrupted three times in a row: Postbox stopped resuming it on its own, so it waits for the person.
remoteTurn(ses.fixer, A.id, 'tu_int', { state: 'interrupted', resume: { why: 'interrupted', at: now }, autoResumes: 3 });
reply(ses.fixer, 'tu_int', {
  status: 'failed',
  error: 'Interrupted on host.example.com: the agent’s process there ended without finishing its turn.',
  remote: { state: 'interrupted', hostId: A.id },
});
const HUNG = 'Stopped: no output for 15 min (the last at 14:02)';
remoteTurn(ses.watcher, A.id, 'tu_hung', { state: 'hung', message: HUNG });
reply(ses.watcher, 'tu_hung', { text: 'Waiting on the build…', status: 'stopped', stoppedAt: now, note: HUNG });
remoteTurn(ses.stopper, A.id, 'tu_stop', { state: 'stopping', stopping: [{ turn: 'ht_tu_stop', hostId: A.id, at: now }] });
remoteTurn(ses.builder, B.id, 'tu_lost', { state: 'lost' });
reply(ses.builder, 'tu_lost', { status: 'failed', error: 'The connection to build.example.com gave up.' });
// Replayed from the start after a restart: the first part is replaced, the replay is the whole reply.
remoteTurn(ses.scout, A.id, 'tu_kiro', { state: 'done' });
reply(ses.scout, 'tu_kiro', { text: '', status: 'replaced' });
reply(ses.scout, 'tu_kiro', {
  text: 'I read the README and the tests.',
  activity: {
    steps: [
      {
        id: 'kiro-remote-argv',
        label: 'Other users on the host can read this message',
        state: 'done',
        detail:
          'Kiro CLI takes its message as a command-line argument, and other users on a Linux host can read a process’s arguments in /proc unless it’s mounted with hidepid. Don’t send a Kiro agent on a shared host anything they shouldn’t see.',
      },
      { id: 'st1', label: 'read README.md', state: 'done', ms: 40 },
    ],
  },
});
const card = (status, extra) =>
  rt.addItem(room.id, {
    kind: 'permission',
    sessionId: ses.coder.id,
    handle: 'coder',
    tool: 'Bash',
    summary: 'run npm test',
    detail: 'npm test',
    status,
    answeredAt: now,
    endedAt: now,
    remote: { hostId: A.id, turn: 'ht_tu_signin', prompt: `p_${status}` },
    ...extra,
  });
card('expired', { noAnswer: true });
card('canceled');
card('ended');
rt.addItem(room.id, {
  kind: 'command',
  command: 'git status',
  cwd: root,
  notOn: 'host.example.com',
  status: 'done',
  text: '! commands run on this computer, not on host.example.com.\nOn branch main\n',
  exitCode: 0,
  ms: 120,
  cut: false,
});

// ── The page ───────────────────────────────────────────────────────────────────────────

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
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
/** Opens a conversation in the page that’s loaded, as a link would. */
async function go(threadId) {
  await page.evaluate(`location.hash = '#/t/${threadId}'`);
  await page.waitFor(`document.querySelector('#main.transcript')?.dataset.thread === '${threadId}' && !!document.querySelector('#composer-input')`, {
    label: `the conversation ${threadId}`,
  });
  await settle();
}
const text = (expr) => page.evaluate(`(${expr})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const until = async (fn, label) => {
  for (let i = 0; i < 400; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
/** The text of the agent row for a handle, in the sidebar’s Agents. */
const row = (handle) => text(`[...document.querySelectorAll('.agent-row')].find((n) => n.querySelector('b')?.textContent === '@${handle}')`);
const ringLabel = (handle) =>
  page.evaluate(
    `[...document.querySelectorAll('.agent-row')].find((n) => n.querySelector('b')?.textContent === '@${handle}')?.querySelector('pb-ring svg')?.getAttribute('aria-label') ?? ''`,
  );
/** The transcript item of a reply, by its session. */
const itemOf = (handle) =>
  `[...document.querySelectorAll('.transcript .item')].filter((n) => !n.hidden && n.querySelector('.who b')?.textContent === '@${handle}').at(-1)`;

const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => \`\${v.id}: \${v.help} (\${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ')})\`))`;
async function axe() {
  await page.evaluate(`${AXE};0`);
  return page.evaluate(AXE_RUN);
}
/** Elements of a selector that spill past the window’s sides. */
const overflow = (sel) =>
  page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((n) => { const b = n.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || b.left < -1); }).map((n) => n.className || n.tagName)`,
  );

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

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${room.id}`);
await page.waitFor(`!!${q('.agent-row')} && !!${q('.transcript .host-callout')}`, { label: 'the room, its agents and its replies' });
await settle();

await check('#120 G3 the agents list says each remote agent’s host, when it was last heard from, and the connection in words', async () => {
  assert.match(await row('coder'), /On host\.example\.com · Connected · last heard from 2 min ago/);
  assert.match(await row('tester'), /On gpu\.example\.com · Reconnecting · last heard from 5 min ago/);
  assert.match(await row('builder'), /On build\.example\.com · Disconnected \(working\) · last heard from 40 min ago/);
  assert.match(await row('builder'), /Lost: Postbox can’t reach build\.example\.com, and the turn may still run there/);
  assert.match(await row('idler'), /On build\.example\.com · Disconnected \(idle\) · last heard from 40 min ago/);
  assert.match(await row('coder'), /Sign-in needed on host\.example\.com/);
  assert.match(await row('stopper'), /Stopping on host\.example\.com: Postbox waits for the host to confirm/);
  // Codex’s `auto`, and a Claude model a Codex persona kept, read as Codex’s default.
  assert.match(await row('cx'), /Codex’s default · medium effort/);
  assert.doesNotMatch(await row('cx'), /Opus/);
});

await check('#120 G3 each ring’s label says where its agent runs and the connection, not by color alone', async () => {
  assert.match(
    await ringLabel('builder'),
    /^@builder: Idle, \d+% of context used; on build\.example\.com, disconnected \(working\), last heard from 40 min ago$/,
  );
  assert.match(await ringLabel('coder'), /; on host\.example\.com, connected, last heard from 2 min ago$/);
  // A change to the host’s status reaches the rings and the rows without a session change.
  hosts.set(C.id, { state: 'connected', failure: null, welcome: null, lastHeard: Date.now(), name: C.name });
  await page.waitFor(
    `[...document.querySelectorAll('.agent-row')].some((n) => /On gpu\\.example\\.com · Connected · last heard from just now/.test(n.innerText) && /connected, last heard from just now/.test(n.querySelector('pb-ring svg').getAttribute('aria-label')))`,
    { label: 'the tester’s row and ring, connected' },
  );
});

await check('#120 the turn states read in words in the transcript: Sign-in needed and Interrupted with Resume, hung, Lost', async () => {
  assert.match(
    await text(`${itemOf('coder')}.querySelector('.host-callout')`),
    /^Sign-in needed on host\.example\.com · Sign in there, then resume @coder\. Resume it once you’ve signed in\. Resume$/,
  );
  assert.match(
    await text(`${itemOf('fixer')}.querySelector('.host-callout')`),
    /^Interrupted on host\.example\.com · The agent’s process there ended without finishing its turn\. It was interrupted again after Postbox resumed it, so it waits for you\. Resume$/,
  );
  assert.equal(await text(`${itemOf('watcher')}.querySelector('.stopped-tag')`), HUNG);
  assert.match(
    await text(`${itemOf('builder')}.querySelector('.host-callout')`),
    /^Lost: Postbox can’t reach build\.example\.com · The connection to build\.example\.com gave up\. The turn may still be running there\. Postbox attaches to it again once the host is back\.$/,
  );
  // Retry would start over on the host, not resume: it isn’t offered for any of them.
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.host-callout button')].some((b) => /Retry/.test(b.textContent))`), false);
  assert.match(
    await text(q('.host-turns')),
    /^@stopper · Stopping on host\.example\.com: Postbox asked it to stop, and waits for the host to confirm\. It may still run there until then\.$/,
  );
});

await check('#120 a replayed reply shows once, with its name, and a Kiro turn’s warning is a notice above it', async () => {
  const scouts = await page.evaluate(
    `[...document.querySelectorAll('.transcript .item')].filter((n) => !n.hidden).filter((n) => /I read the README|@scout/.test(n.innerText)).length`,
  );
  assert.equal(scouts, 1, 'one reply from @scout');
  assert.equal(await page.evaluate(`!!${itemOf('scout')}.querySelector('.who')`), true, 'it names its speaker');
  assert.match(
    await text(`${itemOf('scout')}.querySelector('.host-notice')`),
    /^Other users on the host can read this message Kiro CLI takes its message as a command-line argument/,
  );
  assert.equal(await page.evaluate(`${itemOf('scout')}.querySelector('.host-notice').getAttribute('role')`), 'note');
  // The notice isn’t folded into the steps, and isn’t counted as a tool.
  assert.equal(await text(`${itemOf('scout')}.querySelector('details.activity summary')`), 'Read 1 file · 0.0 s in tools');
});

await check('#120 permission cards a host ended say how: nobody answered in time, canceled by the agent, or ended unrecorded', async () => {
  const notes = await page.evaluate(`[...document.querySelectorAll('.transcript .block.answered .answered-note')].map((n) => n.textContent.trim())`);
  assert.deepEqual(notes, ['Expired: nobody answered in time', 'Canceled by the agent', 'Ended: Postbox couldn’t save the expiry']);
});

await check('#120 a ! command run while the agent works on a host says it ran on this computer, once', async () => {
  assert.equal(await text(q('.cmd-block .cmd-where')), 'Ran on this computer, not on host.example.com.');
  assert.equal(await text(q('.cmd-block .cmd-out')), 'On branch main');
});

await check('#120 axe finds no violations in the room at 1280 px', async () => {
  assert.deepEqual(await axe(), []);
});

await check('#120 Resume calls the runtime’s resume, which starts with why the last turn stopped, and Resume goes', async () => {
  const before = delivered.length;
  await click(`${itemOf('coder')}.querySelector('.host-callout button')`);
  await until(() => delivered.length > before, 'the resumed turn');
  const d = delivered.at(-1);
  assert.equal(d.remote, true, 'it ran through the remote path');
  assert.match(
    d.context.join('\n'),
    /^\[Postbox\] Your last turn on host\.example\.com stopped before it finished, because the sign-in on that host had run out\./,
  );
  assert.match(d.text, /The person asked you to resume/);
  await page.waitFor(
    `![...document.querySelectorAll('.host-callout button')].some((b) => b.getAttribute('aria-label') === 'Resume @coder on host.example.com')`,
    {
      label: 'Resume to go',
    },
  );
  await until(() => !rt.turns.has(ses.coder.id), 'the turn to end');
  assert.equal(store.state.sessions[ses.coder.id].remoteTurn.state, 'done');
});

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

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
