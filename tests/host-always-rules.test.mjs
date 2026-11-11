// Always allow on a host turn's card (#120, server/host-rules.mjs): the host's Claude Code never reads the agent folder
// on this computer, so Postbox keeps the rule in its store, for that persona on that host, and sends it in each later
// host turn's --settings as an allow rule. Nothing is written on the host or here; a local turn, another host and
// another persona never get it; the permissions panel lists it with its host and removes it; it survives a reload.
// The rig is tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { WRITE_TOOLS } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { callLine, createFakeDaemon, FIXTURE_PROMPT, FIXTURE_PROMPTS, fixtureLines } from './fake-daemon.mjs';
import { corpus, fakeHosts, HOST, rig, running, settled, starts, until, VERSION } from './remote-turns-helpers.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A start's --settings, parsed. */
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]);
/** The allow rules a host turn's Claude Code got in its --settings. */
const allowOf = (start) => settingsOf(start.argv).permissions?.allow ?? [];
/** The rig, with its persona in this mode. */
function rigIn(permissionMode = 'auto', o = {}) {
  const r = rig(o);
  r.rt.updatePersona(r.rt.personaFor(r.se()).id, { permissionMode });
  return r;
}
const personaOf = (r) => r.rt.persona(r.se().personaId);
/** One host turn, with nothing asked: what it started with. */
async function oneTurn(r) {
  const turn = await running(r);
  const start = starts(r.d).at(-1);
  r.d.end(turn);
  await settled(r);
  return start;
}
/** One host turn whose prompt is answered on its card with `action`; the card. */
async function answered(r, action, request = FIXTURE_PROMPT) {
  const turn = await running(r);
  r.d.prompt(turn, request);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  await r.rt.resolvePermission(r.t.id, card.id, action);
  await until(() => r.d.answers.length === 1, 'the answer');
  r.d.end(turn);
  await settled(r);
  return card;
}

const RULE = 'Bash(echo hi > note.txt)';
/**
 * A host prompt for a gh command, after its call’s line in the turn’s stream, as Claude Code sends one (the recorded
 * call, with this command and ID).
 */
function gh(r, turn, command, id) {
  r.d.append(turn, callLine(FIXTURE_PROMPT).replace(FIXTURE_PROMPT.tool_use_id, id).replace(FIXTURE_PROMPT.input.command, command));
  return { ...FIXTURE_PROMPT, input: { ...FIXTURE_PROMPT.input, command }, tool_use_id: id };
}
/** Keeps an allow rule for a persona on a host, as the permissions panel does. */
const keep = (rt, personaId, hostId, rule) => rt.changePermissionRule({ personaId, behavior: 'allow', rule, where: 'host', hostId });

test('Always allow on a host card keeps the rule for that persona on that host, and the next host turn gets it in --settings', async () => {
  const r = rigIn('auto');
  const card = await answered(r, 'always');
  assert.equal(card.always.saves, RULE);
  // Compared as text, not as a pattern built from the host name (CodeQL’s unescaped-dot rule on #961).
  const where = card.always.lines[0].text;
  assert.ok(where.startsWith('Always allow ') && where.includes(` on ${HOST} (Postbox keeps it`), `the card says where: ${where}`);
  assert.equal(r.d.answers[0].result.behavior, 'allow', 'this call runs now');
  assert.equal(r.d.answers[0].result.updatedPermissions, undefined, 'nothing for the host to save');
  assert.deepEqual(personaOf(r).hostRules, [{ hostId: r.host.id, rule: RULE }]);
  const persona = personaOf(r);
  const folder = await r.rt.adapters.get(persona.backend).folderFor(persona, r.rt.s.projects[r.t.projectId]);
  assert.equal(existsSync(join(folder, '.claude', 'settings.local.json')), false, 'nothing written on this computer');
  assert.deepEqual(allowOf(await oneTurn(r)), [RULE]);
});

test('a rule kept for another host, or for another persona on this host, never reaches this host turn', async () => {
  const r = rigIn('auto');
  const other = r.rt.addHost({ name: 'other.example.com' });
  const p2 = r.rt.createPersona({ handle: 'helper', backend: 'claude-code' });
  r.store.emit('persona', { ...r.rt.persona(p2.id), remote: { hostId: r.host.id } });
  await keep(r.rt, personaOf(r).id, other.id, 'Bash(npm run other:*)');
  await keep(r.rt, p2.id, r.host.id, 'Bash(npm run helper:*)');
  assert.deepEqual(allowOf(await oneTurn(r)), [], 'neither is this persona’s on this host');
  await keep(r.rt, personaOf(r).id, r.host.id, 'Bash(npm test:*)');
  assert.deepEqual(allowOf(await oneTurn(r)), ['Bash(npm test:*)'], 'only its own, for this host');
});

test('the permissions panel lists a host rule with its host, and removing it there drops it from the next turn', async () => {
  const r = rigIn('auto');
  await answered(r, 'always');
  const view = await r.rt.permissionsView({ sessionId: r.se().id });
  assert.deepEqual(view.hostRules, [{ hostId: r.host.id, host: HOST, rule: RULE, current: true }]);
  // Only allow rules are kept for a host.
  await assert.rejects(() => r.rt.changePermissionRule({ sessionId: r.se().id, behavior: 'deny', rule: RULE, where: 'host', hostId: r.host.id }), {
    status: 422,
  });
  const res = await r.rt.changePermissionRule({ sessionId: r.se().id, behavior: 'allow', rule: RULE, where: 'host', hostId: r.host.id, remove: true });
  assert.equal(res.changed, true);
  assert.deepEqual((await r.rt.permissionsView({ sessionId: r.se().id })).hostRules, []);
  assert.deepEqual(allowOf(await oneTurn(r)), []);
});

test('a kept host rule survives a store reload', async () => {
  const dir = tempDir('pb-host-rules-');
  const store = await new Store(dir).load();
  const r = rigIn('auto', { store });
  await answered(r, 'always');
  r.rt.remote.close();
  await store.close();
  const again = await new Store(dir).load();
  const r2 = rig({ store: again });
  assert.deepEqual(personaOf(r2).hostRules, [{ hostId: r2.host.id, rule: RULE }]);
  assert.deepEqual(allowOf(await oneTurn(r2)), [RULE]);
  r2.rt.remote.close();
  await again.close();
});

test('in Ask me, a write Always allowed on a host card runs on the next host turn there without a card', async () => {
  // Postbox’s write asks stay next to the kept rule in --settings, and an ask rule beats an allow rule in Claude Code,
  // so the host’s Claude Code still asks: Postbox’s write check has to read the host’s kept rules (writePasses).
  const r = rigIn('ask');
  const turn1 = await running(r);
  r.d.prompt(turn1, gh(r, turn1, 'gh pr create --title a --body b', 'toolu_gh_1'));
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.equal(card.always?.saves, 'Bash(gh pr:*)');
  await r.rt.resolvePermission(r.t.id, card.id, 'always');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.d.end(turn1);
  await settled(r);
  const turn = await running(r);
  r.d.prompt(turn, gh(r, turn, 'gh pr create --title z --body y', 'toolu_gh_2'));
  await until(() => r.d.answers.length === 2, 'the second answer');
  const cards = r.store.items(r.t.id).filter((i) => i.kind === 'permission');
  assert.equal(cards.length, 1, 'no second card');
  assert.equal(r.d.answers[1].result.behavior, 'allow');
  r.d.end(turn);
  await settled(r);
});

test('a write Always allowed for another host still gets a card on this one', async () => {
  const r = rigIn('ask');
  const other = r.rt.addHost({ name: 'other.example.com' });
  keep(r.rt, personaOf(r).id, other.id, 'Bash(gh pr:*)');
  const turn = await running(r);
  r.d.prompt(turn, gh(r, turn, 'gh pr create --title a --body b', 'toolu_gh_3'));
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  assert.equal(r.d.answers.length, 0);
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  await r.rt.resolvePermission(r.t.id, card.id, 'deny');
  r.d.end(turn);
  await settled(r);
});

test('a subagent’s host prompt offers the same Always allow as the agent’s own, named for the subagent', async () => {
  const r = rigIn('auto');
  const sub = FIXTURE_PROMPTS[1];
  const card = await answered(r, 'always', sub);
  assert.ok(card.who, 'the subagent’s card');
  const want = r.rt.alwaysFor(r.se(), { tool: sub.tool_name, input: sub.input, suggestions: undefined, suppressAlways: false, hostId: r.host.id });
  assert.deepEqual(card.always, want);
  assert.deepEqual(allowOf(await oneTurn(r)), ['Bash(echo bye > note2.txt)']);
});

test('a host card’s Always allow names the host of the turn that asked, even once the agent has moved', async () => {
  const r = rigIn('ask');
  const turn = await running(r);
  r.d.prompt(turn, FIXTURE_PROMPT);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.match(card.always.lines[0].text, / on host\.example\.com \(Postbox keeps it/);
  // The words come from the host the card saves under, not from where the persona is placed when they’re drawn.
  r.store.emit('persona', { ...personaOf(r), remote: null });
  const req = { tool: 'Bash', input: FIXTURE_PROMPT.input, suggestions: undefined, suppressAlways: false };
  assert.match(r.rt.alwaysFor(r.se(), { ...req, hostId: r.host.id }).lines[0].text, / on host\.example\.com \(Postbox keeps it/);
  r.store.emit('persona', { ...personaOf(r), remote: { hostId: r.host.id } });
  assert.match(r.rt.alwaysFor(r.se(), req).lines[0].text, / in this folder \(\.claude\/settings\.local\.json\)$/);
  await r.rt.resolvePermission(r.t.id, card.id, 'deny');
  r.d.end(turn);
  await settled(r);
});

test('a hostile rule is kept and sent as data: quotes, <, &, NUL and the longest a rule may be stay one string in valid JSON', async () => {
  const r = rigIn('auto');
  const head = 'Bash(echo "a<b>&c\u0000\\" \' ';
  const rule = `${head}${'x'.repeat(500 - head.length - 1)})`;
  assert.equal(rule.length, 500);
  await keep(r.rt, personaOf(r).id, r.host.id, rule);
  const start = await oneTurn(r);
  const raw = start.argv[start.argv.indexOf('--settings') + 1];
  assert.equal(raw.includes('\u0000'), false, 'JSON escapes the NUL, so no argument carries one');
  assert.deepEqual(allowOf(start), [rule]);
  // Longer than any rule, or two lines, is refused, and nothing is kept.
  await assert.rejects(() => keep(r.rt, personaOf(r).id, r.host.id, `${rule.slice(0, -1)}xx)`), { status: 422 });
  await assert.rejects(() => keep(r.rt, personaOf(r).id, r.host.id, 'Bash(a\nb)'), { status: 422 });
  assert.deepEqual(
    personaOf(r).hostRules.map((x) => x.rule),
    [rule],
  );
});

test('a turn on this computer never gets a rule kept for a host', async () => {
  const runs = [];
  const LINES = fixtureLines('block');
  const spawnImpl = (_bin, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
    runs.push(args);
    setImmediate(() => {
      for (const l of LINES) child.stdout.write(`${l}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 5);
    });
    return child;
  };
  const work = tempDir('pb-host-rules-local-');
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: work, spawnImpl })),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts: fakeHosts(createFakeDaemon({ autoEnd: false })),
  });
  store.emit('project', { id: 'p1', name: 'P', folder: work });
  const host = rt.addHost({ name: HOST });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code' });
  await keep(rt, p.id, host.id, RULE);
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'hi' });
  await until(() => runs.length === 1, 'the local turn');
  await until(() => !rt.turns.size && !rt.exiting.size, 'the turn to end');
  assert.equal(settingsOf(runs[0]).permissions?.allow, undefined);
  assert.equal(runs[0].includes(RULE), false);
  rt.remote.close();
});
