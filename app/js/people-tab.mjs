// The main menu’s People (#1735): everyone this Postbox knows, as the list every other kind is managed in. Who can sign
// in is the identity provider’s to decide, so there is nothing to add here, and a person edits only their own profile.

import { HANDLE } from '/shared/limits.mjs';
import { mentionOf } from '/shared/profile.mjs';
import { h } from './dom.mjs';
import { barAction, barSign, pickList } from './manage-list.mjs';
import { called, me, people } from './profile-tab.mjs';

/** @param {(tab: string) => void} go  switches the menu to another tab @param {(...actions: any[]) => null} setFoot @param {Record<string, any>} at */
export function peopleTab(go, setFoot, at) {
  const mine = me();
  // Who is here isn’t added or removed in Postbox: it is whoever the computer’s account is, or whoever signs in.
  const theirs = 'On this computer, you are the account Postbox runs as. There is no one to add or remove.';
  const { list, bar } = pickList({
    label: 'People',
    at,
    name: 'pickedPerson',
    empty: 'No one is here yet.',
    rows: people().map((/** @type {any} */ p) => ({
      key: p.id,
      name: called(p),
      marks: p.id === mine?.id ? [h('span.small.dim', 'you')] : [],
      // What they are mentioned by, when it can be written as a mention: the handle they chose, else their login.
      facts: [[HANDLE.test(mentionOf(p)) ? `@${mentionOf(p)}` : p.username, p.profile?.pronouns].filter(Boolean).join(' · ')],
    })),
    open: (r) => r.key === mine?.id && go('profile'),
    controls: (r) => [
      barSign('+', 'Add a person', () => {}, { off: theirs }),
      barSign('−', r ? `Remove ${r.name}` : 'Remove a person', () => {}, { off: theirs }),
      r &&
        barAction('Edit', r.key === mine?.id ? 'your profile' : `${r.name}’s profile`, () => go('profile'), {
          off: r.key === mine?.id ? '' : 'A person edits only their own profile.',
        }),
    ],
  });
  setFoot(bar);
  return [
    list,
    // Why + and − are off, in words on the page: a title shows only under a pointer.
    h('span.help', theirs),
    h('span.help', 'Everyone here sees every room and each other’s profile. What agents are told of a person is what that person saved.'),
  ];
}
