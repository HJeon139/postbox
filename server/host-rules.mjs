// Always allow for an agent on a host (#120). Its Claude Code reads the settings files on the host, never the agent
// folder on this computer, so a rule saved from a host turn’s card stays in Postbox’s own store, on the persona, for
// that host: [{ hostId, rule }]. Each host turn of that persona on that host gets them in its --settings as allow rules
// (server/remote/turns-start.mjs, prepare; claude-code-args.mjs), so nothing is written on the host, a local turn never
// gets them, and another host gets only its own. The permissions panel lists them with their host and removes them.

import { httpError } from './helpers.mjs';
import { cleanRule } from './permission-rules.mjs';

// What one persona keeps for one host, bounded as a conversation’s rules are (permissions-panel.mjs).
export const MAX_HOST_RULES = 200;

/** @param {any} persona @returns {{ hostId: string, rule: string }[]} */
const listOf = (persona) =>
  Array.isArray(persona?.hostRules) ? persona.hostRules.filter((x) => typeof x?.hostId === 'string' && typeof x?.rule === 'string') : [];

/**
 * The allow rules the person saved for this persona on this host, in the order saved: what its next host turn there
 * sends in --settings. The persona as stored, not a session’s snapshot of it, so a rule saved mid-turn reaches the next.
 * @param {any} rt @param {string} personaId @param {string} hostId
 */
export function hostRulesOf(rt, personaId, hostId) {
  return listOf(rt.persona(personaId))
    .filter((x) => x.hostId === hostId)
    .map((x) => x.rule);
}

/**
 * Where Always allow keeps its rule, in the card’s words, for a persona on a host; null for one on this computer.
 * @param {any} rt @param {any} persona
 */
export function hostWhere(rt, persona) {
  const hostId = typeof persona?.remote?.hostId === 'string' ? persona.remote.hostId : null;
  return hostId ? `on ${rt.s.hosts?.[hostId]?.name ?? 'its host'} (Postbox keeps it, and sends it with each turn there)` : null;
}

/**
 * Every host rule a persona has, each with its host’s name, for the permissions panel; current says it’s for the host
 * the persona runs on now.
 * @param {any} rt @param {any} persona
 */
export function hostRuleList(rt, persona) {
  const here = persona?.remote?.hostId ?? null;
  return listOf(rt.persona(persona?.id)).map((x) => ({
    hostId: x.hostId,
    host: rt.s.hosts?.[x.hostId]?.name ?? 'a host that was removed',
    rule: x.rule,
    current: x.hostId === here,
  }));
}

/**
 * Adds (or, with remove, takes out) one allow rule for a persona on a host, in the store. The rule is checked as any rule
 * the panel takes (cleanRule), and kept as the string it is: --settings carries it as JSON data.
 * @param {any} rt @param {{ personaId: string, hostId: string, rule: unknown, remove?: boolean }} change
 * @returns {{ rule: string, changed: boolean }}
 */
export function changeHostRule(rt, { personaId, hostId, rule, remove = false }) {
  const p = rt.persona(personaId);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  if (typeof hostId !== 'string' || !hostId) throw httpError(422, 'Say which host the rule is for.');
  const clean = cleanRule(rule);
  if (!clean) throw httpError(422, 'That isn’t a rule. Write a tool name, and what it covers in parentheses: Bash(npm test:*).');
  const list = listOf(p);
  const has = list.some((x) => x.hostId === hostId && x.rule === clean);
  if (remove ? !has : has) return { rule: clean, changed: false };
  if (!remove && !rt.s.hosts?.[hostId]) throw httpError(404, 'That host doesn’t exist.');
  if (!remove && list.filter((x) => x.hostId === hostId).length >= MAX_HOST_RULES)
    throw httpError(422, `An agent keeps up to ${MAX_HOST_RULES} rules for each host. Remove one in its permissions first.`);
  const next = remove ? list.filter((x) => !(x.hostId === hostId && x.rule === clean)) : [...list, { hostId, rule: clean }];
  rt.store.emit('persona', { ...p, hostRules: next, version: (p.version ?? 1) + 1 });
  return { rule: clean, changed: true };
}
