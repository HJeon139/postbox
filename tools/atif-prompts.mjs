// What each turn sent its agent, in an ATIF trajectory (tools/atif.mjs): the guide Postbox appends and each prompt as
// it left for the backend (`turn.guide`, `turn.prompt`, shared/turn-prompts.mjs), as system steps, and what the
// trajectory still leaves out, in its notes and extra.scope.

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/** What a trajectory leaves out when its recording has the turns’ prompts: only what Postbox never sees. */
export const NOT_RECORDED = Object.freeze(['the system prompt the agent’s backend adds of its own (Claude Code’s, Codex’s), and its tools’ definitions']);

/**
 * What one from before prompts were recorded, or from a recording that dropped them, also leaves out (hydrant-critic’s
 * review of #1522).
 */
export const NOT_RECORDED_WITHOUT_PROMPTS = Object.freeze([
  'the system prompt Postbox and the agent’s backend gave it (its guide, persona and tools)',
  'the room’s catch-up each turn carried as background, beyond the messages that reached its inbox',
  'the exact text of each turn’s message, as its backend formatted it',
]);

/**
 * A trajectory’s notes and extra.scope, by whether its recording has the turns’ prompts, and how many of those name a
 * guide the recording lacks: Postbox records a guide once per text, so a recording begun after it, or a data folder
 * whose segment with it is gone, has the prompts and not the system prompt that went with them (hydrant-critic’s
 * review of #1522). Such a trajectory says it’s partial, and what it lost.
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

/** How many of a session’s prompts name a guide the recording lacks. @param {{ guides: Map<string, string>, prompts: { data: any }[] }} f @param {string} sessionId */
export const unresolvedGuides = (f, sessionId) =>
  f.prompts.filter((p) => p.data.sessionId === sessionId && p.data.guideSha && !f.guides.has(p.data.guideSha)).length;

/**
 * One session’s prompts as system steps, each where its event came: the guide first, whenever it differs from the one
 * before it, then the prompt. @param {{ guides: Map<string, string>, prompts: { seq: number, data: any }[] }} f @param {string} sessionId
 * @returns {{ seq: number, steps: any[] }[]}
 */
export function promptSteps(f, sessionId) {
  let shown = null;
  return f.prompts
    .filter((p) => p.data.sessionId === sessionId)
    .map(({ seq, data: d }) => {
      const steps = [];
      if (d.guideSha && d.guideSha !== shown && f.guides.has(d.guideSha)) {
        steps.push({ timestamp: iso(d.at), source: 'system', message: f.guides.get(d.guideSha), extra: { event: 'turn.guide', sha: d.guideSha } });
        shown = d.guideSha;
      }
      steps.push({
        timestamp: iso(d.at),
        source: 'system',
        message: d.text,
        extra: { event: 'turn.prompt', turn_id: d.turnId, guide_sha: d.guideSha ?? null },
      });
      return { seq, steps };
    });
}
