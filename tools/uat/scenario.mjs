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
// A backend can also be kept to version releases (RELEASE_ONLY): `--release`. Outside a release run, a scenario that
// puts an agent on one is refused, and Postbox starts without it, so the tester can’t pick it in a sheet either. None is
// today. The Antigravity CLI (#143) was, while it ran on a free tier; since 25 October 2026 the maintainer pays for it,
// so it runs with --compat like Codex and the Kiro CLI.
//
// How long a run is (see tests/uat/e2e/README.md, “How long a run is”): `- steps: N` in the header caps a scenario’s
// steps, and --steps overrides it. A phase can open with its own settings, before its text:
//   - triggers: wake-full-text, stop-keep-jobs   what Postbox must show for the phase to be done (tools/uat/triggers.mjs)
//   - steps: 10                                  the most steps the phase gets before the run records a coverage gap
// A phase with triggers ends when they’ve all happened, or at its cap. One without works as it always has: the tester
// says when it’s done.
//
// Host mode (#120, tools/uat/hosts-options.mjs): `- place: researcher=host1, critic=local` puts agents on the hosts a
// run names with --host, and `- launcher: tools/uat/claude-launcher.mjs` puts P0’s launcher in front of Claude Code on
// each host an agent is placed on. A run without --host ignores both. A phase can say what changes when one agent runs
// on a host: `- host: researcher` names it, `- host-triggers: …` replace its triggers then, and the text under a
// `### On a host` heading replaces the phase’s text then (tools/uat/hosts-scenario.mjs).

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

/** `researcher=host1, critic=local`: where each agent runs in host mode. @returns {Record<string, string>} */
export function placesOf(spec) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(spec ?? '').split(/,\s*/)) {
    const m = /^@?([\w-]+)=(host\d+|local)$/.exec(part.trim());
    if (m) out[m[1]] = m[2];
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
    place: placesOf(meta.place),
    launcher: meta.launcher?.trim() || null,
    // `- models: persona` keeps each persona’s own model and effort, for scenarios that measure what agents choose
    // (M1’s exit check, #63). Without it, a run puts the agents on the fast model it’s given (--agent-model).
    models: meta.models === 'persona' ? 'persona' : 'run',
    // Telemetry (designs/telemetry-persona.md, U2): `- seed: canaries` plants the run’s canaries in the workspace,
    // `- gh: none` starts Postbox with no gh, and `- telemetry: manual` leaves recording to the scenario. `- seed:
    // fake-env` plants the allow-once scenario’s fake .env (tools/uat/workspace.mjs).
    seed: meta.seed ?? null,
    gh: meta.gh === 'none' ? 'none' : 'yes',
    telemetry: meta.telemetry === 'manual' ? 'manual' : 'runner',
    summary: lines.filter((l) => l && !l.startsWith('#') && !/^- \w+: /.test(l)).join('\n'),
    steps: count(meta.steps),
    phases: phases.map(phaseOf),
  };
}

/** Compatibility backends that run only for a version release, and the variable that names each one’s binary. */
export const RELEASE_ONLY = /** @type {Record<string, { name: string, bin: string }>} */ ({});
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
      error: `This scenario puts ${on.map(([h, b]) => `@${h} on ${RELEASE_ONLY[b.backend].name}`).join(', ')}, which runs only for a version release. Pass --release for the release’s run.`,
      env: {},
    };
  return { error: null, env: Object.fromEntries(Object.values(RELEASE_ONLY).map((b) => [b.bin, NO_BIN])) };
}

// ── How long a run is ──────────────────────────────────────────────────────────────────────

/**
 * The steps an exploratory run gets unless its scenario or --steps says otherwise. Fifteen steps found about 89% of
 * what twenty did over the first 11 runs, and the tester’s new findings per step fell from 0.26 (steps 1–5) to 0.09
 * (steps 16–20). Refit it with `node tools/uat-stats.mjs` as runs accumulate.
 */
export const DEFAULT_STEPS = 15;
/** The steps a phase with triggers gets unless it says otherwise: the P0 run hit each fix within about 10 turns. */
export const PHASE_STEPS = 8;

/** A whole number from 1 to 500, or null. */
const count = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
};

/** A list of trigger ids, as a phase names them. @param {string|undefined} spec */
const triggerList = (spec) =>
  (spec ?? '')
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * A phase: its title, its own settings (the lines “- triggers: …” and “- steps: N” before its text, and in host mode
 * “- host: …” and “- host-triggers: …”), and its text, with what replaces it when that agent runs on a host.
 * @param {string} p  the phase’s section, from its “## ” heading
 * @returns {{ title: string, text: string, triggers: string[], steps: number|null, host: string|null, hostTriggers: string[], hostText: string }}
 */
function phaseOf(p) {
  const [heading, ...rest] = p.split('\n');
  /** @type {Record<string, string>} */
  const meta = {};
  let i = 0;
  for (; i < rest.length; i++) {
    const m = /^- (triggers?|steps|host|host-triggers): (.*)$/.exec(rest[i]);
    if (m) meta[m[1].replace(/s$/, '')] = m[2].trim();
    else if (rest[i].trim()) break;
  }
  const [text, hostText = ''] = rest
    .slice(i)
    .join('\n')
    .split(/^### On a host[ \t]*$/m);
  return {
    title: heading.replace(/^##\s*/, ''),
    text: text.trim(),
    triggers: triggerList(meta.trigger),
    steps: count(meta.step),
    host: meta.host?.replace(/^@/, '') || null,
    hostTriggers: triggerList(meta['host-trigger']),
    hostText: hostText.trim(),
  };
}

/** Whether a scenario is targeted: every phase names what it must cause. Otherwise it’s exploratory. */
export const isTargeted = (scenario) => scenario.phases.length > 0 && scenario.phases.every((p) => (p.triggers ?? []).length > 0);

/** The most steps a phase with triggers gets; null for one without, which ends when the tester says. */
export const phaseCap = (phase) => ((phase.triggers ?? []).length ? (phase.steps ?? PHASE_STEPS) : null);

/**
 * The most steps a run takes: --steps, else the scenario’s own `- steps: N`, else the sum of a targeted scenario’s
 * phase caps, else DEFAULT_STEPS.
 * @param {{ steps?: number|null, phases: { triggers?: string[], steps?: number|null }[] }} scenario
 * @param {string|number|undefined} [flag]  --steps, when given
 */
export function stepCap(scenario, flag) {
  const n = count(flag);
  if (n) return n;
  if (flag !== undefined && flag !== null && flag !== '') throw new Error(`--steps takes a whole number from 1 to 500, not “${flag}”.`);
  if (scenario.steps) return scenario.steps;
  if (isTargeted(scenario)) return scenario.phases.reduce((a, p) => a + /** @type {number} */ (phaseCap(p)), 0);
  return DEFAULT_STEPS;
}
