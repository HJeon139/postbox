// The checks for agents on the Antigravity CLI (#143), which runs in release runs only, and what they read of its
// streams. Part of server/room-checks.mjs’s CHECKS, through server/room-checks-backends.mjs.

import { REFUSED as AGY_REFUSED, AGY_SERVER, stepId as agyStepId } from './adapters/antigravity-cli.mjs';

const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ── Antigravity CLI turns (#143), in release runs ───────────────────────────────────────────────────
// What each Antigravity turn’s stream says about its tool steps, for the checks below: one entry per step, under the
// id Postbox gives it, with agy’s tool name, the MCP server it called (null for agy’s own tools), whether it ran and
// whether agy refused it. A refusal is a step that ended in ERROR with agy’s refusal wording, or a step the result’s
// denied_actions names that ended DONE with no output (recorded: auto mode unavailable for the account). Read the
// way server/adapters/antigravity-cli.mjs reads a live turn, but from the stream alone.
function agyCalls(events) {
  /** @type {Map<string, { id: string, name: string, title: string, server: string|null, completed: boolean, refused: boolean, output: boolean }>} */
  const calls = new Map();
  for (const e of events) {
    if (e?.event === 'result') {
      for (const a of Array.isArray(e.result?.denied_actions) ? e.result.denied_actions : []) {
        const name = String(a?.display_name ?? '')
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase();
        const c = [...calls.values()].reverse().find((x) => x.name === name && x.completed && !x.output);
        if (c) Object.assign(c, { completed: false, refused: true });
      }
      continue;
    }
    const st = e?.event === 'step_update' ? e.step_update : null;
    if (st?.step_type !== 'tool') continue;
    const id = agyStepId(st);
    const p = st.tool_info?.parameters ?? {};
    const name = String(st.tool_name ?? st.tool_info?.name ?? '');
    if (!calls.has(id))
      calls.set(id, {
        id,
        name,
        title: name === 'call_mcp_tool' ? `${p.ToolName} (${p.ServerName})` : `${name} ${p.CommandLine ?? p.Url ?? p.Path ?? ''}`.trim(),
        server: name === 'call_mcp_tool' ? String(p.ServerName ?? '') || null : null,
        completed: false,
        refused: false,
        output: false,
      });
    const c = /** @type {any} */ (calls.get(id));
    if (st.state === 'DONE') Object.assign(c, { completed: true, output: st.tool_info?.output !== undefined });
    if (st.state === 'ERROR' && AGY_REFUSED.test(String(st.tool_info?.error?.message ?? ''))) c.refused = true;
  }
  return [...calls.values()];
}
/** The tokens Antigravity used over a run’s turns: each model call’s, from its agent_response step. A result’s
 * usage counts the whole conversation so far, so it isn’t added up. */
export const agyTokens = (streams) =>
  streams
    .flatMap(({ events }) =>
      events.map((e) => (e?.event === 'step_update' && e.step_update?.step_type === 'agent_response' ? e.step_update.usage?.total_tokens : null)),
    )
    .filter((n) => Number.isFinite(n))
    .reduce((a, n) => a + n, 0);
/** The Antigravity streams with their persona: only personas on the Antigravity CLI. */
const agyTurns = (f) =>
  (f.agyStreams ?? []).flatMap(({ handle, events }) => {
    const persona = Object.values(f.state.personas ?? {}).find((p) => p.handle === handle && p.backend === 'antigravity-cli');
    return persona ? [{ handle, persona, events, calls: agyCalls(events) }] : [];
  });
// The Tools ids agy’s own tools stand for. agy can’t turn them off for one agent; the agent is only told.
const AGY_TOOL = /** @type {Record<string, string>} */ ({ run_command: 'shell', read_url_content: 'web.fetch', search_web: 'web.fetch' });
/** The ids of the conversation’s refused steps, as Postbox shows them. */
const deniedSteps = (f) =>
  new Set(
    Object.values(f.state.items ?? {})
      .flat()
      .flatMap((it) => it?.activity?.steps ?? [])
      .filter((st) => st.state === 'denied')
      .map((st) => st.id),
  );

export const AGY_CHECKS = [
  {
    // Antigravity can’t ask from Postbox, and a refusal ends the turn with no reply, so the step is its only record
    // (#65): each refused call should be a denied step, under its id, in the conversation.
    id: 'agy-refusal-not-shown',
    inputs: ['state', 'agyStreams'],
    issue: 65,
    run: (f) => {
      const denied = deniedSteps(f);
      const hidden = agyTurns(f).flatMap(({ handle, calls }) => calls.filter((c) => c.refused && !denied.has(c.id)).map((c) => ({ handle, c })));
      return hidden.length
        ? [
            {
              title: 'Antigravity refused calls, and the conversation shows no refused step',
              evidence: `${hidden.length} refused without a step: ${hidden
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)}`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Postbox’s own tools need the allow rule the adapter adds to the person’s agy settings (#143). Refused, the
    // agent can’t show anything in the room.
    id: 'agy-postbox-refused',
    inputs: ['state', 'agyStreams'],
    issue: 143,
    run: (f) => {
      const hits = agyTurns(f).flatMap(({ handle, calls }) => calls.filter((c) => c.refused && c.server === AGY_SERVER).map((c) => ({ handle, c })));
      return hits.length
        ? [
            {
              title: 'Antigravity refused Postbox’s own tools',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)}`)
                .join('; ')}. The allow rule for ${AGY_SERVER} is missing from the agy settings.`,
            },
          ]
        : [];
    },
  },
  {
    // agy can’t turn a tool off for one agent, so the agent is told not to use the ones its persona doesn’t tick
    // (#5). One that ran anyway is the agent ignoring that.
    id: 'agy-tool-not-allowed',
    inputs: ['state', 'agyStreams'],
    issue: 5,
    run: (f) => {
      const hits = agyTurns(f).flatMap(({ handle, persona, calls }) => {
        const has = new Set(persona.tools ?? []);
        return calls.filter((c) => c.completed && AGY_TOOL[c.name] && !has.has(AGY_TOOL[c.name])).map((c) => ({ handle, c }));
      });
      return hits.length
        ? [
            {
              title: 'Antigravity agents used tools their persona turned off',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)} (${AGY_TOOL[c.name]})`)
                .join('; ')}. Antigravity can’t turn them off; the agent was told not to use them.`,
            },
          ]
        : [];
    },
  },
];
