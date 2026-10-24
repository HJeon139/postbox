// The broker’s permission prompts (#120): a shim’s prompt written down and sent to Postbox, Postbox’s answer written
// down and sent to the turn’s shims, and a prompt’s end, when its shim gave up, its turn stopped, or no shim waits on
// it any more. broker.mjs’s header says what’s written down when.

import { HOST_DEFAULTS, REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { note, record, refusal, unrecorded, written } from './broker-records.mjs';
import { CANCELED, key, STOPPED_TEXT, toShims } from './broker-state.mjs';

/**
 * @typedef {import('./broker-state.mjs').Broker} Broker
 * @typedef {import('./broker-state.mjs').Prompt} Prompt
 * @typedef {import('./broker-state.mjs').Expiry} Expiry
 * @typedef {import('./broker-state.mjs').ShimConn} ShimConn
 */

/** @param {Prompt} q */
export const promptBody = (q) => ({ id: q.id, turn: q.turn, request: q.request });
/** Sends an expiry if Postbox is attached; it waits for the next hello if not. @param {Broker} b @param {Expiry} x */
export function sendExpiry(b, x) {
  const k = key(x.turn, x.id);
  b.expiries.set(k, x);
  if (b.toPostbox('prompt-expired', { id: x.id, turn: x.turn, at: x.at, reason: x.reason })) {
    b.expiries.delete(k);
    note(b, x.turn, 'prompts', { op: 'expiry-sent', id: x.id });
  }
}
/**
 * Ends a prompt nobody can answer any more: it’s recorded, dropped, and Postbox hears now, or with the rest of a
 * hello’s resend (`later`). It’s written down before Postbox hears, so a restart right after doesn’t show the prompt
 * again. One that can’t be written down still ends (record logged why): the shim, or the turn, has given up on it.
 * But a restart would show it again, so Postbox isn’t told it’s over as if that were kept: it hears an error, and the
 * prompt is kept in memory as ended, so it can’t be answered or sent again (unrecordedEnds).
 * @param {Broker} b @param {string} turn @param {string} id @param {number} at @param {Expiry['reason']} reason
 */
export async function endPrompt(b, turn, id, at, reason, later = false) {
  const why = await written(b, turn, 'prompts', { op: 'expired', id, at, reason });
  const k = key(turn, id);
  const q = b.prompts.get(k);
  if (q) q.over = true;
  b.prompts.delete(k);
  if (why) {
    b.unrecordedEnds.add(k);
    const what = reason === CANCELED ? 'was canceled' : 'expired';
    b.toPostbox('error', {
      code: 'internal',
      re: 'prompt-expired',
      turn,
      id,
      message:
        `Postbox’s daemon on this host couldn’t write down that prompt ${id} in turn ${turn} ${what}: ${why}. It can’t be answered any more; if the daemon restarts, it may show as waiting until the host’s permissionWaitMax from when it was asked.`.slice(
          0,
          REMOTE_LIMITS.messageChars,
        ),
    });
    return;
  }
  if (later) b.expiries.set(k, { turn, id, at, reason });
  else sendExpiry(b, { turn, id, at, reason });
}
/** How long a shim waits on a prompt, and the daemon on a Codex request, in milliseconds. @param {Broker} b */
export const waitMax = (b) => Number(b.settings().permissionWaitMax ?? HOST_DEFAULTS.permissionWaitMax);
/**
 * A prompt read back at start that no shim has sent again, past permissionWaitMax from when it was asked: no shim
 * still waits for it (each gives up by then, from when it asked, which is before the record), so it’s ended.
 * @param {Broker} b @param {Prompt} q
 */
export const orphaned = (b, q) => Boolean(q.replayed) && !q.answer && b.now() >= q.at + waitMax(b);
/** Ends a prompt read back at start once it’s orphaned, unless a shim sends it again first. @param {Broker} b @param {Prompt} q */
export function armOrphan(b, q) {
  if (b.closed) return;
  const t = b.timers.setTimeout(
    () => {
      b.orphanTimers.delete(t);
      if (b.closed || b.prompts.get(key(q.turn, q.id)) !== q || !q.replayed || q.answer) return;
      if (!orphaned(b, q)) return armOrphan(b, q);
      return endPrompt(b, q.turn, q.id, b.now(), 'expired');
    },
    Math.max(0, q.at + waitMax(b) - b.now()),
  );
  b.orphanTimers.add(t);
}

/** A shim’s permission prompt. @param {Broker} b @param {ShimConn} c @param {string} turn @param {any} m */
export async function permission(b, c, turn, m) {
  const no = await refusal(b, turn);
  if (no) return c.send('error', { code: no.code, message: no.text });
  const k = key(turn, m.id);
  const known = b.prompts.get(k);
  /** A prompt that couldn’t be written down is denied, never left waiting or allowed. @param {string} text */
  const deny = (text) => c.send('permission-answer', { id: m.id, result: { behavior: 'deny', message: text.slice(0, REMOTE_LIMITS.messageChars) } });
  if (known) {
    // A shim still waits on it: it ends the prompt itself.
    known.replayed = false;
    const saved = await known.saved;
    if (saved) return deny(saved);
    if (known.answer) c.send('permission-answer', { id: m.id, result: known.answer });
    return;
  }
  if (b.unrecordedEnds.has(k)) return deny(`Permission request ${m.id} has ended already, so it can’t be shown again.`);
  /** @type {Prompt} */
  const q = { turn, id: m.id, request: m.request, answer: null, over: false, at: b.now() };
  b.prompts.set(k, q);
  // Shown only once it’s on disk, as a queued call is acknowledged only then (call).
  q.saved = record(b, turn, 'prompts', { op: 'prompt', id: q.id, request: q.request, at: q.at }).then(
    () => '',
    (e) => unrecorded('this permission request', e),
  );
  const saved = await q.saved;
  if (saved) {
    if (b.prompts.get(k) === q) b.prompts.delete(k);
    return deny(saved);
  }
  if (!q.over) b.toPostbox('prompt', promptBody(q));
}

/**
 * Postbox’s answer to a prompt.
 * @param {Broker} b @param {any} m @param {{ fail: (code: string, text: string) => void }} reply
 */
export async function onAnswer(b, m, reply) {
  const k = key(m.turn, m.prompt);
  // An answer still being written down settles first: this one is then a repeat, or the next try.
  while (b.prompts.get(k)?.answering) await b.prompts.get(k)?.answering;
  const q = b.prompts.get(k);
  if (!q) {
    reply.fail(
      'no-prompt',
      b.unrecordedEnds.has(k)
        ? `Prompt ${m.prompt} in turn ${m.turn} has ended (the agent gave up on it), so it can’t be answered.`
        : `There’s no prompt ${m.prompt} waiting in turn ${m.turn}.`,
    );
    return;
  }
  if (b.stopping.has(m.turn)) {
    reply.fail('no-prompt', `Turn ${m.turn} was stopped, so prompt ${m.prompt} can’t be answered.`);
    return;
  }
  if (!q.answer) {
    // Written down before it’s taken or the shim hears it, so a restart right after neither asks the person
    // again nor gives the harness a different answer. One that can’t be written leaves the prompt waiting.
    q.answering = written(b, m.turn, 'prompts', { op: 'answer', id: q.id, result: m.result });
    const why = await q.answering;
    q.answering = undefined;
    if (why) {
      reply.fail(
        'internal',
        `Postbox’s daemon on this host couldn’t write down the answer to prompt ${q.id} in turn ${m.turn}, so the agent didn’t get it: ${why}. Answer again.`,
      );
      return;
    }
    q.answer = m.result;
    // The shim gave up on it, or the turn stopped, while it was written down.
    if (q.over) {
      reply.fail('no-prompt', `Prompt ${q.id} in turn ${m.turn} ended before its answer reached the agent.`);
      return;
    }
  }
  toShims(b, m.turn, 'permission-answer', { id: q.id, result: q.answer });
}

/**
 * Stop arrived for a turn: its shims are refused from now on, and its prompts can’t be answered.
 * @param {Broker} b @param {string} turn
 */
export async function stopTurn(b, turn) {
  if (b.stopping.has(turn)) return;
  b.stopping.add(turn);
  // Stopping holds in memory even if it isn’t written down; only a restart would forget it.
  await note(b, turn, 'tools', { op: 'stopping', id: '-' });
  for (const s of [...(b.shims.get(turn) ?? [])]) s.send('error', { code: 'turn-ended', message: STOPPED_TEXT });
  await Promise.all([...b.prompts.values()].filter((q) => q.turn === turn && !q.answer).map((q) => endPrompt(b, turn, q.id, b.now(), CANCELED)));
}
