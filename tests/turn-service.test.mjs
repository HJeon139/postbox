// Turns is the one way a turn starts (designs/architecture/services.md, “Delivery and Turns, built as the inbox”: “No
// one else starts a turn”). The runtime keeps no deliver of its own, no server module calls one, and an agent’s
// waiting entries start its turn through Turns’ start.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
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
