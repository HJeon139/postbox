// Permission cards and refusal cards: a call that waits for your answer, and a call Claude Code refused without asking.
// Runtime keeps a one-line method for each, so its callers and tests don’t change.

import { POSTBOX_TIMEOUT_MS } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';
import { editedInput, MAX_EDIT_INPUT, MAX_REASON } from './permission-edit.mjs';
import { addAllowRule, alwaysAllow, cleanRule, rulesFor, takeBackRule } from './permission-rules.mjs';
import { draftOf, isWriteCall, whereOf } from './write-guard.mjs';
import { settledCall } from './write-intent.mjs';

// ── Permission prompts ─────────────────────────────────────────────────────────────
// A real agent in “ask” mode stops before anything risky, such as running a command. Postbox shows a card
// in the thread, the agent needs you, and the tool call waits for your answer. Ending the turn, or Stop,
// turns any open card into “expired” and answers no. So does a card left for CARD_WAIT_MS (#220): Claude Code gives up
// on the call at POSTBOX_TIMEOUT_MS (server/adapters/setup.mjs), timed from when it sent the call, and an answer after
// that would go nowhere. The card’s wait starts later, when the call arrives, so it ends a margin early, while Claude
// Code still waits, and the no reaches the call. A minute is far more than a call takes to reach Postbox.
const EXPIRY_MARGIN_MS = 60 * 1000;
/** Why Always allow isn’t offered for a turn on a host (hostAlways). */
const ON_HOST =
  'This agent runs on a host, and Postbox would save the rule on this computer, where that host never reads it. Allow it once, or add the rule to the agent folder’s .claude/settings.local.json on the host.';
export const CARD_WAIT_MS = POSTBOX_TIMEOUT_MS - EXPIRY_MARGIN_MS;

/**
 * input is the call’s input, which Edit changes; suggestions are Claude Code’s own (`permission_suggestions`, the
 * SDK’s `suggestions`), which Always allow returns; agentId names the subagent that asks, when one does.
 * @param {string} sessionId
 * suppressAlways is the SDK’s suppressAlwaysAllowRule: the rule Always allow would save grants more than this call.
 * draft is what a write outside Postbox carries (server/write-guard.mjs’s draftOf), found from input when not given.
 * hostPrompt: on a remote turn, the prompt on the host this card answers (#120), kept on the card as `remote`.
 * @param {{ tool: string, summary: string, detail?: string, toolUseId?: string|null, input?: any, suggestions?: unknown,
 *           agentId?: string|null, suppressAlways?: boolean, draft?: { field: string, text: string } | null,
 *           hostPrompt?: { hostId: string, turn: string, id: string } | null }} req
 * @returns {Promise<{ allow: boolean, message?: string, updatedInput?: Record<string, any>, updatedPermissions?: any[] }>}
 */
export async function requestPermission(rt, sessionId, req) {
  // A write outside Postbox the person already settled runs without a card (#112), as does a call they asked for (#296).
  const settled = rt.s.sessions[sessionId] ? await settledCall(rt, sessionId, req) : null;
  if (settled) return settled;
  return rt.askPerson(sessionId, req);
}

/** @param {any} rt @param {string} sessionId @param {Parameters<typeof requestPermission>[2]} req */
export function askPerson(
  rt,
  sessionId,
  { tool, summary, detail = '', toolUseId = null, input = null, suggestions = null, agentId = null, suppressAlways = false, draft, hostPrompt = null },
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
    always: hostAlways(rt.alwaysFor(se, { tool, input, suggestions, suppressAlways }), hostPrompt),
    // A subagent’s prompt names it, as its refusals do: by the SDK’s agent id, or by the call the stream saw it make.
    who: whoAsked(turn, agentId, toolUseId),
    ...(hostPrompt ? { remote: { hostId: hostPrompt.hostId, turn: hostPrompt.turn, prompt: hostPrompt.id } } : {}),
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
    // A host prompt’s card expires when its host says so (permissionWaitMax, `prompt-expired`, #120): the host’s
    // Claude Code waits on its shim, not on POSTBOX_TIMEOUT_MS, so CARD_WAIT_MS doesn’t apply to it.
    const timer = hostPrompt ? null : setTimeout(() => expireWait(rt, it.id), CARD_WAIT_MS);
    timer?.unref?.();
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
 * What Always allow offers on a host turn’s card (#120): nothing. A rule Postbox saves itself goes in a folder on this
 * computer, which the host never reads, and which local agents in that project would then follow. And whether the
 * host’s Claude Code saves updatedPermissions from a --permission-prompt-tool answer isn’t documented (the SDK’s
 * canUseTool is), and the CLI sends no suggestions (tests/fixtures/claude-code/permission-prompts.json), so none is
 * offered either: Allow once stays.
 * @param {ReturnType<typeof alwaysFor>} always @param {unknown} hostPrompt
 */
const hostAlways = (always, hostPrompt) => (hostPrompt ? null : always);

/**
 * Always allow on a permission card: Claude Code’s suggestions go back as updatedPermissions, and Claude Code saves
 * them; a rule Postbox made (the CLI suggests none) Postbox saves itself, in the agent folder’s local settings.
 * @param {string} threadId @param {any} it @param {string} asked
 */
export async function allowAlways(rt, threadId, it, asked) {
  if (it.remote) throw httpError(409, ON_HOST);
  if (it.always.saves) {
    const se = rt.s.sessions[it.sessionId];
    const persona = se && rt.personaFor(se);
    const adapter = persona && rt.adapters.get(persona.backend);
    if (!adapter?.folderFor || !rt.readsRules(persona.backend)) throw httpError(409, 'Only Claude Code and Agent SDK agents read permission rules.');
    // A card that expired, or whose turn ended, saves nothing: check before the write, and take the rule out again
    // if it ended while the file was written (#281).
    const ended = 'The turn that asked has ended, so no rule was saved.';
    if (!rt.permissionWaits.has(it.id)) throw httpError(409, ended);
    const { file, added, claim } = await addAllowRule(await adapter.folderFor(persona, rt.s.projects[rt.s.threads[threadId]?.projectId]), it.always.saves);
    if (!rt.permissionWaits.has(it.id)) {
      if (added) await takeBackRule(file, it.always.saves, claim);
      throw httpError(409, ended);
    }
  }
  rt.addItem(threadId, { kind: 'voice', text: `Always allowed (${it.always.lines.map((l) => l.rule ?? l.text).join(', ')}): ${asked}` });
  rt.settlePermission(it.id, 'allowed-always', undefined, it.always.updates ? { updatedPermissions: it.always.updates } : {});
  return { ok: true };
}

// ── Refusals ───────────────────────────────────────────────────────────────────────
// Claude Code refuses some calls without asking anyone: auto mode’s classifier, a deny rule, or the mode.
// Each refusal becomes a card, so the person can allow it once (the agent tries again), always (a rule in
// the agent folder’s .claude/settings.local.json, shared with the CLI), or leave it.

export function recordDenial(rt, turn, d) {
  const se = rt.s.sessions[turn.sessionId];
  if (!se) return;
  const key = String(d.toolUseId ?? '');
  // Once per call, and never for a call the person answered on a permission card.
  if (key && rt.store.items(turn.threadId).some((it) => (it.kind === 'denial' || it.kind === 'permission') && it.toolUseId === key)) return;
  // On a host, Always would save its rule on this computer (hostAlways): Allow once and Leave stay.
  const rules = { ...rulesFor(String(d.tool ?? ''), d.input ?? {}), ...(turn.remote ? { always: null } : {}) };
  const detail = d.tool === 'Bash' ? String(d.input?.command ?? '') : JSON.stringify(d.input ?? {}, null, 2);
  rt.addItem(turn.threadId, {
    kind: 'denial',
    sessionId: se.id,
    handle: se.handle,
    turnId: turn.id,
    toolUseId: key,
    tool: String(d.tool ?? '').slice(0, 120),
    summary: String(d.label ?? d.tool ?? '').slice(0, 200),
    detail: detail.slice(0, 4000),
    reason: String(d.reason ?? '').slice(0, 400),
    reasonType: d.reasonType ? String(d.reasonType).slice(0, 40) : null,
    who: d.who ? String(d.who).slice(0, 40) : null,
    rules,
    ...(turn.remote ? { remote: { hostId: turn.remote.hostId } } : {}),
    status: 'open',
  });
  // The text so far is finished; the reply continues below the card.
  if (turn.segment) rt.patchItem(turn.threadId, turn.segment, { status: 'done' });
  turn.segment = null;
}

export async function resolveDenial(rt, threadId, itemId, action) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'denial' || it.status !== 'open') throw httpError(409, 'That refusal was already answered.');
  if (!['once', 'always', 'leave'].includes(action)) throw httpError(400, 'A refusal takes “once”, “always” or “leave”.');
  if (action === 'always' && it.remote) throw httpError(409, ON_HOST);
  // A chained command, or one with a *, has no rule that can allow just it (permission-rules.mjs), so neither is
  // offered (#238, #281).
  if (action !== 'leave' && !it.rules[action])
    throw httpError(
      409,
      it.rules.why === 'wildcard'
        ? 'Claude Code reads * in a rule as a wildcard, so a rule for this command would allow others too. Leave it, and ask the agent to name the files instead.'
        : it.rules.why === 'paren'
          ? 'Claude Code would read a ) in this command as the end of its rule, so a rule for it could allow others too. Leave it, and ask the agent to run it without the unmatched ).'
          : 'Claude Code checks each part of a chained command on its own, so no one rule can allow this call. Leave it, and ask the agent to run the parts as separate commands.',
    );
  const se = rt.s.sessions[it.sessionId];
  const asked = it.who ? `${it.who} (your subagent)` : 'you';
  /** @type {string | null} */
  let note = null;
  if (action === 'always') {
    const persona = se && rt.personaFor(se);
    const adapter = persona && rt.adapters.get(persona.backend);
    if (!adapter?.folderFor || !rt.readsRules(persona.backend)) throw httpError(409, 'Only Claude Code and Agent SDK agents read permission rules.');
    const folder = await adapter.folderFor(persona, rt.s.projects[rt.s.threads[threadId]?.projectId]);
    const { file } = await addAllowRule(folder, it.rules.always);
    note = `[Postbox] The person now always allows \`${it.rules.always}\` (saved in ${file}). The step ${asked} tried, ${it.summary}, was refused before: try it again, then carry on.`;
  } else if (action === 'once') {
    if (se) rt.updateSession(se.id, { allowOnce: [...(se.allowOnce ?? []), it.rules.once] });
    note = `[Postbox] The person allowed \`${it.rules.once}\` for your next turn only. The step ${asked} tried, ${it.summary}, was refused before: try it again exactly as before, since the allow covers only that exact call, then carry on.`;
  }
  const status = { once: 'allowed-once', always: 'allowed-always', leave: 'left' }[action];
  rt.patchItem(threadId, itemId, { status, answeredAt: Date.now() });
  const words = { once: 'Allowed once', always: `Always allowed ${it.rules.alwaysWords}`, leave: 'Left refused' }[action];
  rt.addItem(threadId, { kind: 'voice', text: `${words}: @${it.handle} to ${it.summary}` });
  if (se?.needs?.itemId === itemId) {
    const next = rt.store.items(threadId).find((x) => x.kind === 'denial' && x.sessionId === se.id && x.status === 'open');
    rt.updateSession(se.id, {
      needs: next ? { kind: 'denial', itemId: next.id, text: `A step was refused: ${next.summary}` } : null,
      state: rt.turns.has(se.id) ? se.state : next ? 'needs' : 'idle',
    });
  }
  if (note && se && !se.archived) rt.deliver(se.id, { kind: 'notice', text: note }, { threadId });
  return { ok: true };
}

/**
 * After a restart, no tool call is waiting any more, so open cards can’t be answered. A card of a turn still on a
 * remote host stays open: the host sends its prompt again, or says it expired (#120).
 */
export function expireStalePermissions(rt) {
  for (const [threadId, items] of Object.entries(rt.s.items))
    for (const it of items)
      if (it.kind === 'permission' && it.status === 'open' && !rt.remote.keepsCard(it)) rt.patchItem(threadId, it.id, { status: 'expired' });
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
