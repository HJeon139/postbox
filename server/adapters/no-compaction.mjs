// /compact for a backend with no compaction Postbox can run in a headless turn (#1811, #1812). The composer sends it
// as a command (server/agent-commands.mjs), and an adapter that doesn’t act on it passed it to the model as a prompt,
// which compacted nothing. Kiro CLI lists /compact only for its interactive chat, and its headless run has no
// compaction option (kiro-cli 3.6.2); Antigravity names none (agy 1.5.18), and Postbox runs it with
// --disable-slash-commands. So their adapters refuse it before it’s posted, through the hook Codex uses for a
// conversation not started yet (#425), and say why.

const COMPACT = /^\/compact(?:\s|$)/;

/**
 * An adapter’s `refuses` for a harness with no compaction: /compact, alone or with words after it, is refused with the
 * reason; any other command goes on. @param {string} harness  its name, as the person knows it
 */
export const noCompaction = (harness) => (/** @type {string} */ line, /** @type {any} */ _state, /** @type {string} */ handle) =>
  COMPACT.test(String(line ?? '')) ? `@${handle} can’t compact its conversation: ${harness} has no compaction Postbox can run.` : null;
