// An agent’s own skills and commands (#67, #207): the list its backend reports, kept on its session for the / menu,
// and `/name args` run as that agent’s turn. Moved out of server/runtime.mjs; Runtime keeps a method of the same name
// that delegates here.

import { clipText, httpError } from './helpers.mjs';
import { updateThread } from './thread-write.mjs';

/** The most skills and commands kept for an agent’s / menu. */
const MAX_COMMANDS = 200;

/**
 * Keeps an agent’s skills and commands on its session, bounded, for the / menu: from init (names; terminal-only
 * ones are already left out) or the SDK’s supportedCommands() (with descriptions and argument hints).
 * @param {string} sessionId @param {unknown} list
 */
export function recordCommands(rt, sessionId, list) {
  if (!rt.s.sessions[sessionId] || !Array.isArray(list)) return;
  const seen = new Set();
  const commands = [];
  for (const c of list) {
    const name = typeof c?.name === 'string' ? c.name.replace(/^\//, '').trim() : '';
    if (!name || name.length > 100 || seen.has(name) || !/^[\w:.@/-]+$/.test(name)) continue;
    seen.add(name);
    commands.push({
      name,
      ...(typeof c.description === 'string' && c.description.trim() ? { description: clipText(c.description.trim(), 200) } : {}),
      ...(typeof c.argumentHint === 'string' && c.argumentHint.trim() ? { argumentHint: clipText(c.argumentHint.trim(), 100) } : {}),
      ...(c.skill === true ? { skill: true } : {}),
    });
    if (commands.length >= MAX_COMMANDS) break;
  }
  rt.updateSession(sessionId, { commands: { at: Date.now(), list: commands } });
}

/**
 * Runs an agent’s skill or command as its turn: `/name args` is the whole prompt (deliver skips the catch-up, which
 * waits for the next turn), posted in the conversation as you wrote it. In a room, it addresses that agent.
 * @param {any} rt @param {string} threadId @param {{ sessionId: string, text: string }} req
 */
export function runAgentCommand(rt, threadId, { sessionId, text }) {
  rt.thread(threadId);
  const line = String(text ?? '')
    .trim()
    .slice(0, 50000);
  if (!/^\/[\w:.@/-]+/.test(line)) throw httpError(422, 'A skill or command starts with / and its name, such as /review.');
  const se = rt.sessionsIn(threadId).find((x) => x.id === sessionId);
  if (!se) throw httpError(404, 'That agent isn’t in this conversation.');
  if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
  if (rt.turns.has(se.id)) throw httpError(409, `@${se.handle} is busy. Stop it, or wait for it to finish, then run the command.`);
  const item = rt.addItem(threadId, { kind: 'user', text: line, attachments: [], command: { sessionId: se.id, handle: se.handle } });
  updateThread(rt, threadId, { hops: 0 });
  if (rt.sessionsIn(threadId).length > 1) rt.addItem(threadId, { kind: 'system', variant: 'wake', from: 'you', to: se.handle });
  rt.deliver(se.id, { kind: 'user', text: line, attachments: [], itemId: item.id, slash: true });
  return { item };
}
