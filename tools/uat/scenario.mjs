// A UAT scenario: a Markdown file with a title, a few “- key: value” settings, a summary, and one
// “## Phase” section per phase (see tests/uat/e2e/scenarios/).
//
// `- backends: critic=kiro-cli:gpt-5.6-terra, researcher=claude-code` puts agents on a backend other than the one a
// fresh install picks, with a model if one follows the colon (#117). Agents it doesn’t name keep the default.
//
// A scenario that puts an agent on a backend other than Claude’s (the Kiro CLI today; agy and Codex as they come) is a
// compatibility run. It checks that a harness still works with Postbox, and it costs that harness’s credits, so it runs
// only when asked (--compat), never as part of a regular pass.
//
// Some of those also run only for a version release (RELEASE_ONLY): `--release`. The Antigravity CLI (#143) is on a
// free tier, and even an occasional compatibility run would use up its quota. Outside a release run, a scenario that
// puts an agent on one is refused, and Postbox starts without it, so the tester can’t pick it in a sheet either.

/** The backends that run Claude. Every other one makes a scenario a compatibility run. */
export const CLAUDE_BACKENDS = new Set(['claude-code', 'agent-sdk']);

/**
 * The backends other than Claude’s that a scenario puts agents on: empty for a regular scenario.
 * @param {{ backends: Record<string, { backend: string }> }} scenario
 */
export const compatBackends = (scenario) => [...new Set(Object.values(scenario.backends).map((b) => b.backend))].filter((b) => !CLAUDE_BACKENDS.has(b));

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

/** Compatibility backends that run only for a version release, and the variable that names each one’s binary. */
export const RELEASE_ONLY = /** @type {Record<string, { name: string, bin: string }>} */ ({
  'antigravity-cli': { name: 'the Antigravity CLI', bin: 'POSTBOX_AGY_BIN' },
});
// A binary that isn’t there, so Postbox doesn’t register the backend.
const NO_BIN = '/nonexistent/postbox-release-only';

/**
 * What a run may use. A release run uses everything. Otherwise a scenario that puts an agent on a release-only
 * backend is an error, and the environment points each one’s binary at nothing.
 * @param {{ backends: Record<string, { backend: string }> }} scenario @param {{ release?: boolean }} [opts]
 * @returns {{ error: string|null, env: Record<string, string> }}
 */
export function releaseGate(scenario, { release = false } = {}) {
  if (release) return { error: null, env: {} };
  const gated = new Set(compatBackends(scenario).filter((b) => Object.hasOwn(RELEASE_ONLY, b)));
  const on = Object.entries(scenario.backends).filter(([, b]) => gated.has(b.backend));
  if (on.length)
    return {
      error: `This scenario puts ${on.map(([h, b]) => `@${h} on ${RELEASE_ONLY[b.backend].name}`).join(', ')}, which runs only for a version release: its quota is a free tier. Pass --release for the release’s run.`,
      env: {},
    };
  return { error: null, env: Object.fromEntries(Object.values(RELEASE_ONLY).map((b) => [b.bin, NO_BIN])) };
}
