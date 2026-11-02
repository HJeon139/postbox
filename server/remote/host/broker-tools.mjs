// The broker’s tool calls (#120): a shim’s call answered by its route (TOOL_ROUTES), from the snapshot, or written
// down and sent to Postbox once it’s checked and its files are read as the laptop would; and Postbox’s reply to it.
// broker.mjs’s header says what’s written down when.

import { validateBlock } from '../../../shared/catalog.mjs';
import { encodedBytes, REMOTE_LIMITS, TOOL_ROUTES, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { inlineAppFiles } from './broker-files.mjs';
import { armReadTimer, claim, detached, readLocal, settled, settleOffline } from './broker-offline.mjs';
import { record, refusal, startOf, unrecorded, written } from './broker-records.mjs';
import { key, QUEUED_TEXT, toShims } from './broker-state.mjs';

/**
 * @typedef {import('./broker-state.mjs').Broker} Broker
 * @typedef {import('./broker-state.mjs').Tool} Tool
 * @typedef {import('./broker-state.mjs').ShimConn} ShimConn
 * @typedef {import('./broker-files.mjs').Prepared} Prepared
 */

/** @param {Tool} t */
export const toolBody = (t) => ({ turn: t.turn, id: t.id, name: t.name, args: t.args ?? {} });

/**
 * A call for Postbox: shown, checked or read from the agent’s folder as the laptop would before it’s queued.
 * @param {Broker} b @param {string} turn @param {string} name @param {Record<string, any>} args @returns {Promise<Prepared>}
 */
export async function prepare(b, turn, name, args) {
  if (name === 'add_dataset')
    return {
      ok: false,
      text: 'Loading a dataset isn’t supported yet for an agent on a remote host: add_dataset reads a file on Postbox’s own computer, which this host can’t reach, so nothing was loaded.',
    };
  let out = args;
  if (name === 'show_app' || name === 'update_app') {
    const start = await startOf(b, turn);
    if (!start) return { ok: false, text: `There’s no turn ${turn} on this host.` };
    const r = await inlineAppFiles(start.folder, args);
    if (!r.ok) return r;
    out = r.args;
  }
  // Only what the laptop would refuse outright is refused here; an invalid show_block or show_app still goes, since
  // the laptop shows its fallback text (server/runtime.mjs’s show_block).
  if (name === 'update_block') {
    const v = validateBlock(out.block);
    if (!v.ok) return { ok: false, text: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
  }
  if (name === 'update_app' && typeof out.code === 'string') {
    const v = validateBlock({
      id: out.id,
      type: 'app',
      version: 1,
      fallback: 'x',
      code: out.code,
      ...(out.permissions ? { permissions: out.permissions } : {}),
    });
    if (!v.ok) return { ok: false, text: `The update was invalid: ${v.errors.join(' ')}` };
  }
  const size = encodedBytes({ type: 'tool', turn, id: 'x'.repeat(128), name, args: out });
  if (size > REMOTE_LIMITS.lineBytes)
    return {
      ok: false,
      text: `${name} comes to ${(size / 1024 / 1024).toFixed(1)} MiB once its files are read, over the ${REMOTE_LIMITS.lineBytes / 1024 / 1024} MiB one call from this host to Postbox can carry. Send fewer or smaller files.`,
    };
  return { ok: true, args: out };
}

/** A call’s tool message, encoded, in bytes. @param {string} turn @param {string} name @param {Record<string, any>} args */
export const toolBytes = (turn, name, args) => encodedBytes({ type: 'tool', turn, id: 'x'.repeat(128), name, args });
const mib = (/** @type {number} */ n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Why a turn can’t queue another call, or '': it has as many waiting for Postbox, or as many bytes of them, as the
 * host keeps (queueLimits, REMOTE_LIMITS), or its record of calls, which a restart reads whole, is full.
 * @param {Broker} b @param {string} turn @param {string} name @param {number} bytes
 */
async function queueFull(b, turn, name, bytes) {
  const waiting = [...b.tools.values()].filter((t) => t.turn === turn && !t.replied);
  const held = waiting.reduce((n, t) => n + (t.bytes ?? 0), 0);
  if (waiting.length >= b.queueLimits.calls || held + bytes > b.queueLimits.bytes)
    return `This turn already has ${waiting.length} calls (${mib(held)}) waiting for Postbox, as many as this host keeps, so ${name} wasn’t sent. Once Postbox is connected and has taken them, call it again.`;
  const size = await b.io.stat(b.p.turn(turn, TURN_FILES.tools)).then(
    (st) => st.size,
    () => 0,
  );
  if (size + bytes > b.queueLimits.recordBytes)
    return `This turn’s record of its calls on this host has reached ${mib(b.queueLimits.recordBytes)}, the most it keeps, so ${name} wasn’t sent. Finish this turn and carry on in the next.`;
  return '';
}

/**
 * Runs fn after the turn’s calls already being admitted, so their checks and takes don’t interleave.
 * @template T @param {Broker} b @param {string} turn @param {() => Promise<T>} fn @returns {Promise<T>}
 */
function admit(b, turn, fn) {
  const next = (b.admitting.get(turn) ?? Promise.resolve()).then(fn);
  const settled = next.then(
    () => {},
    () => {},
  );
  b.admitting.set(turn, settled);
  settled.then(() => {
    if (b.admitting.get(turn) === settled) b.admitting.delete(turn);
  });
  return next;
}

/**
 * Takes a call into the turn’s queue, or says why not: checked and taken in one step per turn, since the turn’s shims
 * send at once and each would otherwise count the calls waiting before any of the others was taken. 'again' when
 * another shim of the turn sent the same call meanwhile.
 * @param {Broker} b @param {string} k @param {Tool} t @returns {Promise<string>}
 */
const take = (b, k, t) =>
  admit(b, t.turn, async () => {
    if (b.tools.has(k)) return 'again';
    // A read with no Postbox to ask is answered from the snapshot at once, so no limit applies to it: nothing is queued
    // for Postbox, and nothing is written to the journal (settle.md).
    const full = detached(b, t) ? '' : await queueFull(b, t.turn, t.name, t.bytes ?? 0);
    if (!full) b.tools.set(k, t);
    return full;
  });

/** An already answered or queued call sent again after a reconnect. @param {Tool} known */
function answerKnown(known) {
  if (known.route === 'queue') return { ok: true, text: QUEUED_TEXT };
  if (known.result) return { ok: known.result.ok, text: known.result.text };
  if (known.replied)
    return { ok: false, text: `Postbox answered ${known.name} before this host’s daemon restarted, but the answer wasn’t kept. Call it again.` };
  return null;
}

/**
 * Takes a call, records it, and sends it to Postbox.
 * @param {Broker} b @param {string} k @param {Tool} t @param {(ok: boolean, text: string) => void} result
 */
async function queueTool(b, k, t, result) {
  const admitted = await take(b, k, t);
  // Another of the turn’s shims sent the call meanwhile: try again.
  if (admitted === 'again') return 'again';
  if (admitted) {
    b.log(`Turn ${t.turn}’s ${t.name} (${t.id}) was refused: ${admitted}`);
    return result(false, admitted);
  }
  // A read with no Postbox to ask is answered at once and not journaled: a resend reads the snapshot again.
  if (detached(b, t)) return settleOffline(b, t);
  // Written down before the shim hears it, so on restart it replays.
  t.saved = record(b, t.turn, 'tools', { op: 'call', id: t.id, name: t.name, route: t.route, args: t.args, at: t.arrived }).then(
    () => '',
    (e) => unrecorded(t.name, e),
  );
  const saved = await t.saved;
  if (saved) {
    if (b.tools.get(k) === t) b.tools.delete(k);
    // A read answered offline meanwhile has been answered: one result per call.
    return settled(t) ? undefined : result(false, saved);
  }
  if (settled(t)) return; // settled while the call record was written
  if (detached(b, t)) return settleOffline(b, t);
  if (t.route === 'queue') result(true, QUEUED_TEXT);
  if (t.route === 'read') armReadTimer(b, t);
  b.toPostbox('tool', toolBody(t));
}

/** A shim’s tool call. @param {Broker} b @param {ShimConn} c @param {string} turn @param {any} m */
export async function call(b, c, turn, m) {
  const arrived = b.now();
  const result = (ok, text) => c.send('result', { id: m.id, ok, text: text.slice(0, REMOTE_LIMITS.replyChars) });
  const no = await refusal(b, turn);
  if (no) {
    result(false, no.text);
    return c.send('error', { code: no.code, message: no.text });
  }
  const route = TOOL_ROUTES[/** @type {keyof typeof TOOL_ROUTES} */ (m.name)];
  if (route === 'host') {
    const r = await readLocal(b, turn, m.name, m.args, false);
    return result(r.ok, r.text);
  }
  const k = key(turn, m.id);
  // Sent again after a reconnect: return the kept answer, or wait if it hasn’t settled.
  const known = b.tools.get(k);
  if (known) {
    if (known.route === 'read' && known.result) return result(known.result.ok, known.result.text); // no wait on a disk
    const saved = await known.saved;
    if (saved) return result(false, saved);
    const ans = answerKnown(known);
    if (ans) return result(ans.ok, ans.text);
    // An open read resent while disconnected: answered from the snapshot through settleOffline, which answers every shim.
    if (route === 'read' && !b.attached() && !settled(known)) return void settleOffline(b, known);
    return;
  }
  if (route === 'ask' && !b.attached() && m.name !== 'add_dataset')
    return result(false, `Postbox isn’t connected to this host right now, so ${m.name} can’t run. Try again once Postbox is open and connected.`);
  const r = await prepare(b, turn, m.name, m.args);
  if (!r.ok) {
    b.log(`Turn ${turn}’s ${m.name} (${m.id}) was refused: ${r.text}`);
    return result(false, r.text);
  }
  const bytes = toolBytes(turn, m.name, r.args);
  /** @type {Tool} */
  const t = { turn, id: m.id, name: m.name, route: /** @type {'queue' | 'ask' | 'read'} */ (route), args: r.args, replied: false, bytes, arrived };
  if ((await queueTool(b, k, t, result)) === 'again') return call(b, c, turn, m);
}

/**
 * Postbox’s reply to a call.
 * @param {Broker} b @param {any} m @param {{ fail: (code: string, text: string) => void }} reply
 */
export async function onReply(b, m, reply) {
  const k = key(m.turn, m.id);
  const t = b.tools.get(k);
  // A taken call gets no second answer: dropped at once, not awaited (settle.md §5).
  if (!t || settled(t)) {
    reply.fail('no-tool', `There’s no tool call ${m.id} waiting in turn ${m.turn}.`);
    return;
  }
  // Written down before it’s taken or the shim hears it: an asked call’s answer is kept, with its text, for a
  // shim that sends the call again after the daemon restarts. One that can’t be written leaves the call waiting.
  const release = claim(t);
  const why = await written(b, m.turn, 'tools', { op: 'reply', id: t.id, ok: m.ok, ...(t.route === 'ask' || t.route === 'read' ? { text: m.text } : {}) });
  release();
  if (why) {
    reply.fail(
      'internal',
      `Postbox’s daemon on this host couldn’t write down the reply to call ${t.id} in turn ${m.turn}, so it wasn’t taken: ${why}. Reply again.`,
    );
    // The link may have dropped during the write: settleOffline saw settled(t) and returned, so settle now (settle.md §5).
    if (!b.attached()) {
      if (t.route === 'read') settleOffline(b, t).catch(b.log);
    } else armReadTimer(b, t);
    return;
  }
  t.replied = true;
  t.args = null;
  if (t.timer) {
    b.timers.clearTimeout(t.timer);
    t.timer = undefined;
  }
  if (t.route === 'ask' || t.route === 'read') {
    t.result = { ok: m.ok, text: m.text };
    toShims(b, m.turn, 'result', { id: t.id, ok: m.ok, text: m.text });
  } else if (!m.ok) b.log(`Postbox refused turn ${m.turn}’s ${t.name} (${t.id}): ${m.text}`);
}
