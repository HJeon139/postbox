// Turns is the one way a turn starts (designs/architecture/services.md, “Delivery and Turns, built as the inbox”: “No
// one else starts a turn”). The runtime keeps no deliver of its own, no server module calls one, and an agent’s
// waiting entries start its turn through Turns’ start. Turns reaches waiting code only through its `asks` port, and a
// card that opens tells Turns with `card.opened` (“Calls into waiting code”).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const SERVER = new URL('../server/', import.meta.url).pathname;
/** Every .mjs under server/, by its path there. @param {string} [dir] @returns {string[]} */
function sources(dir = SERVER) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.isDirectory()) return sources(join(dir, d.name));
    return d.name.endsWith('.mjs') ? [join(dir, d.name)] : [];
  });
}

test('#1429 the runtime has no deliver, and no server module starts a turn but through Turns', () => {
  const { rt } = setup();
  assert.equal(/** @type {any} */ (rt).deliver, undefined);
  const callers = sources().filter((p) => /\brt\.deliver\(/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(callers, []);
});

test('#1429 only Turns imports the turn builder (turn-run.mjs)', () => {
  const importers = sources().filter((p) => /from '\.{1,2}\/(?:[\w-]+\/)*turn-run\.mjs'/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(
    importers.map((p) => p.slice(SERVER.length)),
    ['turn-service.mjs'],
  );
});

/** Turns’ own modules: server/turns.mjs and server/turn-*.mjs. */
const turnsModules = () => sources().filter((p) => /^turns?(?:-[\w-]+)?\.mjs$/.test(p.slice(SERVER.length)));
/** Host turns (server/remote/turns*.mjs) and the restart sweep, which start and resume turns too. */
const hostAndSweep = () => sources().filter((p) => /^(?:remote\/turns[\w-]*|restart-sweep)\.mjs$/.test(p.slice(SERVER.length)));
/**
 * What a module calls of the permission layer and the needs, the waiting code Turns reaches only through its `asks`
 * port: each waiting module it imports, and each permission method it calls on the Runtime. @param {string} src
 */
function waitingCalls(src) {
  const imports = [...src.matchAll(/from '\.{1,2}\/((?:permission[\w-]*|card-needs|ask-question|tool-ask|prompt-claim|wake-cards)\.mjs)'/g)];
  const calls = [...src.matchAll(/\brt\.(requestPermission|recordDenial|settlePermission|permissionWaits)\b/g)];
  return [...new Set([...imports.map((m) => m[1]), ...calls.map((m) => `rt.${m[1]}`)])].sort();
}
/**
 * Host turns and the restart sweep still reach waiting code directly; routing them through `asks` is pending
 * (designs/architecture/services.md, Turns: “Calls into waiting code”). The list only shrinks: a new import fails.
 */
const PENDING = {
  'remote/turns-prompts.mjs': [
    'card-needs.mjs',
    'permission-expiry.mjs',
    'permission-prompt.mjs',
    'prompt-claim.mjs',
    'rt.permissionWaits',
    'rt.requestPermission',
    'rt.settlePermission',
  ],
  'remote/turns-resume.mjs': ['rt.permissionWaits'],
  'remote/turns-start.mjs': ['permission-prompt.mjs'],
  'restart-sweep.mjs': ['card-needs.mjs'],
};

test('#1429 Turns reaches the permission layer and the needs only through its asks port', () => {
  /** @type {Record<string, string[]>} */
  const direct = {};
  for (const p of [...turnsModules(), ...hostAndSweep()]) {
    const calls = waitingCalls(readFileSync(p, 'utf8'));
    if (calls.length) direct[p.slice(SERVER.length)] = calls;
  }
  assert.deepEqual(direct, PENDING, 'the laptop’s Turns modules call none; host turns and the sweep only what’s pending');
});

test('#1429 a card that opens raises card.opened, and Turns closes the turn’s reply segment', () => {
  // The reply’s own streaming closes a segment at a boundary; no card does.
  const callers = sources().filter((p) => !turnsModules().includes(p) && /\brt\.closeSegment\(/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(
    callers.map((p) => p.slice(SERVER.length)),
    ['reply-segment.mjs'],
    'no waiting code closes a turn’s segment itself',
  );
  const { rt, store, t, beta } = setup();
  const it = arrange.post(rt, t.id, { kind: 'agent', sessionId: beta.id, handle: 'beta', text: 'So far.', status: 'gen' });
  const turn = { threadId: t.id, segment: it.id, openSegment: it.id };
  rt.bus.emit('card.opened', { turn });
  assert.equal(store.item(t.id, it.id).status, 'done');
  assert.deepEqual([turn.segment, turn.openSegment], [null, null]);
});

test('#1429 an agent’s waiting entries start its turn through Turns’ start', async () => {
  const { rt, t, beta } = setup();
  const started = [];
  const start = rt.turnService.start.bind(rt.turnService);
  rt.turnService.start = (sessionId) => {
    started.push(sessionId);
    start(sessionId);
  };
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.deepEqual(started, [beta.id]);
});
