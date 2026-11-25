// The main menu’s list of personas (#1735, app/js/manage-list.mjs): each with its version, its host and what it does,
// and the bar under it: + for a new agent, − to delete the one picked, Edit, and Retire or Bring back.

import { mockMarker } from './agent-facts.mjs';
import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { barAction, barSign, pickList } from './manage-list.mjs';
import { confirmDeletePersona } from './persona-delete.mjs';

const S = () => client.state;

/**
 * @param {{ at: Record<string, any>, paint: () => void, edit: (personaId: string) => void, setFoot: (...actions: any[]) => null,
 *           openNewAgent: Function, closeSettings: () => void }} tab
 *   at: where the pick is kept; edit: shows a persona’s form; setFoot: pins the bar; openNewAgent and closeSettings
 *   come from the caller, as the boilerplate row’s do: sheets.mjs imports this module
 * @returns {HTMLElement}  the list
 */
export function personasList({ at, paint, edit, setFoot, openNewAgent, closeSettings }) {
  // +: the New agent sheet, in the menu’s place.
  const newAgent = () => {
    closeSettings();
    openNewAgent({});
  };
  // A persona’s form opens with focus on what it does.
  const open = (/** @type {string} */ id) => {
    edit(id);
    document.getElementById('pe-d')?.focus();
  };
  const { list, bar } = pickList({
    label: 'Personas',
    at,
    name: 'pickedPersona',
    empty: 'No agents yet.',
    rows: Object.values(S().personas).map((/** @type {any} */ p) => ({
      key: p.id,
      name: p.handle,
      className: 'persona-row',
      marks: [mockMarker(p), h('span.small.dim', `v${p.version ?? 1}`)],
      facts: [p.remote?.hostId ? `On ${S().hosts?.[p.remote.hostId]?.name ?? 'a removed host'}` : null, p.retired ? 'Retired' : p.description],
    })),
    open: (r) => open(r.key),
    controls: (r) => {
      const p = r && S().personas[r.key];
      return [
        barSign('+', 'New agent', newAgent),
        p && barSign('−', `Delete ${p.handle}…`, () => confirmDeletePersona(p, paint)),
        p && barAction('Edit', p.handle, () => open(p.id), { id: `pe-edit-${p.id}` }),
        p && barAction(p.retired ? 'Bring back' : 'Retire', p.handle, () => api(`/api/personas/${p.id}`, { retired: !p.retired }, 'PATCH').then(paint)),
      ];
    },
  });
  setFoot(bar);
  return list;
}
