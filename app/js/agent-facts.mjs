// What an agent runs with, from the client’s state: shared/agent-facts.mjs says it in words; this looks up the
// session’s persona and the server’s defaults. mockMarker() is the one “mock” marker every place that names an
// agent uses (#12).

import { runsWith } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';

/** @returns {import('/shared/agent-facts.mjs').Facts} */
export const factsOf = (se) => runsWith(se, client.state.personas[se.personaId], client.config ?? {});

/**
 * Whether an agent runs on the mock: a session (by its persona’s backend, which reaches it from the next turn,
 * else its own) or a persona.
 */
export function isMock(agent) {
  if (!agent) return false;
  return agent.personaId ? factsOf(agent).mock : (agent.backend ?? 'mock') === 'mock';
}

/**
 * “mock” beside an agent’s name, wherever it appears: chips, rail rows, cards, speaker lines, menus, the Personas
 * list and the composer. Visible text, so a scripted reply never passes for a model’s (#12). Null on a real backend.
 * @param {any} agent a session or a persona
 */
export function mockMarker(agent) {
  // The space is text, so the name and the marker read as two words (“@critic mock”), wherever it goes.
  return isMock(agent) ? h('span.mock-mark', ' ', h('span.mock-tag', 'mock')) : null;
}
