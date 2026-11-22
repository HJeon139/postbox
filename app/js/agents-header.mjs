// The Agents header’s + and − (#1620): add an agent the person has to the conversation in one pick, or remove one, as
// a list’s + and − do in macOS, without @-mentioning it or opening the conversation’s menu.

import { api, client, sessionsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { focusComposer } from './hop-card.mjs';
import { openMenu, say, toast } from './ui.mjs';

const S = () => client.state;
const here = (threadId) => sessionsOf(threadId).filter((x) => !x.retiredFork);

/**
 * The + and − beside the conversation’s Agents heading. The New agent sheet and the Delete session dialog come from
 * the caller: sheets.mjs reaches this module through the shell, so importing it here would grow an import cycle (#312).
 * @param {string} threadId @param {{ openNewAgent: Function, confirmDelete: Function }} sheets
 */
export function agentsHeaderButtons(threadId, sheets) {
  const button = (label, name, open) => {
    const b = h(
      'button.btn.ghost.icon.sm',
      { type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', onclick: () => open(b, threadId, sheets) },
      icon(name),
    );
    return b;
  };
  return h(
    'span.agents-head-btns',
    button('Add an agent to this conversation', 'plus', openAdd),
    button('Remove an agent from this conversation', 'minus', openRemove),
  );
}

/**
 * The agents the person has that aren’t here, each added in one pick, and New agent to make one: from the Agents
 * header’s +, or the conversation’s menu where the sidebar is hidden.
 */
export function openAdd(anchor, threadId, sheets) {
  const ids = new Set(here(threadId).map((x) => x.personaId));
  const others = Object.values(S().personas)
    .filter((p) => !ids.has(p.id))
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const picks = others.map((p) => ({ label: `@${p.handle}`, icon: 'agent', desc: p.description || undefined, run: () => add(threadId, p) }));
  const make = { label: 'New agent…', icon: 'plus', desc: 'Make one and add it here', run: () => sheets.openNewAgent({ threadId }) };
  openMenu(anchor, picks.length ? [{ heading: 'Add to this conversation' }, ...picks, 'hr', make] : [make], { label: 'Add an agent' });
}

async function add(threadId, p) {
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/agents`, { personaId: p.id });
    say(`Added @${p.handle} to this conversation`);
    // The rail draws the new row, and with it the button the pick came from, so focus goes where the next message is.
    focusComposer();
  } catch (e) {
    toast({ title: `Couldn’t add @${p.handle}`, text: e.message, level: 'blocking' });
  }
}

/** The agents here, each removed after the Delete session dialog says what goes with it. */
export function openRemove(anchor, threadId, sheets) {
  const items = here(threadId).map((se) => ({
    label: `Remove @${se.handle}…`,
    icon: 'trash',
    danger: true,
    run: () => sheets.confirmDelete(se),
  }));
  openMenu(anchor, items, { label: 'Remove an agent' });
}
