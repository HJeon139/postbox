// The person’s message as it’s posted, Send now’s stop, and what waited on a turn for it to end (#228). The person’s
// message waits for a busy agent as an entry in its inbox since #1404, so there’s no queue of its own here; one stored
// before that becomes entries on start (queue-convert.mjs). One session still runs at most one turn.
import { clip } from './helpers.mjs';

/**
 * Posts the person’s message with who it goes to (to: handles), so another agent reading it later sees it wasn’t
 * addressed to them. The conversation’s chain of hand-offs starts again from it.
 * @param {any} rt @param {string} threadId @param {{ text: string, attachments: any[] }} message @param {string[]} to
 * @param {object} [marks]  what else the item keeps, such as the queue row it was converted from
 */
export function postUserMessage(rt, threadId, { text, attachments }, to, marks = {}) {
  const item = rt.threads.addItem(threadId, { kind: 'user', text, attachments, to, ...marks });
  // The last person to write here is whom its agents’ needs ring from now on (#1742, Sessions’ needAt).
  const by = /** @type {{ personId?: string }} */ (marks).personId;
  rt.threads.patch(rt.threads.conversationToWrite(threadId), { hops: 0, ...(by ? { lastPerson: by } : {}) });
  return { item };
}

/**
 * Send now’s stop: a change of course, so background jobs keep running, each with its own Stop (#129), and the exit is
 * silent, so the person’s message goes alone and the agent’s other entries wait for that turn’s end. A plain Stop still exiting has
 * left turns, so stop() finds nothing to stop: its exit is marked silent here instead (#1040).
 * @param {any} rt @param {string} sessionId
 */
export function stopForSendNow(rt, sessionId) {
  rt.stop(sessionId, { silent: true, jobs: 'keep', sendNow: true });
  const ex = rt.exiting.get(sessionId);
  if (ex) ex.silent = true;
}

export function takePending(rt, se, turn, drain) {
  // Each as it was held, in order: every source is an entry, so only a direct start holds one here (#1429), and
  // nothing batches them.
  const groups = [...turn.pending];
  const next = groups.shift();
  if (next) {
    const where = next.threadId ?? se.threadId;
    // The agent's inbox entries in the thread join it, unless a later group there waits behind it, so nothing jumps
    // ahead of that, or the turn failed (#733).
    const later = groups.some((g) => (g.threadId ?? se.threadId) === where);
    const message = !later && drain === true ? next.message : { ...next.message, entriesWait: true };
    rt.turnService.release(se.id, message, { summarizeTo: next.summarizeTo, threadId: next.threadId });
    const t = rt.turns.get(se.id);
    if (t) t.pending.push(...groups);
    else holdRest(rt, se, next, groups);
  } else if (drain) rt.delivery.wake(se.id); // its inbox’s next turn, if it has entries that can start one
}

/**
 * The rest of what waited, when its first group started no turn (#733): each takes deliver's held path, in order
 * (writes closed, a session behind a held commit), as the first did. Shutting down, deliver holds nothing,
 * the first group included, so the drop of all of them is logged.
 */
function holdRest(rt, se, next, groups) {
  if (rt.closing) {
    const lost = [next, ...groups];
    const kinds = [...new Set(lost.map((g) => g.message.kind))].join(', ');
    const n = lost.length === 1 ? '1 waiting delivery' : `${lost.length} waiting deliveries`;
    console.warn(`@${se.handle}’s turn ended as Postbox shut down: ${n} (${kinds}) undelivered.`);
    return;
  }
  for (const g of groups) rt.turnService.release(se.id, g.message, { summarizeTo: g.summarizeTo, threadId: g.threadId });
}

export function rememberStoppedMessages(rt, sessionId, message) {
  for (const child of message.messages ?? [message])
    if (child.kind === 'agent') rt.sessions.tell(sessionId, `${child.from}’s message came while your turn was stopped: “${clip(child.text ?? '', 300)}”`);
}

/**
 * An agent’s place may have changed: what waited in its inbox for a host turn to be attached goes now if it moved off
 * that host, since that host may never answer and nothing else would wake it (#1135). An agent still there is busy,
 * and its entries keep waiting. @param {any} rt @param {string} personaId
 */
export function drainMovedOff(rt, personaId) {
  for (const se of Object.values(rt.s.sessions))
    if (se.personaId === personaId && rt.remote.restoring.get(se.remoteTurn?.turn) === se.id) rt.delivery.wake(se.id);
}
