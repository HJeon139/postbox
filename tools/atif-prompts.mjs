// What each turn sent its agent, in an ATIF trajectory (tools/atif.mjs): the guide Postbox gives the backend and each
// prompt as the backend got it, from the run’s prompts.jsonl (#1528, server/turn-prompt.mjs; its rows are in
// tests/uat/e2e/README.md, in what a run holds), the guide as a system step and each prompt as its turn’s user step,
// and what the trajectory still leaves out, in its notes and extra.scope. The file isn’t in the store, so its rows
// have no place among the events: each prompt goes where its turn first shows in them (placePrompts).

// A step with no time keeps none, rather than losing every trajectory of the run: ATIF’s timestamp is optional.
const iso = (/** @type {unknown} */ ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/**
 * What a trajectory leaves out when its recording has the turns’ prompts: what Postbox never sees, which the backend
 * adds or loads itself (designs/architecture/agent-setup.md: each agent runs with the person’s own setup). Not a list
 * of what loaded, which Postbox doesn’t know; the kinds it can be.
 */
export const NOT_RECORDED = Object.freeze([
  'the system prompt the agent’s backend adds of its own (Claude Code’s, Codex’s, Kiro’s, Antigravity’s), and its tools’ definitions',
  'the instructions and resources the backend loads itself from the person’s and the project’s setup: CLAUDE.md and AGENTS.md files, Kiro’s steering, skills, plugins and settings, and the MCP servers they add, with their tools',
  'what the backend keeps of earlier turns, and how it compacts them',
]);

/**
 * What a recording without prompts.jsonl also leaves out: one made outside UAT recording mode (#1528), or from before it.
 */
export const NOT_RECORDED_WITHOUT_PROMPTS = Object.freeze([
  'the system prompt Postbox and the agent’s backend gave it (its guide, persona and tools)',
  'the room’s catch-up each turn carried as background, beyond the messages that reached its inbox',
  'the exact text of each turn’s message, as its backend formatted it',
]);

/**
 * A trajectory’s notes and extra.scope, by whether its recording has the turns’ prompts, and how many of those name a
 * guide the recording lacks: Postbox records a guide once per session and text, so a file cut short has the prompts
 * and not the system prompt that went with them. Such a trajectory says it’s partial, and what it lost.
 * @param {boolean} prompts @param {number} [unresolved]  prompts whose guide the recording lacks
 */
export function scopeOf(prompts, unresolved = 0) {
  const lost = unresolved
    ? [
        `the system prompt Postbox appended to ${unresolved === 1 ? 'one of its prompts' : `${unresolved} of its prompts`}, whose guide came before this recording began`,
      ]
    : [];
  const left = prompts ? [...lost, ...NOT_RECORDED] : NOT_RECORDED_WITHOUT_PROMPTS;
  const record = prompts ? 'postbox-conversation-and-prompts' : 'postbox-conversation';
  const notes = prompts
    ? `${unresolved ? 'Partial: ' : ''}Built from Postbox’s conversation record, with each turn’s prompt as Postbox sent it. It leaves out ${left.join('; ')}.`
    : `Built from Postbox’s conversation record, not from each turn’s exact prompt: it leaves out ${left.join('; ')}.`;
  return { notes, extra: { scope: { record, not_recorded: left, ...(unresolved ? { unresolved_guides: unresolved } : {}) } } };
}

/** The turns of a session whose prompt the recording has. @param {{ prompts: { data: any }[] }} f @param {string} sessionId */
export const promptedTurns = (f, sessionId) => new Set(f.prompts.filter((p) => p.data.sessionId === sessionId).map((p) => p.data.turnId));

/** How many of a session’s prompts name a guide the recording lacks. @param {{ guides: Map<string, string>, prompts: { data: any }[] }} f @param {string} sessionId */
export const unresolvedGuides = (f, sessionId) =>
  f.prompts.filter((p) => p.data.sessionId === sessionId && p.data.guideSha && !f.guides.has(p.data.guideSha)).length;

/**
 * One session’s prompts as steps, each at its place (placePrompts): the guide, Postbox’s system prompt, as a system
 * step whenever it differs from the one before it; then the prompt, which is what the backend got as the user’s
 * message, as a user step, with the room’s messages it carried as its provenance (`delivered`).
 * @param {{ guides: Map<string, string>, prompts: { seq: number, data: any }[] }} f @param {string} sessionId
 * @param {Map<string, any[]>} [delivered]  what each turn took from the inbox, by turn id
 * @returns {{ seq: number, steps: any[] }[]}
 */
export function promptSteps(f, sessionId, delivered = new Map()) {
  let shown = null;
  return f.prompts
    .filter((p) => p.data.sessionId === sessionId)
    .map(({ seq, data: d }) => {
      const steps = [];
      if (d.guideSha && d.guideSha !== shown && f.guides.has(d.guideSha)) {
        steps.push({ timestamp: iso(d.at), source: 'system', message: f.guides.get(d.guideSha), extra: { record: 'guide', sha: d.guideSha } });
        shown = d.guideSha;
      }
      const carried = delivered.get(d.turnId) ?? [];
      steps.push({
        timestamp: iso(d.at),
        source: 'user',
        message: d.text,
        extra: { record: 'prompt', turn_id: d.turnId, guide_sha: d.guideSha ?? null, ...(carried.length ? { delivered: carried } : {}) },
      });
      return { seq, steps };
    });
}

/**
 * prompts.jsonl’s rows into the fold (tools/atif.mjs, foldEvents): each guide by its hash, and each prompt with a place
 * among the events, just before its turn’s first item, else its turn’s end, else its start in the work ledger, else
 * after the last item added before it was sent. A turn’s later prompt goes after the turn’s last item added before it
 * was sent, so a follow-up comes after what it answers; several keep their order.
 * @param {{ guides: Map<string, string>, prompts: { seq: number, data: any }[], order: { seq: number, id: string }[], items: Map<string, any>, work: Map<string, any> }} f
 * @param {any[]} rows
 */
export function placePrompts(f, rows) {
  const first = new Map();
  for (const { seq, id } of f.order) {
    const turnId = f.items.get(id)?.turnId;
    if (turnId && !first.has(turnId)) first.set(turnId, seq);
  }
  const counted = new Map();
  for (const r of rows) {
    if (r?.type === 'guide' && typeof r.sha === 'string' && typeof r.text === 'string') f.guides.set(r.sha, r.text);
    if (r?.type !== 'prompt' || typeof r.text !== 'string' || typeof r.turnId !== 'string') continue;
    const turn = f.work.get(r.turnId);
    const byTime = f.order.findLast(({ id }) => (f.items.get(id)?.at ?? Number.POSITIVE_INFINITY) <= r.at)?.seq;
    const at = first.get(r.turnId) ?? turn?.to ?? (turn ? turn.from + 1 : undefined) ?? (byTime ?? -1) + 1;
    const k = counted.get(r.turnId) ?? 0;
    counted.set(r.turnId, k + 1);
    // A later prompt of the turn (Antigravity’s follow-up after a refusal) goes after what the turn showed by then.
    const shown = k ? f.order.findLast(({ id }) => f.items.get(id)?.turnId === r.turnId && f.items.get(id).at <= r.at) : undefined;
    f.prompts.push({ seq: shown ? shown.seq + 0.5 + k / 1000 : at - 0.5 + k / 1000, data: r });
  }
}
