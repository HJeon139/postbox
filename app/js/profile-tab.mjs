// Settings › Profile (#558, prototype): who you are here, in your own words, and what agents are told of it. Nothing
// on it is required. How you signed in is shown and can’t be edited: it’s what the identity provider proved.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { toast } from './ui.mjs';

const KINDS = ['nickname', 'github', 'git', 'email', 'other'];

/** The letters of the top bar’s icon: a name’s initials. @param {string} [name] */
export const initials = (name = client.who?.me?.name ?? '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

const text = (/** @type {string} */ id, /** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ help, big = false) =>
  h(
    'div.field',
    h('label.label', { for: id }, label),
    big ? h('textarea.textarea', { id, rows: 3, 'aria-describedby': `${id}-help` }, value) : h('input.input', { id, value, 'aria-describedby': `${id}-help` }),
    h('span.help', { id: `${id}-help` }, help),
  );

/** One alias per line, as “kind: value”; a line with no kind is “other”. */
const aliasLines = (/** @type {any[]} */ list) => list.map((a) => `${a.kind}: ${a.value}`).join('\n');
const aliasesOf = (/** @type {string} */ lines) =>
  lines
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\w+):\s*(.+)$/);
      return m && KINDS.includes(m[1].toLowerCase()) ? { kind: m[1].toLowerCase(), value: m[2] } : { kind: 'other', value: l };
    });

/** @param {() => void} paint  repaints the settings sheet @param {(...actions: any[]) => null} setFoot  pins the tab’s actions under it */
export function profileTab(paint, setFoot) {
  const { me, mode, people = [] } = client.who ?? {};
  if (!me) return [h('p', 'Postbox doesn’t know who you are yet. Reload the page.')];
  const value = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
  const save = async () => {
    try {
      client.who = await api(
        '/api/me',
        {
          name: value('pf-name'),
          pronouns: value('pf-pronouns'),
          timezone: value('pf-tz'),
          preferences: value('pf-prefs'),
          aliases: aliasesOf(value('pf-aliases')),
        },
        'PATCH',
      );
      const icon = document.getElementById('me-icon');
      if (icon) icon.dataset.initials = initials();
      toast({ title: 'Profile saved. Agents read it from their next turn.' });
      paint();
    } catch (e) {
      toast({ title: /** @type {Error} */ (e).message });
    }
  };
  const signedIn = mode === 'local' ? 'the account Postbox runs as on this computer' : 'your organization’s sign-in';
  const others = people.filter((/** @type {any} */ p) => p.id !== me.id);
  setFoot(h('span.grow'), h('button.btn.send', { type: 'button', onclick: save }, 'Save profile'));
  return [
    h(
      'div.field',
      h('span.label', 'Signed in as'),
      h('span', h('b', `@${me.handle}`), ` · ${me.role === 'owner' ? 'owner of this Postbox' : 'member of this Postbox'}`),
      h('span.help', `From ${signedIn}. It can’t be changed here.`),
    ),
    text('pf-name', 'Name', me.name, 'How agents and other people address you.'),
    text(
      'pf-aliases',
      'Also written as',
      aliasLines(me.aliases ?? []),
      'One per line, such as “github: your-login” or “git: Your Commit Name”, so agents know those are you.',
      true,
    ),
    text('pf-prefs', 'Preferences', me.preferences ?? '', 'In your own words: language, spelling, reply length, what to ask before doing.', true),
    text('pf-tz', 'Time zone', me.timezone ?? '', 'Such as America/Los_Angeles.'),
    text('pf-pronouns', 'Pronouns', me.pronouns ?? '', 'Optional. How agents refer to you when they write about you to others. Used as given, never guessed.'),
    others.length
      ? h('p.small.dim', `Also here: ${others.map((/** @type {any} */ p) => `${p.name} (@${p.handle})${p.filledBy ? ', scripted' : ''}`).join(', ')}.`)
      : null,
  ];
}
