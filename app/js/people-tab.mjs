// The main menu’s People (#558): everyone this Postbox knows, as the list every other kind is managed in. Who can sign
// in is the identity provider’s to decide, so there is nothing to add here, and a person edits only their own profile.

import { client } from './client.mjs';
import { h } from './dom.mjs';
import { barAction, barSign, pickList } from './manage-list.mjs';

/** @param {(tab: string) => void} go  switches the menu to another tab @param {(...actions: any[]) => null} setFoot @param {Record<string, any>} at */
export function peopleTab(go, setFoot, at) {
  const { me, people = [], mode } = client.who ?? {};
  const theirs =
    mode === 'local'
      ? 'On this computer, you are the account Postbox runs as.'
      : 'Your organization’s sign-in decides who is here, so there is no one to add or remove.';
  const { list, bar } = pickList({
    label: 'People',
    at,
    name: 'pickedPerson',
    empty: 'No one has signed in yet.',
    rows: people.map((/** @type {any} */ p) => ({
      key: p.id,
      name: p.name,
      marks: [h('span.small.dim', [p.role, p.filledBy ? 'scripted' : null, p.id === me?.id ? 'you' : null].filter(Boolean).join(' · '))],
      facts: [`@${p.handle}${p.pronouns ? ` · ${p.pronouns}` : ''}`],
    })),
    open: (r) => r.key === me?.id && go('profile'),
    controls: (r) => [
      barSign('+', 'Add a person', () => {}, { off: theirs }),
      barSign('−', r ? `Remove ${r.name}` : 'Remove a person', () => {}, { off: theirs }),
      r &&
        barAction('Edit', r.key === me?.id ? 'your profile' : `${r.name}’s profile`, () => go('profile'), {
          off: r.key === me?.id ? '' : 'A person edits only their own profile.',
        }),
    ],
  });
  setFoot(bar);
  return [list, h('span.help', 'Roles, and which projects and rooms each person is in, come with membership, which isn’t built yet.')];
}
