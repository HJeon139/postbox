// What git push said it did, read from its own output (#978).

/** @typedef {{ remote: string|null, refs: string[], branch: string }} Push branch: the first branch it sent to, or ''. */

// At most this many pushes from one command: each is a Work entry, and the command’s own text sets how many
// reports there are (server/AGENTS.md: arrays are capped at the boundary).
const MAX_PUSHES = 100;
// A ref git push reports as sent: a new one, or old..new, then `src -> dst`. Rejected and up-to-date ones aren’t.
const SENT_REF = /^\s*[*+\-!= ]?\s*(\[new [a-z]+\]|[0-9a-f]{7,64}\.\.\.?[0-9a-f]{7,64})\s+(\S+)\s+->\s+(\S+)/gm;

/**
 * The pushes in git push’s output: each `To <remote>` line starts one, and holds the refs it sent up to the next.
 * With none that sent a ref, the one push, with the remote git named if any. At most MAX_PUSHES. O(output).
 * @returns {Push[]}
 */
export function pushesIn(out) {
  const reports = out.split(/^(?=To \S)/m).filter((part) => part.startsWith('To '));
  const pushes = reports.map((part) => {
    const sent = [...part.matchAll(SENT_REF)];
    return {
      remote: /^To (\S+)/.exec(part)?.[1] ?? null,
      refs: sent.map((m) => `${m[2]} → ${m[3]}`),
      branch: sent.find((m) => !isTag(m))?.[3] ?? '',
    };
  });
  const landed = pushes.filter((p) => p.refs.length > 0);
  if (landed.length) return landed.slice(0, MAX_PUSHES);
  return [{ remote: pushes[0]?.remote ?? null, refs: [], branch: '' }];
}

/** Whether a sent ref is a tag: git says `[new tag]`, or its destination is named in full under refs/tags/. */
function isTag(m) {
  return m[1] === '[new tag]' || m[3].startsWith('refs/tags/');
}
