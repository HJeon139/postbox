// The checks for agents on the Kiro CLI (#117), and what they read of its streams, with the Antigravity CLI’s
// (#143, release runs) from server/room-checks-agy.mjs. Part of server/room-checks.mjs’s CHECKS, kept apart to keep that file to its size.

import { REFUSED, toolOf } from './adapters/kiro-cli.mjs';
import { POSTBOX_SERVER } from './adapters/setup.mjs';
import { AGY_CHECKS } from './room-checks-agy.mjs';

export { agyTokens } from './room-checks-agy.mjs';

const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ── Kiro CLI turns (#117) ──────────────────────────────────────────────────────────────────────────────
// What each Kiro turn’s stream says about its tool calls, for the checks below: one entry per toolCallId, with its
// ACP kind, its MCP server (null for Kiro’s own tools), whether it completed, and whether Kiro refused it: an ask no
// lint-allow spelling: Kiro’s value, quoted.
// one could answer headless (pending_interaction, then interaction_resolved “cancelled”), a deny rule (policyDenial),
// or Kiro’s refusal wording. Read the way server/adapters/kiro-cli.mjs reads a live turn.
function kiroCalls(events) {
  /** @type {Map<string, { id: string, kind: string|null, title: string, server: string|null, completed: boolean, refused: boolean }>} */
  const calls = new Map();
  const asked = new Set();
  const call = (u) => {
    if (!calls.has(u.toolCallId)) calls.set(u.toolCallId, { id: u.toolCallId, kind: null, title: '', server: null, completed: false, refused: false });
    return /** @type {{ id: string, kind: string|null, title: string, server: string|null, completed: boolean, refused: boolean }} */ (calls.get(u.toolCallId));
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
const kiroTurns = (f) =>
  (f.kiroStreams ?? []).flatMap(({ handle, events }) => {
    const persona = Object.values(f.state.personas ?? {}).find((p) => p.handle === handle && p.backend === 'kiro-cli');
    return persona ? [{ handle, persona, events, calls: kiroCalls(events) }] : [];
  });
const isolated = (persona) => persona.usesHostSetup === false;
// The Tools ids Kiro’s own tool kinds stand for (ACP ToolKind; server/adapters/kiro-cli.mjs, KIRO_TOOL_RULES).
const KIRO_KIND_TOOL = { execute: 'shell', fetch: 'web.fetch' };

export const BACKEND_CHECKS = [
  {
    // An Isolated Kiro persona runs with Postbox’s own Kiro home, so none of the person’s steering may load (#57).
    id: 'kiro-settings-leak',
    inputs: ['state', 'kiroStreams'],
    issue: 57,
    run: (f) => {
      const hits = kiroTurns(f).flatMap(({ handle, persona, events }) =>
        isolated(persona)
          ? events
              .map((e) => e?.data?.update?._meta?.kiro)
              .filter((k) => k?.kind === 'steering_inclusion' && Array.isArray(k.steeringDocuments) && k.steeringDocuments.length)
              .map((k) => ({ handle, n: k.steeringDocuments.length }))
          : [],
      );
      return hits.length
        ? [
            {
              title: 'An Isolated Kiro agent loaded the person’s steering files',
              evidence: hits
                .slice(0, 3)
                .map(({ handle, n }) => `@${handle} loaded ${n} steering file${n === 1 ? '' : 's'}`)
                .join('; ')
                .concat('.'),
            },
          ]
        : [];
    },
  },
  {
    // An Isolated Kiro persona denies every MCP server but Postbox’s, a server a managed install adds by itself
    // included (#57): a call to one that completed got through.
    id: 'kiro-mcp-leak',
    inputs: ['state', 'kiroStreams'],
    issue: 57,
    run: (f) => {
      const hits = kiroTurns(f).flatMap(({ handle, persona, calls }) =>
        isolated(persona) ? calls.filter((c) => c.completed && c.server && c.server !== POSTBOX_SERVER).map((c) => ({ handle, c })) : [],
      );
      return hits.length
        ? [
            {
              title: 'An Isolated Kiro agent used an MCP server other than Postbox’s',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)} (${c.server})`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Kiro can’t ask from Postbox, and a refusal leaves the turn “successful”, so the step is its only record (#65):
    // each refused call should be a denied step, under its toolCallId, in the conversation.
    id: 'kiro-refusal-not-shown',
    inputs: ['state', 'kiroStreams'],
    issue: 65,
    run: (f) => {
      const denied = new Set(
        Object.values(f.state.items ?? {})
          .flat()
          .flatMap((it) => it?.activity?.steps ?? [])
          .filter((st) => st.state === 'denied')
          .map((st) => st.id),
      );
      const hidden = kiroTurns(f).flatMap(({ handle, calls }) => calls.filter((c) => c.refused && !denied.has(c.id)).map((c) => ({ handle, c })));
      return hidden.length
        ? [
            {
              title: 'Kiro refused calls, and the conversation shows no refused step',
              evidence: `${hidden.length} refused without a step: ${hidden
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title || c.kind || c.id, 80)}`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // A Kiro call of a kind the persona’s Tools don’t tick, that ran (#5): the agent file’s deny rules didn’t hold.
    id: 'kiro-tool-not-allowed',
    inputs: ['state', 'kiroStreams'],
    issue: 5,
    run: (f) => {
      const hits = kiroTurns(f).flatMap(({ handle, persona, calls }) => {
        const has = new Set(persona.tools ?? []);
        return calls.filter((c) => c.completed && KIRO_KIND_TOOL[c.kind] && !has.has(KIRO_KIND_TOOL[c.kind])).map((c) => ({ handle, c }));
      });
      return hits.length
        ? [
            {
              title: 'Kiro agents ran tools their persona doesn’t allow',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)} (${KIRO_KIND_TOOL[c.kind]})`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  // The Antigravity CLI’s, in release runs (#143): server/room-checks-agy.mjs.
  ...AGY_CHECKS,
];
