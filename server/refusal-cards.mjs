// Refusal cards: a call Claude Code refused without asking. Moved from server/permission-cards.mjs, which keeps the
// cards that wait for your answer; runtime keeps a one-line method for each, so its callers and tests don’t change.

import { httpError } from './helpers.mjs';
import { addAllowRule, rulesFor } from './permission-rules.mjs';

// Claude Code refuses some calls without asking anyone: auto mode’s classifier, a deny rule, or the mode.
// Each refusal becomes a card, so the person can allow it once (the agent tries again), always (a rule in
// the agent folder’s .claude/settings.local.json, shared with the CLI), or leave it.

export function recordDenial(rt, turn, d) {
  const se = rt.s.sessions[turn.sessionId];
  if (!se) return;
  const key = String(d.toolUseId ?? '');
  // Once per call, and never for a call the person answered on a permission card.
  if (key && rt.store.items(turn.threadId).some((it) => (it.kind === 'denial' || it.kind === 'permission') && it.toolUseId === key)) return;
  const rules = rulesFor(String(d.tool ?? ''), d.input ?? {});
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
  // A chained command has no rule that can allow it (permission-rules.mjs, chains), so neither is offered (#238).
  if (action !== 'leave' && !it.rules[action])
    throw httpError(
      409,
      'Claude Code checks each part of a chained command on its own, so no one rule can allow this call. Leave it, and ask the agent to run the parts as separate commands.',
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
