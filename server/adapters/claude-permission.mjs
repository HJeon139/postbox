// Plain summaries and details for Claude permission cards, shared by local, SDK and remote prompts.

const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (path) => String(path ?? '').replace(/^.*\//, '');
/** As much of a detail as a card keeps (permission-cards.mjs’s writeOf). */
const DETAIL_MAX = 4000;
const NO_PATH = 'This call’s path isn’t text, or it names none, so Postbox can’t say where it reads.';
/** A string clipped to n characters by its middle, with a … there, so its start and its end, a file’s name, both show. */
const clipMiddle = (s, n) => (s.length > n ? `${s.slice(0, Math.ceil((n - 1) / 2))}…${s.slice(s.length - Math.floor((n - 1) / 2))}` : s);

/**
 * A read card’s detail when it names several paths, as Antigravity’s hook sends a grep_search’s Path and SearchPath
 * (#1074): one a line, each clipped on its own, so a long one can’t push another past what the card keeps.
 * @param {unknown[]} paths
 */
function pathLines(paths) {
  const each = Math.floor((DETAIL_MAX - paths.length + 1) / paths.length);
  return paths.map((p) => clipMiddle(String(p), each)).join('\n');
}

/** What a tool call would do, for the permission card: a short summary and the detail. */
export function describePermission(name, input = {}) {
  const i = input ?? {};
  // Its paths, not file_path again, which repeats the first; or, as Antigravity’s hook sends for a path that’s a list
  // or a number, or for none, that it can’t name one (#1074).
  if (name === 'Read' && Array.isArray(i.paths) && i.paths.length) return { summary: 'use Read', detail: pathLines(i.paths) };
  if (name === 'Read' && i.file_path === '') return { summary: 'use Read', detail: NO_PATH };
  switch (name) {
    case 'Bash':
      return { summary: i.description ? `run a command: ${clip(i.description, 80)}` : 'run a command', detail: String(i.command ?? '') };
    case 'Write':
      return { summary: `write ${base(i.file_path)}`, detail: String(i.file_path ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return { summary: `edit ${base(i.file_path)}`, detail: String(i.file_path ?? '') };
    case 'NotebookEdit':
      return { summary: `edit ${base(i.notebook_path)}`, detail: String(i.notebook_path ?? '') };
    case 'WebFetch':
      return { summary: `fetch ${clip(String(i.url ?? '').replace(/^https?:\/\//, ''), 60)}`, detail: String(i.url ?? '') };
    case 'WebSearch':
      return { summary: `search the web for “${clip(i.query, 60)}”`, detail: String(i.query ?? '') };
    default:
      return {
        summary: `use ${String(name)
          .replace(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/, '$2 from $1')
          .replace(/_/g, ' ')}`,
        detail: JSON.stringify(i, null, 2).slice(0, DETAIL_MAX),
      };
  }
}
