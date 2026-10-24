// A headless Chrome check that the remote-hosts UI (#120, the plan’s L6a, L6b and L7) comes together in one running
// Postbox, at 1280 and 375 px with axe, nothing running off the window:
// - an agent placed on a host: its ring says where it runs and the connection, and (at 1280) its row in the agents
//   list says it too;
// - the Work view of its conversation has the host’s one line: its files there aren’t recorded;
// - Settings has a Hosts tab with the host’s card, and the tabs row fits the window at 375 px (it wraps);
// - the persona sheet’s Runs on names the host the agent runs on.
//
//   node tools/check-remote-ui.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a fake host manager (no ssh, no host,
// no daemon: the host’s status is set here, as the real manager reports it). Claude Code counts as on this computer
// (a fake probe), so nothing real is looked for, and no turn runs: the Work view is fed two recorded Claude Code turns
// (tests/fixtures/claude-code/ledger-*.jsonl) as turns on the host, as tools/check-work-remote.mjs does. PB_PORT and
// PB_CHROME_PORT move it (4880 and 9680 by default).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4880, 9680);

/** The host manager, as the runtime uses it: the host’s status is what this check sets. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.statuses = new Map();
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  set(id, status) {
    this.statuses.set(id, status);
    this.emit('status', id, status);
  }
  link() {
    return Object.assign(new EventEmitter(), { connected: true, send: () => true });
  }
  async connect(id) {
    return this.statuses.get(id)?.welcome ?? null;
  }
  async ensureWelcome(id) {
    return this.statuses.get(id)?.welcome ?? { home: '/home/user', turns: [] };
  }
  async signInCheck() {
    return null;
  }
  describeInstall() {
    return { destination: 'host.example.com', steps: [], text: '' };
  }
  async install() {
    return { token: 'T'.repeat(43), installed: true, version: '0.18.0' };
  }
  need() {}
  release() {}
  wake() {}
  async forget() {
    return true;
  }
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
const root = await mkdtemp(join(tmpdir(), 'pb-check-remote-ui-'));
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

// ── An agent on a host, and two turns it ran there ─────────────────────────────────────

const MIN = 60_000;
const host = rt.addHost({ name: 'host.example.com' });
// The welcome as the daemon sends it (shared/remote-protocol.mjs), trimmed: Claude Code found there.
const welcome = {
  version: '0.18.0',
  home: '/home/user',
  node: { version: '22.12.0', path: '/usr/bin/node' },
  harnesses: [{ name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300' }],
  problems: [],
  turns: [],
};
hosts.set(host.id, { state: 'connected', failure: null, welcome, lastHeard: Date.now() - 2 * MIN, name: host.name });
store.emit('project', { id: 'pr_remote', name: 'Remote', folder: root });
const persona = rt.createPersona({ handle: 'builder', backend: 'claude-code', remote: { hostId: host.id } });
const conv = rt.createThread({ projectId: 'pr_remote', title: 'Remote build', personaIds: [persona.id] });
const se = rt.sessionsIn(conv.id).find((x) => x.personaId === persona.id);
const fixture = async (name) =>
  (await readFile(new URL(`../tests/fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
for (const [i, name] of ['ledger-edits', 'ledger-push'].entries()) {
  const turn = { id: `turn_remote_${i + 1}`, threadId: conv.id, startedAt: Date.now(), remote: { hostId: host.id } };
  // What the runtime keeps on the session for a host turn: its folder on the host. The turn is over (done).
  rt.updateSession(se.id, { remoteTurn: { hostId: host.id, turn: `host-${turn.id}`, rtTurn: turn.id, folder: '/workspace/rec', state: 'done' } });
  rt.ledger.startTurn(turn, { se: store.state.sessions[se.id], folder: null, projectFolder: root });
  const ledger = rt.ledger;
  const m = createStreamMapper(
    {
      text() {},
      activity() {},
      status() {},
      compaction() {},
      toolUse: (u) => ledger.toolUse(turn, u),
      toolResult: (r) => ledger.toolResult(turn, r),
      taskEnded: (x) => ledger.taskEnded(turn, x),
      usage: (u) => ledger.usage(turn, u),
    },
    { now: () => Date.now() },
  );
  for (const e of await fixture(name)) m.push(e);
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
}
const NOTE = 'Files on host.example.com aren’t recorded: Postbox lists the ones @builder edited there, with no diff and no Restore.';

// ── The page ───────────────────────────────────────────────────────────────────────────

const page = await launch({ port: CHROME_PORT });
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => v.id + ' (' + v.impact + '): ' + v.help + ' at ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')))`;
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = (sel) => page.evaluate(`${q(sel)}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
async function axe(where) {
  if (!(await page.evaluate('typeof axe === "object"'))) await page.evaluate(`${AXE};0`);
  const found = await page.evaluate(AXE_RUN);
  assert.deepEqual(found, [], `axe found problems ${where}:\n${found.join('\n')}`);
}
/** Visible elements under a selector that run past the window’s sides, and whether the page scrolls sideways. */
async function fits(sel, where) {
  const over = await page.evaluate(`(() => {
    const out = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .filter((n) => { const b = n.getBoundingClientRect(); return b.width && n.offsetParent !== null && (b.right > innerWidth + 1 || b.left < -1); })
      .map((n) => n.tagName + '.' + n.className).slice(0, 5);
    const d = document.documentElement;
    if (d.scrollWidth > innerWidth + 1) out.push('the page, by ' + (d.scrollWidth - innerWidth) + ' px');
    return out;
  })()`);
  assert.deepEqual(over, [], `Runs off the window ${where}: ${over.join(', ')}`);
}
/** The labels of @builder’s rings that show. */
const ringLabels = () =>
  page.evaluate(
    `[...document.querySelectorAll('pb-ring[name="@builder"]')].filter((r) => r.getBoundingClientRect().width && r.offsetParent !== null).map((r) => r.querySelector('svg')?.getAttribute('aria-label') ?? '')`,
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
const closeDialogs = async () => {
  for (let i = 0; i < 3 && (await page.evaluate(`!!${q('.dialog')}`)); i++) {
    await page.evaluate(`[...document.querySelectorAll('.dialog [aria-label="Close"]')].at(-1)?.click()`);
    await settle();
  }
};
async function go(hashTo) {
  await closeDialogs();
  await page.evaluate(`location.hash = ${JSON.stringify(hashTo)}`);
  await page.waitFor(`document.querySelector('#main.transcript')?.dataset.thread === '${conv.id}' && !!document.querySelector('#composer-input')`, {
    label: 'the conversation',
  });
  await settle();
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${conv.id}`);
await page.waitFor(`!!${q('#composer-input')}`, { label: 'the conversation' });
await settle();

for (const [width, height] of [
  [1280, 900],
  [375, 812],
]) {
  const at = `${width} px`;
  await page.size(width, height);
  await settle();

  await check(`${at}: the agent’s ring says it runs on the host, connected${width > 767 ? ', and so does its row' : ''}`, async () => {
    await go(`#/t/${conv.id}`);
    const labels = await ringLabels();
    assert.ok(labels.length, 'a ring for @builder shows');
    for (const l of labels) assert.match(l, /; on host\.example\.com, connected, last heard from 2 min ago$/);
    if (width > 767) {
      const row = await page.evaluate(
        `[...document.querySelectorAll('.agent-row')].find((n) => n.querySelector('b')?.textContent === '@builder')?.innerText.replace(/\\s+/g, ' ') ?? ''`,
      );
      assert.match(row, /On host\.example\.com · Connected · last heard from 2 min ago/);
    }
    await axe('in the conversation');
    await fits('.agent-row, .ringstrip, header.topbar *', 'in the conversation');
  });

  await check(`${at}: the Work view has the host’s line`, async () => {
    await go(`#/t/${conv.id}?work`);
    await page.waitFor(q('#work-pane .work-host-note'), { label: 'the host’s line' });
    assert.equal(await text('#work-pane .work-host-note'), NOTE);
    await axe('in the Work view');
    await fits('#work-pane, #work-pane *', 'in the Work view');
  });

  await check(`${at}: Settings has a Hosts tab with the host, and its tabs row fits the window`, async () => {
    await go(`#/t/${conv.id}`);
    await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts'))`);
    await page.waitFor(`!!${q(`[data-host="${host.id}"]`)}`, { label: 'the host’s card' });
    assert.equal(await text('.dialog [role=tab][aria-selected=true]'), 'Hosts');
    assert.match((await text(`[data-host="${host.id}"]`)) ?? '', /host\.example\.com/);
    const tabs = await page.evaluate(`(() => {
      const d = document.querySelector('.dialog').getBoundingClientRect();
      const row = document.querySelector('.dialog .tabs');
      const out = [...row.querySelectorAll('[role=tab]')].filter((t) => { const b = t.getBoundingClientRect(); return b.right > d.right + 1 || b.left < d.left - 1; }).map((t) => t.textContent);
      if (row.scrollWidth > row.clientWidth + 1) out.push('the row scrolls by ' + (row.scrollWidth - row.clientWidth) + ' px');
      if (d.right > innerWidth + 1 || d.left < -1) out.push('the sheet is wider than the window');
      return out;
    })()`);
    assert.deepEqual(tabs, [], 'every tab within the sheet, and the sheet within the window');
    await axe('on the Hosts tab');
    await fits('.dialog, .dialog *', 'on the Hosts tab');
  });

  await check(`${at}: the persona sheet’s Runs on names the host`, async () => {
    await closeDialogs();
    await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${JSON.stringify(persona.id)}))`);
    await page.waitFor(`!!${q('#pe-where')}`, { label: 'Runs on' });
    const chosen = await page.evaluate(`[...${q('#pe-where')}.options].filter((o) => o.selected).map((o) => o.textContent)`);
    assert.deepEqual(chosen, ['host.example.com']);
    assert.match((await text('#pe-where-help')) ?? '', /^Its turns run on host\.example\.com, over your own ssh;/);
    await axe('on the persona sheet');
    await fits('.dialog, .dialog *', 'on the persona sheet');
    await closeDialogs();
  });
}

await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
