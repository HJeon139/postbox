// Postbox’s messages to the daemon’s broker (#120): the snapshot, answers and replies, and what the broker sends
// again after each Postbox hello.

import { REMOTE_READ_TIMEOUT_MS } from '../../../shared/limits.mjs';
import { endPrompt, onAnswer, orphaned, promptBody } from './broker-prompts.mjs';
import { ended, exists, note } from './broker-records.mjs';
import { saveSnapshot, snapshotItems } from './broker-snapshot.mjs';
import { CANCELED } from './broker-state.mjs';
import { armReadTimer, onReply, settled, settleOffline, toolBody } from './broker-tools.mjs';

/** @typedef {import('./broker-state.mjs').Broker} Broker */

/**
 * snapshot, snapshot-items, answer and reply; false for any other.
 * @param {Broker} b @param {any} m
 * @param {{ send: (type: string, body: Record<string, unknown>) => void, fail: (code: string, text: string) => void }} reply
 */
export async function onMessage(b, m, reply) {
  switch (m.type) {
    case 'snapshot':
      await saveSnapshot(b, m.turn, { turn: m.turn, home: m.home, threads: m.threads });
      return true;
    case 'snapshot-items':
      await snapshotItems(b, m, reply);
      return true;
    case 'answer':
      await onAnswer(b, m, reply);
      return true;
    case 'reply':
      await onReply(b, m, reply);
      return true;
  }
  return false;
}

/**
 * After each welcome: everything still waiting for Postbox, again. A prompt whose turn has ended can’t be answered,
 * nor one no shim waits for (orphaned), so it’s ended instead.
 * @param {Broker} b @param {(type: string, body: Record<string, unknown>) => void} send
 */
export async function onHello(b, send) {
  const turns = new Set([...b.tools.values(), ...b.prompts.values(), ...b.expiries.values()].map((x) => x.turn));
  const gone = new Set();
  const over = new Set();
  for (const turn of turns) {
    if (!(await exists(b.p.turn(turn)))) gone.add(turn);
    else if (await ended(b, turn)) over.add(turn);
  }
  // A folder that went (H5’s cleanup) takes its records with it.
  for (const map of [b.tools, b.prompts, b.expiries]) for (const [k, x] of map) if (gone.has(x.turn)) map.delete(k);
  await Promise.all(
    [...b.prompts.values()]
      .filter((q) => !q.answer && (over.has(q.turn) || orphaned(b, q)))
      .map((q) => endPrompt(b, q.turn, q.id, b.now(), over.has(q.turn) ? CANCELED : 'expired', true)),
  );
  for (const t of b.tools.values()) {
    if (!settled(t)) {
      if (t.route === 'read') {
        const elapsed = Math.max(0, b.now() - (t.arrived ?? b.now()));
        if (elapsed >= REMOTE_READ_TIMEOUT_MS) {
          settleOffline(b, t).catch(b.log);
          continue;
        }
      }
      send('tool', toolBody(t));
      if (t.route === 'read') armReadTimer(b, t);
    }
  }
  for (const q of b.prompts.values()) if (!q.answer) send('prompt', promptBody(q));
  for (const [k, x] of [...b.expiries]) {
    send('prompt-expired', { id: x.id, turn: x.turn, at: x.at, reason: x.reason });
    b.expiries.delete(k);
    note(b, x.turn, 'prompts', { op: 'expiry-sent', id: x.id });
  }
}
