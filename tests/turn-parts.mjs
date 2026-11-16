// What a test’s scripted adapter records of a turn besides its message: the plain messages it took (#1427). A turn of
// plain entries is given turn-input.mjs’s text as an `input`, whose parts stay on what its turn was asked; any other
// message is its own part, or a batch’s parts. Tests about which entries a turn took read these, and tests about what an
// agent reads read the message.

/**
 * @param {any} rt  the runtime, or null @param {string} sessionId @param {any} message  what the adapter was given
 * @returns {any[]}
 */
export function partsOf(rt, sessionId, message) {
  if (message.kind !== 'input') return message.messages ?? [message];
  return rt?.running.turnOf(sessionId)?.asked?.message?.messages ?? [];
}

/**
 * What a turn read besides its request: since #1427 an input’s text holds the room’s tail, its notes and the thread’s
 * own talk, which a task context and context held before. @param {{ message: any }} call
 */
export const readOf = (call) =>
  [call.message.kind === 'input' ? call.message.text : null, call.message.taskContext, ...(call.message.context ?? [])].filter(Boolean).join('\n');
