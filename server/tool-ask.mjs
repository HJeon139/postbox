// An agent asks for a tool the person turned off for it (#104). The backend removes a turned-off tool from the agent’s
// list, so without this the agent can’t tell it apart from a computer that lacks it: a critic without shell told the
// person it had “no shell, gh or GitHub access”. The guide names what’s off (offText in server/adapters/guide.mjs) and
// points at ask_for_tool, which shows a card the person answers. Turning the tool on changes the persona, in every
// conversation, from its next turn (Runtime.personaFor reads Tools from the persona, not the session’s snapshot).

import { REAL_BACKEND_TOOLS } from './adapters/setup.mjs';
import { httpError } from './runtime.mjs';
import { KNOWN_TOOLS } from './seed.mjs';

/** Every tool id the persona editor offers, with its label there. */
const LABELS = new Map([...KNOWN_TOOLS, ...REAL_BACKEND_TOOLS].map(([id, label]) => [id, label]));

/**
 * ask_for_tool { tool, why }: a card in the conversation that can turn the tool on.
 * @param {any} rt  the Runtime @param {string} sessionId @param {{ tool?: unknown, why?: unknown }} args
 * @param {() => void} endSegment  ends the reply so far, so the card shows below it
 * @param {string} [threadId]  where the turn speaks: the session’s thread, or a side thread it answers in (#110)
 */
export function askForTool(rt, sessionId, { tool, why } = {}, endSegment = () => {}, threadId = rt.session(sessionId).threadId) {
  const se = rt.session(sessionId);
  const persona = rt.persona(se.personaId);
  const id = String(tool ?? '')
    .trim()
    .slice(0, 40);
  if (!LABELS.has(id)) return { ok: false, message: `There’s no tool “${id}” to turn on. The ids are ${[...LABELS.keys()].join(', ')}.` };
  if ((persona?.tools ?? []).includes(id))
    return { ok: false, message: `${id} is already on for you. Its tools are in your list from your next turn after it was turned on.` };
  const open = rt.store.items(threadId).find((x) => x.kind === 'toolask' && x.sessionId === sessionId && x.tool === id && x.status === 'open');
  if (open) return { ok: true, message: `You already asked for ${id}, and the card is waiting for the person. End your turn.` };
  endSegment();
  rt.addItem(threadId, {
    kind: 'toolask',
    sessionId,
    handle: se.handle,
    personaId: se.personaId,
    turnId: rt.turns.get(sessionId)?.id ?? null,
    tool: id,
    label: LABELS.get(id),
    why: String(why ?? '').slice(0, 600),
    status: 'open',
  });
  return {
    ok: true,
    message: `The person sees a card that can turn on ${id} for you. End your turn: their answer arrives as a message, and if they turn it on, its tools are yours from your next turn.`,
  };
}

/**
 * The person’s answer: on (tick the tool for the persona) or off (leave it). Either way the agent hears it and goes on.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} action
 */
export function resolveToolAsk(rt, threadId, itemId, action) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'toolask' || it.status !== 'open') throw httpError(409, 'That was already answered.');
  if (action !== 'on' && action !== 'off') throw httpError(400, 'A request for a tool takes “on” or “off”.');
  const persona = rt.persona(it.personaId);
  if (action === 'on') {
    if (!persona) throw httpError(404, 'That agent doesn’t exist any more.');
    rt.updatePersona(persona.id, { tools: [...new Set([...(persona.tools ?? []), it.tool])] });
  }
  rt.patchItem(threadId, itemId, { status: action, answeredAt: Date.now() });
  rt.addItem(threadId, {
    kind: 'voice',
    text: action === 'on' ? `Turned on “${it.label}” for @${it.handle}` : `Kept “${it.label}” off for @${it.handle}`,
  });
  const se = rt.s.sessions[it.sessionId];
  if (!se) return { ok: true };
  if (se.needs?.itemId === itemId) rt.updateSession(se.id, { needs: null, state: rt.turns.has(se.id) ? se.state : 'idle' });
  if (!se.archived && !se.deleting)
    rt.deliver(se.id, {
      kind: 'notice',
      text:
        action === 'on'
          ? `The person turned on ${it.tool} (${it.label}) for you. Its tools are in your list from this turn: carry on with what needed it.`
          : `The person kept ${it.tool} off for you. Carry on without it, and say plainly what you can’t do.`,
    });
  return { ok: true };
}
