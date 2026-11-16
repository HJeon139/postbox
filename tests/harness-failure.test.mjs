// One classifier of a harness’s failures (#466, #467, #442): network loss and quota, read from the marks each adapter
// puts on the error it throws. The quota events below follow each harness’s documented shapes; none is a recording,
// since no recorded turn has run out of quota yet. agy’s result is the one #396 quotes from the “Agent research” room,
// and Kiro’s error is the one #467 quotes.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { kiroError } from '../server/adapters/kiro-errors.mjs';
import { failureClass, NETWORK_CODES, withQuota } from '../server/harness-failure.mjs';

/** A turn context whose callbacks do nothing. @param {any} [over] */
const quietCtx = (over = {}) =>
  new Proxy(
    { state: {}, persona: { handle: 'x', model: 'm', permissionMode: 'ask', tools: [] }, handles: ['x'], signal: new AbortController().signal, ...over },
    { get: (t, k) => (k in t ? t[/** @type {any} */ (k)] : () => {}) },
  );

test('#466 a network code anywhere in an error’s causes, or an unreachable host, is network loss', () => {
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.deepEqual(failureClass(new Error('The turn failed.', { cause: new Error('fetch failed', { cause: reset }) })), { kind: 'network' });
  assert.deepEqual(failureClass(Object.assign(new Error('Postbox couldn’t reach the host.'), { kind: 'unreachable' })), { kind: 'network' });
  assert.equal(failureClass(new Error('The model refused.')), null);
  assert.equal(failureClass(null), null);
});

test('#467 Kiro’s JSON-RPC error for a dropped network is network loss', () => {
  const err = kiroError('Kiro couldn’t run the turn: Internal error (code -32603): {"details":"read EADDRNOTAVAIL"}');
  assert.deepEqual(failureClass(err), { kind: 'network' });
});

test('#442 a quota mark is quota, with its reset time when the harness gave one', () => {
  assert.deepEqual(failureClass(withQuota(new Error('Out of quota.'), { until: 1792741200000 })), { kind: 'quota', until: 1792741200000 });
  assert.deepEqual(failureClass(new Error('The turn failed.', { cause: withQuota(new Error('Out.'), { until: null }) })), { kind: 'quota', until: null });
  assert.equal(failureClass(withQuota(new Error('Fine.'), null)), null);
});

test('#467 only the classifier lists the network codes: the scheduled wakes and Kiro use its list', () => {
  const server = new URL('../server/', import.meta.url).pathname;
  /** Every .mjs under a folder. @param {string} dir @returns {string[]} */
  const sources = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      if (d.isDirectory()) return sources(join(dir, d.name));
      return d.name.endsWith('.mjs') ? [join(dir, d.name)] : [];
    });
  const listing = sources(server).filter((p) =>
    NETWORK_CODES.some((code) => readFileSync(p, 'utf8').includes(`'${code}'`) || readFileSync(p, 'utf8').includes(`|${code}`)),
  );
  assert.deepEqual(
    listing.map((p) => p.slice(server.length)),
    ['harness-failure.mjs'],
  );
});

test('#442 Claude Code: a rejected rate limit is the turn’s quota, until its resetsAt', () => {
  const m = createStreamMapper(quietCtx());
  m.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792741200, rateLimitType: 'five_hour' } });
  assert.equal(m.quota, null);
  m.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792741200, rateLimitType: 'five_hour' } });
  assert.deepEqual(m.quota, { until: 1792741200000 });
});

test('#396 Antigravity: RESOURCE_EXHAUSTED is the turn’s quota, until the reset its error counts down to', () => {
  const m = createAgyMapper(quietCtx(), { now: () => 1000 });
  m.push({
    event: 'result',
    result: { status: 'RESOURCE_EXHAUSTED', error: 'Individual quota reached for gemini-4-argon-medium. Resets in 155h28m23s.' },
  });
  assert.match(m.error ?? '', /Individual quota reached/);
  assert.deepEqual(m.quota, { until: 1000 + ((155 * 60 + 28) * 60 + 23) * 1000 });
});

test('#442 Codex: a usage limit error is the turn’s quota, with no reset time', () => {
  const m = createCodexMapper(quietCtx());
  const r = m.push({ method: 'error', params: { error: { message: 'You’ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } });
  assert.deepEqual(r, { error: 'You’ve hit your usage limit.', quota: { until: null } });
  const other = m.push({ method: 'error', params: { error: { message: 'Something else.' } } });
  assert.deepEqual(other, { error: 'Something else.' });
});
