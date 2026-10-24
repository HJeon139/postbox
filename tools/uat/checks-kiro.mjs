// Kiro CLI turns (#117), for the Kiro checks in tools/uat/checks.mjs. Moved out of it.

import { REFUSED, toolOf } from '../../server/adapters/kiro-cli.mjs';

// What each Kiro turn’s stream says about its tool calls, for the checks below: one entry per toolCallId, with its
// ACP kind, its MCP server (null for Kiro’s own tools), whether it completed, and whether Kiro refused it: an ask no
// one could answer headless (pending_interaction, then interaction_resolved “cancelled”), a deny rule (policyDenial),
// or Kiro’s refusal wording. Read the way server/adapters/kiro-cli.mjs reads a live turn.
function kiroCalls(events) {
  /** @type {Map<string, { id: string, kind: string|null, title: string, server: string|null, completed: boolean, refused: boolean }>} */
  const calls = new Map();
  const asked = new Set();
  const call = (u) => {
    if (!calls.has(u.toolCallId)) calls.set(u.toolCallId, { id: u.toolCallId, kind: null, title: '', server: null, completed: false, refused: false });
    return calls.get(u.toolCallId);
  };
  for (const e of events) {
    if (e?.type !== 'sessionUpdate') continue;
    const u = e.data?.update ?? {};
    const k = u._meta?.kiro;
    if (u.sessionUpdate === 'session_info_update') {
      if (k?.kind === 'pending_interaction' && k.interactionType === 'tool_approval' && k.toolCallId) asked.add(k.toolCallId);
      // lint-allow spelling: Kiro’s value.
      else if (k?.kind === 'interaction_resolved' && k.outcome === 'cancelled' && asked.has(k.toolCallId)) call({ toolCallId: k.toolCallId }).refused = true;
      continue;
    }
    if ((u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') || !u.toolCallId) continue;
    const c = call(u);
    c.kind = u.kind ?? c.kind;
    c.title = u.title || c.title;
    const name = toolOf(u).name;
    if (name) c.server = name.split('__')[1] ?? null;
    if (u.status === 'completed') c.completed = true;
    const why = JSON.stringify(u.rawOutput ?? u.content ?? '');
    if (u.status === 'failed' && (k?.policyDenial || REFUSED.test(why))) c.refused = true;
  }
  return [...calls.values()];
}
/** The credits Kiro reported over a run’s turns: each turn_completion’s promptTurnSummaries, in credits. */
export const kiroCredits = (streams) =>
  streams
    .flatMap(({ events }) => events.map((e) => e?.data?.update?._meta?.kiro))
    .filter((k) => k?.kind === 'turn_completion')
    .flatMap((k) => (Array.isArray(k.promptTurnSummaries) ? k.promptTurnSummaries : []))
    .filter((t) => t?.unit === 'credit' && Number.isFinite(t.usage))
    .reduce((a, t) => a + t.usage, 0);
/** The Kiro streams with their persona: only personas on the Kiro CLI, since their settings decide what’s allowed. */
export const kiroTurns = (f) =>
  (f.kiroStreams ?? []).flatMap(({ handle, events }) => {
    const persona = Object.values(f.state.personas ?? {}).find((p) => p.handle === handle && p.backend === 'kiro-cli');
    return persona ? [{ handle, persona, events, calls: kiroCalls(events) }] : [];
  });
export const isolated = (persona) => persona.usesHostSetup === false;
// The Tools ids Kiro’s own tool kinds stand for (ACP ToolKind; server/adapters/kiro-cli.mjs, KIRO_TOOL_RULES).
export const KIRO_KIND_TOOL = { execute: 'shell', fetch: 'web.fetch' };
