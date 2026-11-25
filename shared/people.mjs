// A person in Postbox (#558, prototype): the profile that says who a human actor is, what agents are told about them
// and what other people in a room see. Pure: the server’s registry (server/people.mjs) and the page both read it.
//
// A person is keyed by the identities that proved them, each an issuer and a subject (OpenID Connect Core, 5.7: only
// the two together are a stable key; an email can be handed to someone else). Everything else is the person’s own text.

import { PERSON } from './limits.mjs';

/** The bounds of a profile’s fields, as characters or counts. */
export const PROFILE = { name: 80, handle: 32, pronouns: 40, timezone: 64, preferences: 2000, aliases: 12, alias: 120 };

/** What an alias is, so an agent reading a commit or a pull request knows which name to match. */
export const ALIAS_KINDS = ['nickname', 'github', 'git', 'email', 'other'];

/** `owner` runs this Postbox: on a local run, the unix user. `member` signed in through the identity provider. */
export const ROLES = ['owner', 'member'];

const clip = (/** @type {unknown} */ v, /** @type {number} */ n) =>
  String(v ?? '')
    .trim()
    .slice(0, n);

/**
 * A handle from a name a provider gave: lowercase letters, digits and hyphens, never the reserved one, and not one
 * `taken` says an agent or another person holds. @param {string} from @param {(handle: string) => boolean} taken
 */
export function handleFor(from, taken) {
  const base =
    String(from ?? '')
      .toLowerCase()
      .split('@')[0]
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, PROFILE.handle - 3) || 'person';
  const free = (/** @type {string} */ h) => h !== PERSON && !taken(h);
  if (free(base)) return base;
  for (let n = 2; n < 1000; n++) if (free(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`No handle is free for “${base}”.`);
}

/**
 * The fields of a profile a person may write, bounded. Unknown fields are refused, never kept: a profile is sent to
 * agents, so nothing rides along. @param {any} fields @returns {Record<string, unknown>}
 */
export function profileEdit(fields) {
  const out = {};
  for (const key of Object.keys(fields ?? {})) {
    if (key === 'name') out.name = clip(fields.name, PROFILE.name);
    else if (key === 'pronouns') out.pronouns = clip(fields.pronouns, PROFILE.pronouns);
    else if (key === 'timezone') out.timezone = clip(fields.timezone, PROFILE.timezone);
    else if (key === 'preferences') out.preferences = clip(fields.preferences, PROFILE.preferences);
    else if (key === 'aliases') out.aliases = aliases(fields.aliases);
    else throw new Error(`A profile has no “${key}” to change. It has a name, pronouns, a time zone, preferences and aliases.`);
  }
  if (Object.hasOwn(out, 'name') && !out.name) throw new Error('A profile needs a name.');
  return out;
}

function aliases(/** @type {unknown} */ list) {
  if (!Array.isArray(list)) throw new Error('Aliases are a list.');
  return list.slice(0, PROFILE.aliases).map((a) => {
    const kind = ALIAS_KINDS.includes(a?.kind) ? a.kind : 'other';
    const value = clip(a?.value, PROFILE.alias);
    if (!value) throw new Error('An alias needs a value.');
    return { kind, value };
  });
}

/**
 * What a message keeps of who sent it, as an agent’s reply keeps its handle. `label` is how agents read the sender,
 * and is there only when it says more than “The person”: the person wrote their profile, or the room has more than
 * one person. With one person who set nothing, a turn reads as it did before profiles.
 * @param {any} person @param {number} people  how many people this Postbox knows
 */
export function byline(person, people) {
  const told = person.edited || people > 1;
  return { id: person.id, handle: person.handle, name: person.name, ...(told ? { label: `${person.name} (@${person.handle})` } : {}) };
}

/** What other people’s pages get of a person: no identities, emails or preferences. @param {any} p */
export const publicPerson = (p) => ({
  id: p.id,
  handle: p.handle,
  name: p.name,
  role: p.role,
  ...(p.filledBy ? { filledBy: p.filledBy } : {}),
  ...(p.pronouns ? { pronouns: p.pronouns } : {}),
});

/**
 * The lines of a turn’s facts that say who the people are, in the person’s own words. Empty when no one wrote a
 * profile and the room has one person. @param {any[]} people
 */
export function peopleFacts(people) {
  if (!(people.length > 1 || people.some((p) => p.edited))) return [];
  return people.map((p) => {
    const also = (p.aliases ?? []).map((/** @type {any} */ a) => `${a.value} (${a.kind})`).join(', ');
    const parts = [
      `${p.name} (@${p.handle})`,
      p.pronouns && `pronouns: ${p.pronouns}`,
      also && `also written as ${also}`,
      p.timezone && `time zone: ${p.timezone}`,
      p.preferences && `preferences: ${p.preferences}`,
    ];
    return `- ${parts.filter(Boolean).join('; ')}`;
  });
}
