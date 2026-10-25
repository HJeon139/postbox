// Permission cards: a call that waits for your answer. Refusal cards are in server/refusal-cards.mjs.
// Runtime keeps a one-line method for each, so its callers and tests don’t change.

import { POSTBOX_TIMEOUT_MS } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';
import { addAllowRule, alwaysAllow, cleanRule, rulesFor } from './permission-rules.mjs';
import { draftOf, isWriteCall, whereOf, writePasses } from './write-guard.mjs';

// ── Permission prompts ─────────────────────────────────────────────────────────────
// A real agent in “ask” mode stops before anything risky, such as running a command. Postbox shows a card
// in the thread, the agent needs you, and the tool call waits for your answer. Ending the turn, or Stop,
// turns any open card into “expired” and answers no. So does a card left for CARD_WAIT_MS (#220): Claude Code gives up
// on the call at POSTBOX_TIMEOUT_MS (server/adapters/setup.mjs), timed from when it sent the call, and an answer after
// that would go nowhere. The card’s wait starts later, when the call arrives, so it ends a margin early, while Claude
// Code still waits, and the no reaches the call. A minute is far more than a call takes to reach Postbox.
const EXPIRY_MARGIN_MS = 60 * 1000;
export const CARD_WAIT_MS = POSTBOX_TIMEOUT_MS - EXPIRY_MARGIN_MS;

/**
 * input is the call’s input, which Edit changes; suggestions are Claude Code’s own (`permission_suggestions`, the
 * SDK’s `suggestions`), which Always allow returns; agentId names the subagent that asks, when one does.
 * @param {string} sessionId
 * suppressAlways is the SDK’s suppressAlwaysAllowRule: the rule Always allow would save grants more than this call.
 * draft is what a write outside Postbox carries (server/write-guard.mjs’s draftOf), found from input when not given.
 * @param {{ tool: string, summary: string, detail?: string, toolUseId?: string|null, input?: any, suggestions?: unknown,
 *           agentId?: string|null, suppressAlways?: boolean, draft?: { field: string, text: string } | null,
 *           sandbox?: { command?: string } }} req
 * @returns {Promise<{ allow: boolean, message?: string, updatedInput?: Record<string, any>, updatedPermissions?: any[] }>}
 */
export async function requestPermission(rt, sessionId, req) {
  const se = rt.s.sessions[sessionId];
  // A write outside Postbox the person already settled runs without a card (#112).
  if (isWriteCall(req.tool, req.input) && se && (await writePasses(rt, sessionId, req).catch(() => false))) return { allow: true };
  // Run everything never asks, from the moment it’s set (#371): it answers what a backend asks for its own sandbox
  // (sandbox), which no Postbox rule forced. Codex fixes its approval policy when a turn starts, so after a switch to Run
  // everything it still asks for its commands and file changes. An ask that a rule forced (Claude Code’s
  // permission_prompt, the Agent SDK’s canUseTool) keeps its card, as the permissions panel shows ask rules winning
  // over the mode. So does a write outside Postbox (#112): stricter than a turn started in Run everything, which Codex
  // never asks about, but a switch mid-turn isn’t a review of what the turn publishes.
  const command = req.sandbox?.command;
  if (se && req.sandbox && !isWriteCall('Bash', { command }) && rt.persona(se.personaId)?.permissionMode === 'bypass') return { allow: true };
  return rt.askPerson(sessionId, req);
}

/** @param {any} rt @param {string} sessionId @param {Parameters<typeof requestPermission>[2]} req */
export function askPerson(
  rt,
  sessionId,
  { tool, summary, detail = '', toolUseId = null, input = null, suggestions = null, agentId = null, suppressAlways = false, draft },
) {
  const se = rt.s.sessions[sessionId];
  const turn = rt.turns.get(sessionId);
  if (!se || !turn) return Promise.resolve({ allow: false, message: 'The turn has ended.' });
  const json = input && typeof input === 'object' && !Array.isArray(input) ? JSON.stringify(input) : null;
  const it = rt.addItem(turn.threadId, {
    kind: 'permission',
    sessionId,
    handle: se.handle,
    turnId: turn.id,
    tool: String(tool ?? '').slice(0, 120),
    summary: String(summary).slice(0, 200),
    ...writeOf(tool, input, detail, draft),
    // The tool call it’s about, so a refusal of a call you answered here doesn’t get a second card.
    toolUseId: toolUseId ? String(toolUseId) : null,
    // What Edit starts from; an input too large to edit here can still be allowed as it is.
    input: json && json.length <= MAX_EDIT_INPUT ? JSON.parse(json) : null,
    always: rt.alwaysFor(se, { tool, input, suggestions, suppressAlways }),
    // A subagent’s prompt names it, as its refusals do: by the SDK’s agent id, or by the call the stream saw it make.
    who: whoAsked(turn, agentId, toolUseId),
    status: 'open',
  });
  // The text so far is finished; the reply continues below the card.
  if (turn.segment) rt.patchItem(turn.threadId, turn.segment, { status: 'done' });
  turn.segment = null;
  rt.updateSession(sessionId, {
    state: 'needs',
    needs: { kind: 'permission', itemId: it.id, text: `@${se.handle} asks to ${it.summary}`, ...rt.awayFrom(se, turn.threadId) },
  });
  rt.notify('blocking', se, `@${se.handle} asks permission`, `To ${it.summary}.`, turn.threadId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => expireWait(rt, it.id), CARD_WAIT_MS);
    timer.unref?.();
    rt.permissionWaits.set(it.id, { resolve, threadId: turn.threadId, sessionId, timer });
  });
}

/**
 * A card nobody answered for CARD_WAIT_MS (#220): Claude Code is about to give up on the call, so the card expires and
 * says how long it waited, in whole hours as the card shows it, and the call is refused (the SDK’s too, which has no
 * such limit).
 * @param {any} rt @param {string} itemId
 */
export function expireWait(rt, itemId) {
  const hours = Math.round(CARD_WAIT_MS / 3600000);
  const message = `Nobody answered within ${hours} hours, so the request expired. Ask again if you still need it.`;
  return rt.settlePermission(itemId, 'expired', message, {}, { waitedMs: CARD_WAIT_MS });
}

/**
 * What Always allow offers on a card, or null for none:
 * - none when Claude Code says a saved rule would grant more than this call (the SDK’s suppressAlwaysAllowRule);
 * - Claude Code’s own suggestions when it sends a list (the SDK does, and an empty list means none);
 * - otherwise, for the CLI’s prompt tool, which sends no list at all (recorded), the rule Postbox makes for a refusal,
 *   which it saves where the CLI saves “don’t ask again”; but only for a backend that reads rules from a folder.
 * @param {any} rt @param {any} se @param {{ tool: unknown, input: any, suggestions: unknown, suppressAlways: boolean }} req
 */
export function alwaysFor(rt, se, { tool, input, suggestions, suppressAlways }) {
  if (suppressAlways) return null;
  if (Array.isArray(suggestions)) return alwaysAllow(suggestions);
  if (suggestions !== null && suggestions !== undefined) return null;
  return rt.readsRules(rt.persona(se.personaId)?.backend) ? postboxAlways(String(tool ?? '').slice(0, 121), input) : null;
}

/**
 * Whether a backend reads Claude Code’s permission rules from the agent’s folder: Claude Code and the Agent SDK do;
 * the mock reads none, and the Kiro CLI has rules of its own (capabilities.permissions: 'none', #117).
 * @param {string|undefined} backend
 */
export function readsRules(rt, backend) {
  const adapter = backend && rt.adapters.names().includes(backend) ? rt.adapters.get(backend) : null;
  return Boolean(adapter?.folderFor) && adapter?.capabilities?.permissions !== 'none';
}

/**
 * Answers a waiting tool call. Any status that starts with “allowed” lets it run, with `answer`’s updatedInput or
 * updatedPermissions; anything else refuses it with `message`.
 * @param {string} itemId @param {string} status @param {string} [message]
 * @param {{ updatedInput?: Record<string, any>, updatedPermissions?: any[] }} [answer] @param {Record<string, any>} [patch]
 */
export function settlePermission(rt, itemId, status, message, answer = {}, patch = {}) {
  const w = rt.permissionWaits.get(itemId);
  if (!w) return false;
  clearTimeout(w.timer);
  rt.permissionWaits.delete(itemId);
  rt.patchItem(w.threadId, itemId, { status, answeredAt: Date.now(), ...patch });
  const se = rt.s.sessions[w.sessionId];
  if (se?.needs?.itemId === itemId) rt.updateSession(se.id, { needs: null, state: rt.turns.has(se.id) ? 'tool' : 'idle' });
  w.resolve(status.startsWith('allowed') ? { allow: true, ...answer } : { allow: false, message: message ?? 'The request expired when the turn ended.' });
  return true;
}

/**
 * Your answer on a permission card (#66, #10):
 * - allow: this once, as asked;
 * - always: this once, and Claude Code’s own suggestions as updatedPermissions (the card shows them in words);
 * - edit: with your change to the input (values.command for a command, else values.input, an object or JSON);
 * - deny: no, with values.reason, which goes to the agent.
 * @param {string} threadId @param {string} itemId @param {string} action @param {Record<string, any>} [values]
 */
export function resolvePermission(rt, threadId, itemId, action, values = {}) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'permission' || it.status !== 'open' || !rt.permissionWaits.has(itemId))
    throw httpError(409, 'That request was already answered, or the turn that asked has ended.');
  if (!['allow', 'always', 'edit', 'deny'].includes(action)) throw httpError(400, 'A permission request takes “allow”, “always”, “edit” or “deny”.');
  const asked = `${it.who ? `@${it.handle}’s subagent (${it.who})` : `@${it.handle}`} to ${it.summary}`;
  if (action === 'allow') {
    rt.addItem(threadId, { kind: 'voice', text: `Allowed: ${asked}` });
    rt.settlePermission(itemId, 'allowed');
  } else if (action === 'always') {
    if (!it.always) throw httpError(409, 'There’s no rule to save for this one, so it can only be allowed once.');
    return rt.allowAlways(threadId, it, asked);
  } else if (action === 'edit') {
    const input = editedInput(it, values);
    rt.addItem(threadId, { kind: 'voice', text: `Allowed with your edit: ${asked}` });
    rt.settlePermission(
      itemId,
      'allowed-edited',
      undefined,
      { updatedInput: input },
      { edited: it.tool === 'Bash' ? input.command : JSON.stringify(input, null, 2) },
    );
  } else {
    const reason = String(values?.reason ?? '')
      .trim()
      .slice(0, MAX_REASON);
    rt.addItem(threadId, { kind: 'voice', text: `Didn’t allow: ${asked}${reason ? ` (“${reason}”)` : ''}` });
    rt.settlePermission(
      itemId,
      'denied',
      reason ? `The person didn’t allow this. Their reason: ${reason}` : 'The person didn’t allow this. Ask them what to do instead, or find another way.',
      {},
      reason ? { reason } : {},
    );
  }
  return { ok: true };
}

/**
 * Always allow on a permission card: Claude Code’s suggestions go back as updatedPermissions, and Claude Code saves
 * them; a rule Postbox made (the CLI suggests none) Postbox saves itself, in the agent folder’s local settings.
 * @param {string} threadId @param {any} it @param {string} asked
 */
export async function allowAlways(rt, threadId, it, asked) {
  if (it.always.saves) {
    const se = rt.s.sessions[it.sessionId];
    const persona = se && rt.personaFor(se);
    const adapter = persona && rt.adapters.get(persona.backend);
    if (!adapter?.folderFor || !rt.readsRules(persona.backend)) throw httpError(409, 'Only Claude Code and Agent SDK agents read permission rules.');
    await addAllowRule(await adapter.folderFor(persona, rt.s.projects[rt.s.threads[threadId]?.projectId]), it.always.saves);
    // The card may have been answered, or its turn ended, while the file was written.
    if (!rt.permissionWaits.has(it.id)) throw httpError(409, 'The rule is saved, but the turn that asked has ended.');
  }
  rt.addItem(threadId, { kind: 'voice', text: `Always allowed (${it.always.lines.map((l) => l.rule ?? l.text).join(', ')}): ${asked}` });
  rt.settlePermission(it.id, 'allowed-always', undefined, it.always.updates ? { updatedPermissions: it.always.updates } : {});
  return { ok: true };
}

/** After a restart, no tool call is waiting any more, so open cards can’t be answered. */
export function expireStalePermissions(rt) {
  for (const [threadId, items] of Object.entries(rt.s.items))
    for (const it of items) if (it.kind === 'permission' && it.status === 'open') rt.patchItem(threadId, it.id, { status: 'expired' });
}

/**
 * A permission card’s detail, and for a write outside Postbox (#112) that it is one, and its draft, which the card shows
 * as Markdown above the other arguments.
 * @param {unknown} tool @param {any} input @param {unknown} detail @param {{ field: string, text: string } | null | undefined} given
 */
function writeOf(tool, input, detail, given) {
  const outside = isWriteCall(String(tool ?? ''), input);
  const draft = given === undefined ? draftOf(String(tool ?? ''), input) : given;
  const rest =
    draft && input && typeof input === 'object' && Object.hasOwn(input, draft.field)
      ? JSON.stringify({ ...input, [draft.field]: '(the draft above)' }, null, 2)
      : null;
  return {
    detail: String(rest ?? detail).slice(0, 4000),
    // Where it lands, so the card can say so before anything exists there.
    ...(outside ? { outside: true, where: whereOf(String(tool ?? ''), input) } : {}),
    ...(draft ? { draft: { field: draft.field, text: String(draft.text).slice(0, 20000) } } : {}),
  };
}

/**
 * Always allow for a prompt without suggestions (the CLI’s prompt tool sends none): the broader rule a refusal card
 * offers (permission-rules.mjs, rulesFor), which Postbox saves in the folder’s local settings itself.
 * @param {string} tool @param {any} input
 */
function postboxAlways(tool, input) {
  if (!tool || tool.length > 120) return null;
  const r = rulesFor(tool, input && typeof input === 'object' ? input : {});
  // A rule too long to keep, or none (a chained command, which no one rule can allow, #238), isn’t offered.
  if (!r.always || cleanRule(r.always) !== r.always) return null;
  return {
    updates: null,
    saves: r.always,
    lines: [{ text: `Always allow ${r.always} in this folder (.claude/settings.local.json)`, rule: r.always }],
    moved: null,
    words: r.alwaysWords,
  };
}
/** The subagent behind a prompt, from the adapter’s stream (claude-stream.mjs, who), bounded; null for the agent itself. */
function whoAsked(turn, agentId, toolUseId) {
  const ids = { agentId: agentId ? String(agentId) : null, toolUseId: toolUseId ? String(toolUseId) : null };
  const name = turn.subagentName?.(ids) ?? (ids.agentId ? 'a subagent' : null);
  return name ? String(name).slice(0, 40) : null;
}

// A permission card’s Edit (#10): the input it starts from, and what you can send back, are bounded.
const MAX_EDIT_INPUT = 16000;
const MAX_REASON = 1000;
/**
 * The input an edited permission answer allows: the command you changed, for Bash, else the input you rewrote (an
 * object, or JSON that parses to one). Refused when it doesn’t parse, so a typo never reaches the agent’s tool.
 * @param {any} it @param {Record<string, any>} values
 */
function editedInput(it, values) {
  // Edit starts from the call’s whole input. One too large to keep on the card can only be allowed as it is, since an
  // edit made from its shortened text would drop the rest (a command’s description, timeout or background flag).
  if (!it.input) throw httpError(409, 'This call’s input is too large to edit here. Allow it as it is, or don’t allow it and say what to do instead.');
  if (it.tool === 'Bash' && typeof values?.command === 'string') {
    const command = values.command.trim();
    if (!command) throw httpError(422, 'Write the command to run, or choose Don’t allow.');
    if (command.length > MAX_EDIT_INPUT) throw httpError(422, `A command is limited to ${MAX_EDIT_INPUT.toLocaleString('en-US')} characters.`);
    return { ...it.input, command };
  }
  let input = values?.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch (e) {
      throw httpError(422, `The edited input isn’t valid JSON: ${e.message}`);
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw httpError(422, 'The edited input has to be a JSON object, like the one it started from.');
  if (JSON.stringify(input).length > MAX_EDIT_INPUT)
    throw httpError(422, `The edited input is limited to ${MAX_EDIT_INPUT.toLocaleString('en-US')} characters.`);
  return input;
}
