// Settings › Profile (#558): who you say you are, so agents know how to address you and which names elsewhere are
// yours. Everything on it is optional and yours to write. It shows exactly what agents are told, as it is saved.

import { PROFILE } from '/shared/limits.mjs';
import { ALIAS_KINDS, aboutThePerson } from '/shared/profile.mjs';
import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { toast } from './ui.mjs';

/** A field of the tab: it stops at its bound as you type (`max`, from PROFILE), so a save never cuts what you see. */
const field = (
  /** @type {string} */ id,
  /** @type {string} */ label,
  /** @type {string} */ value,
  /** @type {string} */ help,
  /** @type {{ max: number, big?: boolean }} */ { max, big = false },
) =>
  h(
    'div.field',
    h('label.label', { for: id }, label),
    big
      ? h('textarea.textarea', { id, rows: 2, maxlength: String(max), 'aria-describedby': `${id}-help` }, value)
      : h('input.input', { id, value, maxlength: String(max), 'aria-describedby': `${id}-help` }),
    h('span.help', { id: `${id}-help` }, help),
  );

/** One alias a line, as “kind: value”; a line with no kind it knows is “other”. */
const aliasLines = (/** @type {any[]} */ list) => list.map((a) => `${a.kind}: ${a.value}`).join('\n');
const aliasesOf = (/** @type {string} */ lines) =>
  lines
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.indexOf(':');
      const kind = at > 0 ? l.slice(0, at).trim().toLowerCase() : '';
      return ALIAS_KINDS.includes(kind) ? { kind, value: l.slice(at + 1).trim() } : { kind: 'other', value: l };
    });

/** What agents are told, as it is saved: the turn’s own lines, or that there is nothing yet. */
function told(/** @type {any} */ profile) {
  const lines = aboutThePerson(profile);
  return h(
    'div.field',
    h('span.label', 'What agents are told'),
    lines.length
      ? h('pre.small.mono', { id: 'pf-told', style: { margin: 0, whiteSpace: 'pre-wrap' } }, lines.join('\n'))
      : h('span.help', { id: 'pf-told' }, 'Nothing yet: agents call you “the person”.'),
    h(
      'span.help',
      'Agents are told this in each turn. Clearing a field stops that; an agent that already heard it may remember it in that conversation, and a new conversation starts clean.',
    ),
  );
}

/** The one looking: their record among the people (state.people) once they’ve saved one, else who the server said they are. */
export const me = () => client.state.people?.[client.config?.me?.id] ?? client.config?.me ?? null;

/** What they’re called here: the name they saved, else the one their sign-in or their computer’s account gave. */
const called = (/** @type {any} */ person) => person?.profile?.name ?? person?.name ?? '';

/** The letters of the top bar’s button: the initials of what the one looking is called. */
const initials = () =>
  called(me())
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((/** @type {string} */ w) => w[0].toUpperCase())
    .join('') || '?';

/**
 * The top bar’s way into Settings: the one looking, by their initials, opening on their profile. Its name stays
 * “Settings”, which is what it opens; the initials are drawn, not text, so the name and what shows don’t disagree.
 * @param {(tab: string) => void} openSettings
 */
export const meButton = (openSettings) =>
  h(
    'button.btn.icon.sm.ghost',
    { type: 'button', 'aria-label': 'Settings', title: called(me()) || null, onclick: () => openSettings('profile') },
    h('span.me-icon', { id: 'me-icon', 'aria-hidden': 'true', 'data-initials': initials() }),
  );

/** @param {() => void} paint  repaints the tabs, once the profile is saved */
export function profile(paint) {
  const person = me();
  if (!person) return [h('p', 'Postbox doesn’t know who you are yet. Reload the page.')];
  const saved = person.profile ?? {};
  // Until they first save, the Name field holds the one their account gave, which is theirs to change or clear. Once
  // they have saved, it holds what they saved: a name they emptied stays empty, and doesn’t come back on the next save.
  const kept = Boolean(client.state.people?.[person.id]);
  const unsaved = kept ? '' : ` It starts as “${person.name}”, from your computer’s account, and agents aren’t told it until you save.`;
  const value = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
  const save = () =>
    api(
      '/api/me',
      {
        profile: {
          name: value('pf-name'),
          aliases: aliasesOf(value('pf-aliases')),
          pronouns: value('pf-pronouns'),
          timezone: value('pf-tz'),
          preferences: value('pf-prefs'),
        },
      },
      'PUT',
    )
      .then((kept) => {
        // The page hears of it on the stream too; this is so the tab and the top bar show it at once.
        client.state.people[kept.id] = kept;
        const icon = document.getElementById('me-icon');
        if (icon) icon.dataset.initials = initials();
        toast({ title: 'Profile saved', text: 'Agents read it from their next turn.' });
        paint();
      })
      .catch((e) => toast({ title: 'Couldn’t save your profile', text: e.message, level: 'blocking' }));
  return [
    field('pf-name', 'Name', kept ? (saved.name ?? '') : person.name, `How agents address you.${unsaved}`, { max: PROFILE.name }),
    field(
      'pf-aliases',
      'Also written as',
      aliasLines(saved.aliases ?? []),
      `One a line, up to ${PROFILE.aliases}, such as “github: your-login” or “git: Your Commit Name”, so agents know those are you.`,
      { max: PROFILE.aliases * (PROFILE.alias + 10), big: true },
    ),
    field('pf-prefs', 'Preferences', saved.preferences ?? '', 'In your own words: language, spelling, reply length, what to ask before doing.', {
      max: PROFILE.preferences,
      big: true,
    }),
    field('pf-tz', 'Time zone', saved.timezone ?? '', 'Such as America/Los_Angeles.', { max: PROFILE.timezone }),
    field('pf-pronouns', 'Pronouns', saved.pronouns ?? '', 'How agents refer to you when they write about you to others. Used as given, never guessed.', {
      max: PROFILE.pronouns,
    }),
    h('div.row-flex', h('button.btn.send', { type: 'button', id: 'pf-save', onclick: save }, 'Save profile')),
    told(saved),
  ];
}
