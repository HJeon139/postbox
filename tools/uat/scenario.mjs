// A UAT scenario: a Markdown file with a title, a few “- key: value” settings, a summary, and one
// “## Phase” section per phase (see tests/uat/e2e/scenarios/).
//
// `- backends: critic=kiro-cli:gpt-5.6-terra, researcher=claude-code` puts agents on a backend other than the one a
// fresh install picks, with a model if one follows the colon (#117). Agents it doesn’t name keep the default.

/** @returns {Record<string, { backend: string, model: string|null }>} */
function backendsOf(spec) {
  /** @type {Record<string, { backend: string, model: string|null }>} */
  const out = {};
  for (const part of String(spec ?? '').split(/,\s*/)) {
    const m = /^@?([\w-]+)=([\w-]+)(?::([\w.:-]+))?$/.exec(part.trim());
    if (m) out[m[1]] = { backend: m[2], model: m[3] ?? null };
  }
  return out;
}

function permissionModesOf(spec) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(spec ?? '').split(/,\s*/)) {
    const m = /^@?([\w-]+)=(auto|ask|acceptEdits|bypass)$/.exec(part.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function parseScenario(md) {
  const [head, ...phases] = md.split(/\n(?=## )/);
  const lines = head.split('\n');
  const meta = Object.fromEntries(
    lines
      .filter((l) => /^- \w+: /.test(l))
      .map((l) =>
        l
          .slice(2)
          .split(/: (.*)/s)
          .slice(0, 2),
      ),
  );
  return {
    title: lines[0].replace(/^#\s*/, ''),
    persona: meta.persona ?? 'A researcher.',
    agents: (meta.agents ?? 'researcher').split(/,\s*/),
    project: meta.project ?? 'UAT',
    conversation: meta.conversation ?? 'UAT',
    backends: backendsOf(meta.backends),
    permissionModes: permissionModesOf(meta.permission_modes),
    summary: lines.filter((l) => l && !l.startsWith('#') && !/^- \w+: /.test(l)).join('\n'),
    phases: phases.map((p) => ({ title: p.split('\n')[0].replace(/^##\s*/, ''), text: p.split('\n').slice(1).join('\n').trim() })),
  };
}
