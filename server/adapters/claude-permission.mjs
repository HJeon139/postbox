// Plain summaries and details for Claude permission cards, shared by local, SDK and remote prompts.

const clip = (value, n) => {
  const text = String(value ?? '');
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};
const base = (path) => String(path ?? '').replace(/^.*\//, '');

/** What a tool call would do, for the permission card: a short summary and the detail. */
export function describePermission(name, input = {}) {
  const i = input ?? {};
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
        detail: JSON.stringify(i, null, 2).slice(0, 4000),
      };
  }
}
