// The skills an agent loads (#207), in the new agent and persona sheets (app/js/sheets.mjs): Postbox’s, yours, the
// project’s and your plugins’, each ticked unless the agent turns it off. Unticked, it goes in st.skillsOff. The list
// comes from GET /api/skills (server/adapters/skill-config.mjs), which says how each kind is turned off.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';

/** Where a skill comes from, in words. */
const FROM = { postbox: 'Postbox’s', user: 'Yours', project: 'This project’s', plugin: 'From a plugin', unknown: 'Not found now' };
// A plugin’s skill can only be refused (a deny rule): Claude Code still tells the agent about it.
const PLUGIN_OFF = 'Off, it can’t run, but the agent still sees it';

/** Asks for the list once; st.skills is null while it loads, then the list or { error }. */
function load(st, paint, personaId, projectId) {
  if (st.skills !== undefined) return;
  st.skills = null;
  const q = new URLSearchParams({ ...(personaId ? { personaId } : {}), ...(projectId ? { projectId } : {}) });
  api(`/api/skills?${q}`, undefined, 'GET').then(
    (r) => {
      st.skills = r.skills ?? [];
      paint();
    },
    (e) => {
      st.skills = { error: e.message };
      paint();
    },
  );
}

/** One skill’s checkbox: ticked loads it. Space or Enter toggles it. */
function skillRow(st, skill, id) {
  const off = () => st.skillsOff.includes(skill.name);
  const toggle = (e) => {
    st.skillsOff = off() ? st.skillsOff.filter((n) => n !== skill.name) : [...st.skillsOff, skill.name];
    e.currentTarget.setAttribute('aria-checked', String(!off()));
  };
  return h(
    'span.check',
    {
      id,
      role: 'checkbox',
      tabindex: '0',
      'aria-checked': String(!off()),
      'data-skill': skill.name,
      onclick: toggle,
      onkeydown: (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.click();
        }
      },
    },
    h('span.box'),
    h('span.mono', skill.name),
    h('span.small.dim', [FROM[skill.scope] ?? skill.scope, skill.scope === 'plugin' ? PLUGIN_OFF : ''].filter(Boolean).join(' · ')),
  );
}

/**
 * The Skills checklist. An Isolated agent doesn’t load yours or your plugins’, so only Postbox’s and the project’s show.
 * A backend that loads only Postbox’s (capabilities.skills: 'postbox', such as Kiro or Codex) lists only those: the
 * skills on disk are Claude Code’s, which it doesn’t read, and its own aren’t Postbox’s to turn off.
 * @param {any} st @param {() => void} paint
 * @param {{ idp: string, personaId?: string|null, projectId?: string|null, loads?: true | 'postbox' }} opts  loads: capabilities.skills
 */
export function skillsField(st, paint, { idp, personaId = null, projectId = null, loads = true }) {
  load(st, paint, personaId, projectId);
  st.skillsOff ??= [];
  const postboxOnly = loads === 'postbox';
  const isolated = !postboxOnly && st.usesHostSetup === false;
  const shown = (s) => s.scope === 'postbox' || (!postboxOnly && (!isolated || s.scope === 'project'));
  const list = Array.isArray(st.skills) ? st.skills.filter(shown) : st.skills;
  return h(
    'fieldset.field.span',
    { style: { border: 0, padding: 0, margin: 0 } },
    h('legend.label', 'Skills'),
    skillsBody(st, list, idp),
    h('span.help', helpFor({ postboxOnly, isolated })),
  );
}

/** What the list holds, and how to use it. */
function helpFor({ postboxOnly, isolated }) {
  const untick = 'Untick one to keep it from loading for this agent.';
  if (postboxOnly) return `Postbox gives it these skills, beside the ones its own CLI loads. ${untick}`;
  if (isolated) return `It’s isolated, so only Postbox’s skills and the project’s load. ${untick}`;
  return `They load as in your terminal, with Postbox’s own. ${untick}`;
}

/** The list, or why there isn’t one yet. */
function skillsBody(st, list, idp) {
  if (list === null) return h('span.help', 'Looking for its skills…');
  if (!Array.isArray(list)) return h('span.err', icon('warn'), `Couldn’t list its skills: ${list.error}`);
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } },
    list.map((s, i) => skillRow(st, s, `${idp}-skill-${i}`)),
  );
}
