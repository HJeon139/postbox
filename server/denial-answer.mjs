// The person’s answer on a refusal card (#227): allow the refused call once, always, or leave it refused. Moved out of
// server/permission-cards.mjs, which had reached its length limit; it re-exports resolveDenial, so its callers don’t
// change.

import { releaseNeed } from './card-needs.mjs';
import { httpError } from './helpers.mjs';
import { addAllowRule } from './permission-rules.mjs';

/** Why a refusal card on a host offers no Always allow (recordDenial), nor a host card with Claude Code’s own updates. */
export const ON_HOST =
  'This agent runs on a host, and Postbox would save the rule on this computer, where that host never reads it. Allow it once, or add the rule to the agent folder’s .claude/settings.local.json on the host.';

/** Why a refusal has no rule to allow once or always, and what to do instead. @param {string} why */
function noRuleWhy(why) {
  if (why === 'wildcard')
    return 'Claude Code reads * in a rule as a wildcard, so a rule for this command would allow others too. Ask the agent to name the files instead.';
  if (why === 'paren')
    return 'Claude Code would read a ) in this command as the end of its rule, so a rule for it could allow others too. Ask the agent to run it without the unmatched ).';
  return 'Claude Code checks each part of a chained command on its own, so no one rule can allow this call. Ask the agent to run the parts as separate commands.';
}

export async function resolveDenial(rt, threadId, itemId, action) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'denial' || it.status !== 'open') throw httpError(409, 'That refusal was already answered.');
  if (!['once', 'always', 'leave'].includes(action)) throw httpError(400, 'A refusal takes “once”, “always” or “leave”.');
  if (action === 'always' && it.remote) throw httpError(409, ON_HOST);
  // A chained command, or one with a *, has no rule that can allow just it (permission-rules.mjs), so neither is
  // offered (#238, #281).
  if (action !== 'leave' && !it.rules[action]) throw httpError(409, noRuleWhy(it.rules.why));
  // As written, held writes included: what it decides (the need released, the note sent, allowOnce) can follow a write
  // still behind a commit (#623, #1896).
  const se = rt.store.pending.session(it.sessionId);
  const asked = it.who ? `${it.who} (your subagent)` : 'you';
  /** @type {string | null} */
  let note = null;
  if (action === 'always') {
    const persona = se && rt.personas.forSession(se);
    const adapter = persona && rt.placement.requestAdapter(se.handle, persona);
    if (!adapter?.folderFor || !rt.readsRules(persona.backend)) throw httpError(409, 'Only Claude Code agents read permission rules.');
    const folder = await adapter.folderFor(persona, rt.s.projects[rt.s.threads[threadId]?.projectId]);
    await addAllowRule(folder, it.rules.always);
    // Without the settings file’s path: the note is an inbox entry, which reaches the page, and the path is this computer’s.
    note = `[Postbox] The person now always allows \`${it.rules.always}\` (saved in your project’s permission rules). The step ${asked} tried, ${it.summary}, was refused before: try it again, then carry on.`;
  } else if (action === 'once') {
    // Built from the session update passes, so a rule added behind a held commit is kept (#1896).
    if (se) rt.sessions.update(se.id, (cur) => ({ allowOnce: [...(cur.allowOnce ?? []), it.rules.once] }));
    note = `[Postbox] The person allowed \`${it.rules.once}\` for your next turn only. The step ${asked} tried, ${it.summary}, was refused before: try it again exactly as before, since the allow covers only that exact call, then carry on.`;
  }
  const status = { once: 'allowed-once', always: 'allowed-always', leave: 'left' }[action];
  rt.threads.patchItem(threadId, itemId, { status, answeredAt: Date.now() });
  const words = { once: 'Allowed once', always: `Always allowed ${it.rules.alwaysWords}`, leave: 'Left refused' }[action];
  rt.threads.addItem(threadId, { kind: 'voice', text: `${words}: @${it.handle} to ${it.summary}` });
  releaseNeed(rt, se, itemId);
  // The person’s answer is an entry pointing at the card (designs/rooms-at-scale.md, “What an entry is”), with the note
  // its turn is given until Turns builds input from entries.
  if (note && se && !se.retiredFork)
    rt.delivery.send({ sessionId: se.id, threadId, source: 'answer', itemId, from: 'you', message: { kind: 'notice', text: note } });
  return { ok: true };
}
