// What Postbox builds from a turn’s tool calls, for every backend. Moved from server/adapters/claude-stream.mjs.

export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export const JOB_STATES = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped' };

export const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The first sentence of a message, such as a refusal’s reason. */
export const firstSentence = (s, n = 300) => clip(/^[\s\S]*?[.!?](?=\s|$)/.exec(String(s ?? '').trim())?.[0] ?? s, n);

/** What a subagent was asked to do, in a line: its call’s description, else its prompt’s first sentence. */
export const askedOf = (input) => clip(input?.description || firstSentence(input?.prompt ?? '', 120), 120);
