// The backend-switch scenarios’ triggers (#1315, tests/uat/e2e/scenarios/switch.md and switch-compat.md;
// tools/uat/triggers.mjs has what a trigger is). The person switches one agent’s backend, model and effort in its
// persona sheet, and it takes a turn. For each target, two triggers:
// - ran-<target>: the turn after the switch was recorded by the chosen backend (its streams folder), and that backend
//   reported the chosen model and effort for it;
// - shown-<target>: the sheet saved the chosen backend, model and effort, and after the turn the agent’s row in the
//   Agents section names that model and effort, with no “not …” or “set to …”.
// A turn that ran right but shows wrong fires the first and not the second, which says the UI is at fault.

import { modelName } from '../../shared/agent-facts.mjs';
import { chosenText, FOLDER, switchesOf, unreported } from './switch-facts.mjs';
import { clip } from './trigger-facts.mjs';

/**
 * Each target: the backend; the model, as a Claude family (“sonnet”), an exact id, or `auto` for the harness’s own
 * pick (Codex’s default, Kiro’s router); the effort, or null for whatever the sheet left it at (a switch of the
 * backend alone, which resets it). Where the backend reports neither (unreported, tools/uat/switch-facts.mjs), the
 * records show only which backend ran the turn.
 * @type {Record<string, { backend: string, model: string, effort: string|null }>}
 */
export const SWITCH_TARGETS = {
  // Claude only: each Claude model on each Claude backend, with every effort used once (switch.md).
  'sdk-sonnet-low': { backend: 'agent-sdk', model: 'sonnet', effort: 'low' },
  'cc-haiku-high': { backend: 'claude-code', model: 'haiku', effort: 'high' },
  'sdk-opus-max': { backend: 'agent-sdk', model: 'opus', effort: 'max' },
  'cc-sonnet-xhigh': { backend: 'claude-code', model: 'sonnet', effort: 'xhigh' },
  'sdk-haiku-medium': { backend: 'agent-sdk', model: 'haiku', effort: 'medium' },
  'cc-opus-low': { backend: 'claude-code', model: 'opus', effort: 'low' },
  // Across every backend and back (switch-compat.md).
  'codex-auto-high': { backend: 'codex', model: 'auto', effort: 'high' },
  'cc-backend-only': { backend: 'claude-code', model: 'opus', effort: null },
  'kiro-auto-high': { backend: 'kiro-cli', model: 'auto', effort: 'high' },
  'agy-flash-high': { backend: 'antigravity-cli', model: 'gemini-3.8-flash-high', effort: 'high' },
  'cc-haiku-max': { backend: 'claude-code', model: 'haiku', effort: 'max' },
};

/**
 * The backends a scenario’s phases switch an agent to, by the switch triggers they name. One other than Claude’s makes
 * the scenario a compatibility run, as starting an agent there does (tools/uat/scenario.mjs, compatBackends).
 * @param {{ phases: { triggers?: string[] }[] }} scenario
 */
export const switchedTo = (scenario) =>
  scenario.phases
    .flatMap((p) => p.triggers ?? [])
    .map((id) => SWITCH_TARGETS[id.replace(/^(ran|shown)-/, '')]?.backend)
    .filter((b) => typeof b === 'string');

const FAMILY = /^[a-z]+$/;
/**
 * Whether a model id is the target’s: of its Claude family, or the id itself. `auto` is any model the harness picks.
 * @param {string} want @param {unknown} id
 */
function isModel(want, id) {
  if (want === 'auto') return true;
  if (FAMILY.test(want)) return new RegExp(`^claude-${want}-`).test(String(id ?? ''));
  return String(id ?? '') === want;
}
/** The sheet held the target: `auto` must be saved as `auto`, not as a model of the harness’s. */
const chose = (/** @type {any} */ t, /** @type {import('./switch-facts.mjs').Switch} */ s) =>
  s.chosen.backend === t.backend &&
  (t.model === 'auto' ? s.chosen.model === 'auto' : isModel(t.model, s.chosen.model)) &&
  (!t.effort || s.chosen.effort === t.effort);

const EFFORT_WORDS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };
/**
 * What the row must name for the model: the family (“Sonnet 5.5”), Codex’s default, or the id. Null when any will do:
 * Kiro’s router names no model.
 * @param {{ backend: string, model: string }} t
 */
function rowModel(t) {
  if (t.model === 'auto') return t.backend === 'codex' ? modelName('codex', 'auto') : null;
  if (FAMILY.test(t.model)) return `${t.model[0].toUpperCase()}${t.model.slice(1)} `;
  return t.model;
}

/**
 * The switches to this target whose turn ran as chosen.
 * @param {any} t @param {any} f
 */
function ran(t, f) {
  return switchesOf(f).filter((s) => {
    if (!chose(t, s) || s.turn?.backend !== t.backend) return false;
    if (unreported(t.backend, t.model)) return true;
    const effort = t.effort ?? s.chosen.effort;
    return !!s.reported && isModel(t.model, s.reported.model) && s.reported.effort === effort;
  });
}

/**
 * The switches to this target whose agent’s row, after the turn, names what was chosen.
 * @param {any} t @param {any} f
 */
function shown(t, f) {
  return switchesOf(f).filter((s) => {
    if (!chose(t, s) || !s.turn || !s.latest || !s.row) return false;
    const effort = EFFORT_WORDS[/** @type {keyof typeof EFFORT_WORDS} */ (t.effort ?? s.chosen.effort)];
    const model = rowModel(t);
    return !/, not |, set to /.test(s.row) && s.row.includes(`${effort} effort`) && (!model || s.row.includes(model));
  });
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const SWITCH_TRIGGERS = Object.fromEntries(
  Object.entries(SWITCH_TARGETS).flatMap(([key, t]) => {
    const what = `${t.backend}, ${t.model}${t.effort ? `, ${t.effort} effort` : ''}`;
    return [
      [
        `ran-${key}`,
        {
          issue: 1315,
          says: `an agent switched in its persona sheet to ${what} took its next turn there: ${FOLDER[/** @type {keyof typeof FOLDER} */ (t.backend)]} recorded it${unreported(t.backend, t.model) ? '' : ', and the backend reported that model and effort'}`,
          recorded: (/** @type {any} */ f) => Array.isArray(f.probes?.panels) && Array.isArray(f.events),
          run: (/** @type {any} */ f) =>
            ran(t, f).map((s) => ({
              at: s.turn?.started ?? null,
              evidence: `@${s.handle} saved ${chosenText(s)}; its next turn is in ${FOLDER[/** @type {keyof typeof FOLDER} */ (t.backend)]}${s.reported ? `, which reported ${s.reported.model} at ${s.reported.effort ?? 'no'} effort` : ''}.`,
            })),
        },
      ],
      [
        `shown-${key}`,
        {
          issue: 1315,
          says: `an agent switched in its persona sheet to ${what} shows it: the sheet saved it, and after its next turn its row names that model and effort, with no “not” or “set to”`,
          recorded: (/** @type {any} */ f) => Array.isArray(f.probes?.panels) && !!f.ui,
          run: (/** @type {any} */ f) =>
            shown(t, f).map((s) => ({
              at: s.turn?.started ?? null,
              evidence: `@${s.handle} saved ${chosenText(s)}; its row says “${clip(String(s.row), 120)}”.`,
            })),
        },
      ],
    ];
  }),
);
