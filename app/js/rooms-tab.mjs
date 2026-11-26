// The main menu’s Rooms (#1735): every conversation and room, each with who is in it and its actions, and a form for
// one at a time: its title and its members, agents and people in one list, as both are seats in it.

import { factsText } from '/shared/agent-facts.mjs';
import { factsOf, mockMarker } from './agent-facts.mjs';
import { queuedFor } from './agent-queue.mjs';
import { api, client, sessionsOf } from './client.mjs';
import { h } from './dom.mjs';
import { heard } from './go-when-there.mjs';
import { onChangeWhileAlive } from './held-weakly.mjs';
import { barAction, barSign, formHead, pickList, sectionHead } from './manage-list.mjs';
import { memberQueueButton } from './member-queue.mjs';
import { called, me, people } from './profile-tab.mjs';
import { stateWordOf } from './ring.mjs';
import { navigate, openMenu, route, toast } from './ui.mjs';

const S = () => client.state;
const rooms = () =>
  Object.values(S().threads)
    .filter((/** @type {any} */ t) => t.kind !== 'side' && t.kind !== 'topic')
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.title.localeCompare(b.title));
/** The project a new room is made in: the one that’s open, else the first. */
const openProject = () => {
  const r = /** @type {any} */ (route());
  return S().threads[r?.threadId]?.projectId ?? r?.projectId ?? Object.keys(S().projects)[0];
};
const agentsIn = (/** @type {string} */ id) => sessionsOf(id).filter((/** @type {any} */ se) => !se.retiredFork);

/**
 * @param {() => void} paint @param {(...actions: any[]) => null} setFoot @param {Record<string, any>} at  the room being edited, and the picks
 * @param {Record<string, Function>} sheets  the sheets the tab opens, and close, which closes the menu
 *
 * − asks over the menu, as every list’s confirm does, so Cancel returns to the list; the menu closes once the room is gone.
 */
export function roomsTab(paint, setFoot, at, sheets) {
  const back = () => {
    at.rooms = null;
    at.direct = false;
    paint();
  };
  const editing = at.rooms ? S().threads[at.rooms] : null;
  if (editing) return roomForm(editing, paint, setFoot, back, at, sheets);
  const leave = (/** @type {() => void} */ then) => () => {
    sheets.close();
    then();
  };
  const edit = (/** @type {string} */ id) => {
    at.rooms = id;
    paint();
    document.getElementById('rm-title')?.focus();
  };
  const { list, bar } = pickList({
    label: 'Rooms and conversations',
    at,
    name: 'pickedRoom',
    empty: 'No rooms or conversations yet.',
    rows: rooms().map((/** @type {any} */ t) => ({
      key: t.id,
      name: t.title,
      facts: [
        `${
          agentsIn(t.id)
            .map((/** @type {any} */ se) => `@${se.handle}`)
            .join(', ') || 'No agents'
        } · in ${S().projects[t.projectId]?.name ?? 'no project'}`,
      ],
    })),
    open: (r) => edit(r.key),
    controls: (r) => [
      barSign(
        '+',
        'New room',
        leave(() => sheets.openNewThread(openProject(), { room: true })),
        { id: 'rm-new' },
      ),
      r && barSign('−', `Delete ${r.name}…`, () => sheets.confirmDeleteThread(r.key, sheets.close)),
      r && barAction('Edit', r.name, () => edit(r.key)),
      r &&
        barAction(
          'Open',
          r.name,
          leave(() => navigate(`#/t/${r.key}`)),
        ),
    ],
  });
  setFoot(bar);
  return [list];
}

/** A room’s form: its title, who is in it, and the agents that could be. */
function roomForm(
  /** @type {any} */ t,
  /** @type {() => void} */ paint,
  /** @type {(...actions: any[]) => null} */ setFoot,
  /** @type {() => void} */ back,
  /** @type {Record<string, any>} */ at,
  /** @type {any} */ sheets,
) {
  const title = h('input.input', { id: 'rm-title', value: t.title, onkeydown: (/** @type {KeyboardEvent} */ e) => e.key === 'Enter' && void save() });
  const save = () =>
    api(`/api/threads/${t.id}`, { title: title.value }, 'PATCH')
      .then(async () => {
        toast({ title: `Saved ${title.value}` });
        // Opened on this room from the room itself (its Manage button, /rename), Save goes back there; from the list, to the list.
        if (at.direct) return sheets.close();
        // Once the page has heard of the new title, so the list shows it.
        await heard(() => S().threads[t.id]?.title === title.value.trim());
        back();
      })
      .catch((e) => toast({ title: 'Couldn’t save the room', text: e.message, level: 'blocking' }));
  setFoot(
    h(
      'button.btn.danger',
      {
        type: 'button',
        'aria-label': `Delete ${t.title}…`,
        onclick: () => sheets.confirmDeleteThread(t.id, sheets.close),
      },
      'Delete…',
    ),
    h('span.grow'),
    h('button.btn.send', { type: 'button', onclick: save }, 'Save'),
  );
  const members = membersList(t, paint, at, sheets);
  return [
    ...formHead('All rooms', back, t.title),
    h('div.field', h('label.label', { for: 'rm-title' }, 'Title'), title),
    sectionHead('Members'),
    members.list,
    members.bar,
    // Why − can be off, in words on the page: a title shows only under a pointer.
    h(
      'span.help',
      'The people of this Postbox are in every room, and a room keeps at least one agent. + adds an agent you have, and − removes the one picked.',
    ),
    sectionHead('More'),
    h(
      'div.row-flex.wrap',
      h('button.btn.sm', { type: 'button', title: sheets.chainLimitDesc(t.id), onclick: () => sheets.openChainLimit(t.id) }, 'Wake chain limit…'),
      h('button.btn.sm', { type: 'button', onclick: () => sheets.openPermissions({ threadId: t.id }) }, 'Permissions…'),
    ),
  ];
}

/**
 * What a Members list’s + offers, as a macOS list’s + opens what can be added: the agents that aren’t in the room, each
 * added in one pick, and making one. @param {HTMLElement} anchor @param {any} t @param {any[]} others
 * @param {() => void} paint @param {Record<string, Function>} sheets
 */
function offerAgents(anchor, t, others, paint, sheets) {
  const add = (/** @type {any} */ p) =>
    api(`/api/threads/${encodeURIComponent(t.id)}/agents`, { personaId: p.id })
      .then(async () => {
        toast({ title: `Added @${p.handle} to ${t.title}` });
        // Once the page has heard of it, so the list shows it.
        await heard(() => sessionsOf(t.id).some((/** @type {any} */ se) => se.personaId === p.id));
        paint();
      })
      .catch((e) => toast({ title: `Couldn’t add @${p.handle}`, text: e.message, level: 'blocking' }));
  const make = () => {
    sheets.close();
    sheets.openNewAgent({ threadId: t.id });
  };
  openMenu(
    anchor,
    [
      ...(others.length ? [{ heading: `Add to ${t.title}` }] : []),
      ...others.map((/** @type {any} */ p) => ({ label: `@${p.handle}`, icon: 'agent', desc: p.description || undefined, run: () => add(p) })),
      { label: 'New agent…', icon: 'plus', desc: 'Make one and add it here', run: make },
    ],
    { label: 'Add an agent' },
  );
}

/** A room’s members, agents and people in one list: + adds an agent that isn’t here, − removes the one picked. */
function membersList(/** @type {any} */ t, /** @type {() => void} */ paint, /** @type {Record<string, any>} */ at, /** @type {any} */ sheets) {
  const here = agentsIn(t.id);
  const ids = new Set(sessionsOf(t.id).map((/** @type {any} */ se) => se.personaId));
  const others = Object.values(S().personas)
    .filter((/** @type {any} */ p) => !p.retired && !ids.has(p.id))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.handle.localeCompare(b.handle));
  const offer = (/** @type {Event} */ e) => offerAgents(/** @type {HTMLElement} */ (e.currentTarget), t, others, paint, sheets);
  const everyone = people();
  const whyNot = (/** @type {any} */ r) => {
    if (!r) return 'Pick a member first.';
    if (r.key.startsWith('pn_')) return 'A person of this Postbox is in every room. Only an agent is added to a room or removed from it.';
    return here.length < 2 ? 'A room keeps at least one agent. Add another first, or delete the room.' : '';
  };
  return pickList({
    label: `Members of ${t.title}`,
    at,
    name: 'pickedMember',
    empty: 'No one is here.',
    rows: [
      ...here.map((/** @type {any} */ se) => ({
        key: se.id,
        name: `@${se.handle}`,
        marks: [mockMarker(se), h('span.small.dim', 'agent')],
        facts: [S().personas[se.personaId]?.description, liveFacts(se.id)],
      })),
      ...everyone.map((/** @type {any} */ p) => ({
        key: p.id,
        name: called(p),
        marks: [h('span.small.dim', 'person')],
        facts: [p.id === me()?.id ? 'you' : null],
      })),
    ],
    controls: (r) => [
      h(
        'button.btn.sm.sign',
        { type: 'button', id: 'rm-add', 'aria-label': `Add an agent to ${t.title}`, title: 'Add an agent', 'aria-haspopup': 'menu', onclick: offer },
        '+',
      ),
      barSign(
        '−',
        r ? `Remove ${r.name} from ${t.title}…` : 'Remove a member',
        () => sheets.confirmDelete(S().sessions[r?.key ?? ''], { keepConversation: true, removed: () => heard(() => !S().sessions[r?.key ?? '']).then(paint) }),
        { off: whyNot(r) },
      ),
      ...agentActions(r && S().sessions[r.key], sheets),
    ],
  });
}

/**
 * What else acts on the member picked, when it is an agent: Edit, which shows its persona’s form, and its queued
 * messages, off while it has none. @param {any} se  the pick’s session, or none for a person @param {Record<string, Function>} sheets
 */
function agentActions(se, sheets) {
  if (!se) return [];
  return [
    barAction('Edit', se.handle, () => {
      sheets.editPersona(se.personaId);
      // On the form’s first field, as the Personas list’s own Edit leaves it: a repaint alone leaves focus on a Tools chip.
      document.getElementById('pe-d')?.focus();
    }),
    memberQueueButton(se),
  ];
}

/** What an agent runs with, its state now, and how many messages wait for it, in words. @param {string} sessionId */
function factsLine(sessionId) {
  const se = S().sessions[sessionId];
  if (!se) return '';
  const queued = queuedFor(sessionId);
  return `${factsText(factsOf(se))} · ${stateWordOf(se).toLowerCase()}${queued ? ` · ${queued} queued` : ''}`;
}

/** What changes an agent’s facts line: what the sidebar’s Agents section repaints on, and an inbox entry coming or going. */
const FACTS_CHANGE = ['session', 'thread', 'persona', 'load', 'remove', 'host', 'host.status', 'entry.add', 'entry.patch'];

/** A facts line’s listener, made here so it closes over nothing that holds the line (#866). @param {string} sessionId */
const followFacts = (sessionId) => (/** @type {HTMLElement} */ el, /** @type {any} */ change) => {
  if (!FACTS_CHANGE.includes(change.type)) return;
  const now = factsLine(sessionId);
  if (el.textContent !== now) el.textContent = now;
};

/**
 * An agent’s facts in its Members row, kept current while the form is open: the form stays up while a person adds
 * members or waits, and with the sidebar behind it, or hidden in a narrow window, the row is the one statement of an
 * agent’s state in view. It says each agent’s queue too, so none takes a pick to find.
 * @param {string} sessionId
 */
function liveFacts(sessionId) {
  const el = h('span', factsLine(sessionId));
  onChangeWhileAlive(el, followFacts(sessionId));
  return el;
}
