// What came of each switch the person saved in an agent’s persona sheet (#1315; the runner’s agent_panel action,
// tools/uat/driver-panel.mjs): what the sheet held when Save was pressed, the agent’s next turn and which backend
// recorded it, what that backend reported as the turn’s model and effort, and the agent’s row after it. The
// backend-switch scenarios’ triggers (tools/uat/switch-triggers.mjs) and the switch checks
// (tools/uat/room-checks-panels.mjs) read the same switches from here.

import { BACKEND_NAMES, codexDefault, sameModel } from '../../shared/agent-facts.mjs';

/** Where each backend’s turns are recorded (tools/uat/run-files.mjs, runPaths), as the run’s facts hold them. */
const RECORDED = /** @type {const} */ ([
  ['streams', 'claude-code'],
  ['sdkStreams', 'agent-sdk'],
  ['codexStreams', 'codex'],
  ['kiroStreams', 'kiro-cli'],
  ['agyStreams', 'antigravity-cli'],
]);

/** The folder a backend’s turns are recorded in, for evidence. */
export const FOLDER = {
  'claude-code': 'streams/',
  'agent-sdk': 'streams/sdk/',
  codex: 'streams/codex/',
  'kiro-cli': 'streams/kiro/',
  'antigravity-cli': 'streams/agy/',
};

/** The backend a sheet’s Backend field names, as its option says it: “Kiro CLI”, or “Codex (on a host only)”. */
export const backendNamed = (/** @type {unknown} */ label) =>
  Object.keys(BACKEND_NAMES).find((id) => String(label ?? '') === BACKEND_NAMES[id] || String(label ?? '').startsWith(`${BACKEND_NAMES[id]} (`)) ?? null;

/**
 * The model and effort the backend reported for the agent’s turn (ctx.reported, kept on its session as lastModel and
 * lastEffort): the last session event in the run’s history for that agent between the turn’s start and `until`. A
 * backend that reports nothing leaves what an earlier turn reported, so this can be another backend’s.
 * @param {any[]} events @param {string} handle @param {number} from @param {number} until
 */
function reportedBetween(events, handle, from, until) {
  const kept = (events ?? []).filter(
    (e) => e?.type === 'session' && e.data?.handle === handle && typeof e.data.lastModel === 'string' && e.data.updatedAt >= from && e.data.updatedAt < until,
  );
  const last = kept.at(-1)?.data;
  return last ? { model: last.lastModel, effort: last.lastEffort ?? null } : null;
}

/**
 * @typedef {{ handle: string, at: number, chosen: { backend: string|null, model: string, effort: string }, turn: { backend: string, started: number }|null,
 *   reported: { model: string, effort: string|null }|null, latest: boolean, row: string|null }} Switch
 */

/**
 * Each saved switch, oldest first. Its turn is the first one any backend recorded for that agent after the switch and
 * before its next one. Its row is what the Agents section shows now, read only for an agent’s latest switch, since an
 * earlier one’s row has been painted over.
 * @param {any} f  the run’s facts
 * @returns {Switch[]}
 */
export function switchesOf(f) {
  const saved = (f.probes?.panels ?? []).filter((p) => p?.left?.saved === true && Number.isFinite(p.at)).sort((a, b) => a.at - b.at);
  return saved.map((p, i) => {
    const next = saved.slice(i + 1).find((q) => q.handle === p.handle);
    const until = next?.at ?? Infinity;
    const turns = RECORDED.flatMap(([key, backend]) =>
      (f[key] ?? []).filter((s) => s.handle === p.handle && s.started > p.at && s.started < until).map((s) => ({ backend, started: s.started })),
    ).sort((a, b) => a.started - b.started);
    const turn = turns[0] ?? null;
    return {
      handle: p.handle,
      at: p.at,
      chosen: { backend: backendNamed(p.left.backend), model: String(p.left.model ?? ''), effort: String(p.left.effort ?? '') },
      turn,
      reported: turn ? reportedBetween(f.events, p.handle, turn.started, until) : null,
      latest: !next,
      row: !next ? (f.ui?.agentLines?.[p.handle] ?? null) : null,
    };
  });
}

/** What a switch saved, for evidence: “agent-sdk · claude-sonnet-5-5 · low”. @param {Switch} s */
export const chosenText = (s) => `${s.chosen.backend} · ${s.chosen.model} · ${s.chosen.effort}`;

/**
 * Whether a backend reports nothing of its turn’s model or effort with this model: Kiro on its router (`auto`), whose
 * model reads as none (server/adapters/kiro-cli-models.mjs, postboxModel), and which reports effort only with a model.
 * @param {string|null} backend @param {string} model
 */
export const unreported = (backend, model) => backend === 'kiro-cli' && (!model || model === 'auto');

/**
 * How the turn after a switch differs from what was saved, in words, or null when it ran as saved (or hasn’t run). A
 * harness’s own pick (`auto`) is any model; a backend that reports nothing is judged by where its turn was recorded.
 * @param {Switch} s
 */
export function ranDiffers(s) {
  if (!s.turn) return null;
  const { backend, model, effort } = s.chosen;
  if (backend && s.turn.backend !== backend)
    return `its next turn is in ${FOLDER[/** @type {keyof typeof FOLDER} */ (s.turn.backend)]}, where ${BACKEND_NAMES[/** @type {keyof typeof BACKEND_NAMES} */ (s.turn.backend)]} records its turns.`;
  if (!s.reported || unreported(backend, model)) return null;
  if (model !== 'auto' && !codexDefault(String(backend), model) && !sameModel(s.reported.model, model)) return `its next turn reported ${s.reported.model}.`;
  if (s.reported.effort && effort && s.reported.effort !== effort) return `its next turn reported ${s.reported.effort} effort.`;
  return null;
}
