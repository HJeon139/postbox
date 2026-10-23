// A UAT scenario: a Markdown file with a title, a few “- key: value” settings, a summary, and one
// “## Phase” section per phase (see tests/uat/e2e/scenarios/).
//
// `- backends: critic=kiro-cli:gpt-5.6-terra, researcher=claude-code` puts agents on a backend other than the one a
// fresh install picks, with a model if one follows the colon (#117). Agents it doesn’t name keep the default.
//
// Some backends run only for a version release (RELEASE_ONLY): `node tools/uat-run.mjs --release`. The Antigravity
// CLI (#143) is on a free tier, and a run for every merge would use up its quota. Outside a release run, a scenario
// that puts an agent on one is refused, and Postbox starts without it, so the tester can’t pick it in a sheet either.

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
    summary: lines.filter((l) => l && !l.startsWith('#') && !/^- \w+: /.test(l)).join('\n'),
    phases: phases.map((p) => ({ title: p.split('\n')[0].replace(/^##\s*/, ''), text: p.split('\n').slice(1).join('\n').trim() })),
  };
}

/** Backends whose scenarios run only for a version release, and the variable that names each one’s binary. */
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
  const on = Object.entries(scenario.backends).filter(([, b]) => Object.hasOwn(RELEASE_ONLY, b.backend));
  if (on.length)
    return {
      error: `This scenario puts ${on.map(([h, b]) => `@${h} on ${RELEASE_ONLY[b.backend].name}`).join(', ')}, which runs only for a version release: its quota is a free tier. Pass --release for the release’s run.`,
      env: {},
    };
  return { error: null, env: Object.fromEntries(Object.values(RELEASE_ONLY).map((b) => [b.bin, NO_BIN])) };
}
