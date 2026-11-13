// The files the person attached to the message a turn delivers, which its agent may read (#1307). An upload is stored
// in Postbox’s data folder (server/blobs.mjs), outside every agent’s folders, so reading it would need a card, which
// Kiro can’t ask for and Claude Code’s Auto may refuse. Attaching a file is the person’s ask that the agent read it, so
// each backend is let read exactly these files, never edit them, and nothing else in the data folder: Claude Code and
// the Agent SDK by an allow rule each (setup.mjs’s fromContext), Kiro by an fs_read allow (kiro-cli-agent.mjs), and
// Antigravity through its hook (agy-hook.mjs). A project file needs none: it’s in the project’s folder. A turn on a
// host reads its copies in the host turn’s folder (remote-turn.mjs), so it gets none.

/**
 * The stored path of each upload attached to the message, or to the queued messages it carries, once each.
 * @param {any} message @param {(a: any) => string | null} pathOf  where an attachment is on disk (turn-context.mjs)
 * @returns {string[]}
 */
export function attachedFiles(message, pathOf) {
  const sent = [message, ...(Array.isArray(message?.messages) ? message.messages : [])];
  const paths = sent
    .flatMap((m) => (Array.isArray(m?.attachments) ? m.attachments : []))
    .filter((a) => a?.kind === 'file')
    .map((a) => pathOf(a));
  const stored = paths.filter((p) => typeof p === 'string' && p.startsWith('/'));
  return [...new Set(/** @type {string[]} */ (stored))];
}

/** Claude Code’s allow rule for reading each one: `//` starts an absolute path in its rules. @param {string[]} files */
export const readRules = (files) => files.map((f) => `Read(/${f})`);
