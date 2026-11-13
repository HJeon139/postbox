// #780's UAT triggers: an agent showed a review block with two or more images from its folder, and its draft names
// each, so Preview draws them; one for an agent on this computer, one for an agent on a host. Read from a room's items
// and sessions, as a run records them, made by a real Runtime over MCP (tests/review-files-fixture.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { onTool } from '../server/remote/turns-tools.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import * as arrange from './arrange.mjs';
import { png, reviewBlock, setup } from './review-files-fixture.mjs';

const HOSTS = { hosts: [{ label: 'host1', id: 'host_1' }], placement: { alpha: 'host1' } };
const factsOf = (f, hosts) => ({
  threads: [f.t.id],
  state: { items: { [f.t.id]: f.store.items(f.t.id) }, sessions: f.rt.store.state.sessions },
  ...(hosts ? { hosts } : {}),
});
const local = (facts) => TRIGGERS['review-figures-shown'].run(facts);
const remote = (facts) => TRIGGERS['host-review-figures-shown'].run(facts);

const TWO = [{ path: 'figs/a.png' }, { name: 'trend.png', path: 'figs/b.png' }];
const BOTH = '# Draft\n\n![Today](figs/a.png)\n\nAnd the trend:\n\n![Trend](trend.png)';

/** A room whose agent made two figures in its folder. */
async function withFigures() {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/a.png'), png(64, 48));
  await writeFile(join(f.folder, 'figs/b.png'), png(32, 32));
  return f;
}

/** Shows a block from a host, as server/remote/turns.mjs applies the daemon's call, in a turn Postbox recorded as remote. */
async function fromHost(f, name, args) {
  return f.during(async () => {
    const live = arrange.liveTurn(f.rt, f.se.id);
    arrange.setSession(f.rt, f.se.id, { remoteTurn: { hostId: 'host_1', turn: 't_host', rtTurn: live.id, state: 'running' } });
    const replies = [];
    const link = { send: (m) => replies.push(m) > 0 };
    const rts = { rt: f.rt, byTurn: new Map([['t_host', { sessionId: f.se.id, rt: live }]]), needed: new Map([['host_1', { link }]]) };
    await onTool(/** @type {any} */ ({ ...rts, applying: new Set(), restoring: new Map(), now: () => 1000 }), 'host_1', {
      turn: 't_host',
      id: 'c_1',
      name,
      args,
    });
    return replies[0];
  });
}
const hostFiles = (files) => files.map((x) => ({ name: x.name ?? x.path.split('/').pop(), path: x.path }));

test('review-figures-shown fires for a local review with two figures, each named in its draft, and is registered', async () => {
  const f = await withFigures();
  const r = await f.call('show_block', reviewBlock('figs', TWO, BOTH));
  assert.equal(r.isError, false, r.text);
  const [hit, ...rest] = local(factsOf(f));
  assert.match(hit.evidence, /@alpha’s review .* shows 2 figures: a\.png, trend\.png/);
  assert.deepEqual(rest, []);
  assert.deepEqual(remote(factsOf(f, { ...HOSTS, placement: {} })), [], 'a turn here isn’t a host’s');
});

test('review-figures-shown doesn’t fire for a review with one figure', async () => {
  const f = await withFigures();
  await f.call('show_block', reviewBlock('one', [{ path: 'figs/a.png' }], '![Today](figs/a.png)'));
  assert.equal(f.review('one').files.length, 1);
  assert.deepEqual(local(factsOf(f)), []);
});

test('review-figures-shown doesn’t fire when the draft names only one of its two files', async () => {
  const f = await withFigures();
  await f.call('show_block', reviewBlock('half', TWO, '![Today](figs/a.png)\n\nThe trend is in b.png and figs/b.png, not shown.'));
  assert.equal(f.review('half').files.length, 2);
  assert.deepEqual(local(factsOf(f)), []);
});

test('review-figures-shown doesn’t fire for a review with no files', async () => {
  const f = await withFigures();
  await f.call('show_block', reviewBlock('none', undefined, BOTH));
  assert.equal(f.review('none').files, undefined);
  assert.deepEqual(local(factsOf(f)), []);
});

test('review-figures-shown needs each file kept with its SHA-256 and an image type', async () => {
  const f = await withFigures();
  await f.call('show_block', reviewBlock('figs', TWO, BOTH));
  const facts = factsOf(f);
  const it = facts.state.items[f.t.id].find((x) => x.block?.id === 'figs');
  for (const broken of [{ sha256: undefined }, { type: 'image/svg+xml' }]) {
    const files = it.files.map((x, i) => (i === 1 ? { ...x, ...broken } : x));
    const items = facts.state.items[f.t.id].map((x) => (x === it ? { ...x, files } : x));
    assert.deepEqual(local({ ...facts, state: { ...facts.state, items: { [f.t.id]: items } } }), [], JSON.stringify(broken));
  }
});

test('host-review-figures-shown fires for the same review from a host, and review-figures-shown doesn’t', async () => {
  const f = await withFigures();
  const r = await fromHost(f, 'show_block', reviewBlock('figs', hostFilesB64(), BOTH));
  assert.equal(r.ok, true, r.text);
  const [hit, ...rest] = remote(factsOf(f, HOSTS));
  assert.match(hit.evidence, /@alpha’s review .*, from host1, shows 2 figures: a\.png, trend\.png/);
  assert.deepEqual(rest, []);
  assert.deepEqual(local(factsOf(f, HOSTS)), [], 'a host’s turn isn’t this computer’s');
  assert.equal(TRIGGERS['host-review-figures-shown'].recorded(factsOf(f)), false, 'a run without hosts can’t show it');
});

/** The two figures as a host's broker sends them: name, path and base64. */
function hostFilesB64() {
  const bytes = { 'figs/a.png': png(64, 48), 'figs/b.png': png(32, 32) };
  return hostFiles(TWO).map((x) => ({ ...x, base64: bytes[x.path].toString('base64') }));
}

test('the reviewfigures scenario’s phases are there to cause each, here and on a host', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/reviewfigures.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [['review-figures-shown'], ['host-review-figures-shown']],
  );
});
