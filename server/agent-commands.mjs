// An agent’s own skills and commands (#67, #207): `/name args` run as that agent’s turn. The list its backend reports
// is kept on its session for the / menu (server/sessions.mjs, recordCommands). Moved out of server/runtime.mjs; Runtime
// keeps a method of the same name that delegates here.

import { httpError, retiredError } from './helpers.mjs';

/**
 * Runs an agent’s skill or command as its turn: `/name args` is the whole prompt (deliver skips the catch-up, which
 * waits for the next turn), posted in the conversation as you wrote it. In a room, it addresses that agent.
 * @param {any} rt @param {string} threadId @param {{ sessionId: string, text: string }} req
 */
export function runAgentCommand(rt, threadId, { sessionId, text }) {
  // As written: a conversation just started behind a held commit, and its agents, aren’t published yet (#1292).
  rt.threads.toWrite(threadId);
  const line = String(text ?? '')
    .trim()
    .slice(0, 50000);
  if (!/^\/[\w:.@/-]+/.test(line)) throw httpError(422, 'A skill or command starts with / and its name, such as /review.');
  const se = rt.sessions.pendingIn(threadId).find((x) => x.id === sessionId);
  if (!se) throw httpError(404, 'That agent isn’t in this conversation.');
  if (se.retiredFork) throw retiredError(se);
  if (rt.turns.has(se.id)) throw httpError(409, `@${se.handle} is busy. Stop it, or wait for it to finish, then run the command.`);
  const item = rt.threads.addItem(threadId, { kind: 'user', text: line, attachments: [], to: [se.handle], command: { sessionId: se.id, handle: se.handle } });
  rt.threads.patch(threadId, { hops: 0 });
  if (rt.sessions.in(threadId).length > 1) rt.threads.addItem(threadId, { kind: 'system', variant: 'wake', from: 'you', to: se.handle });
  // A command entry pointing at its line (designs/rooms-at-scale.md, “What an entry is”), with the whole command its
  // turn is given until Turns builds input from entries.
  const message = { kind: 'user', text: line, attachments: [], itemId: item.id, slash: true };
  rt.delivery.send({ sessionId: se.id, threadId, source: 'command', itemId: item.id, from: 'you', message });
  return { item };
}
