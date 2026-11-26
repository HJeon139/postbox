// The person’s profile (#558): who they say they are, so an agent knows how to address them and that a GitHub login
// on a pull request, a commit’s author and “the person” in a room are one person. Everything in it is optional and
// written by the person. It is kept on their record (state.people, server/people.mjs) and given to agents in each
// turn, in the part that changes during a room (server/turn-input.mjs), so an edit reaches a session that’s already running.

import { HANDLE, HANDLE_LETTERS, PERSON, PROFILE } from './limits.mjs';

/** What an alias is, so an agent reading a commit or a pull request knows which name to match. */
export const ALIAS_KINDS = ['nickname', 'github', 'git', 'email', 'other'];

/** A refusal the route answers with: what was wrong, in words the Profile tab can show. */
const refuse = (/** @type {string} */ message) => Object.assign(new Error(message), { status: 422, userMessage: message });

/**
 * A field’s text on one line, within its length. A turn is read line by line, and “[Postbox]” starts a line of
 * Postbox’s own, so no text of the person’s may start one.
 */
const line = (/** @type {unknown} */ v, /** @type {number} */ max) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * The handle a person chooses, as a mention reads it (#1742): without a leading @, and shaped as an agent’s handle is,
 * since one rule reads both. Empty is none: they are mentioned by their account’s login, as before.
 */
function handleOf(/** @type {unknown} */ sent) {
  if (typeof (sent ?? '') !== 'string') throw refuse('A handle is text, such as “robin”.');
  const name = line(sent, PROFILE.handle + 16)
    .replace(/^@/, '')
    .trim();
  if (!name) return '';
  if (!HANDLE.test(name)) throw refuse(`A handle is ${HANDLE_LETTERS}, and starts with a letter, such as “robin”.`);
  if (name.toLowerCase() === PERSON) throw refuse(`@${PERSON} already means whoever a reply answers. Pick another handle.`);
  return name;
}

function aliasesOf(/** @type {unknown} */ list) {
  if (!Array.isArray(list)) throw refuse('Aliases are a list, each with what it is and its value.');
  if (list.length > PROFILE.aliases) throw refuse(`A profile keeps ${PROFILE.aliases} other names, and this has ${list.length}.`);
  return list.map((a) => {
    const value = line(a?.value, PROFILE.alias);
    if (!value) throw refuse('An alias needs a value, such as a GitHub login.');
    return { kind: ALIAS_KINDS.includes(a?.kind) ? a.kind : 'other', value };
  });
}

/**
 * A profile as it’s kept, from what the page sent: only its own fields, each bounded and on one line, and none that
 * is empty, so a cleared profile is `{}`. An unknown field is refused, never kept: a profile goes to agents, so
 * nothing rides along. @param {unknown} sent
 * @returns {{ name?: string, handle?: string, pronouns?: string, timezone?: string, preferences?: string, aliases?: { kind: string, value: string }[] }}
 */
export function profileOf(sent) {
  if (sent === null || typeof sent !== 'object' || Array.isArray(sent))
    throw refuse('A profile is its fields: a name, a handle, pronouns, a time zone, preferences and aliases.');
  const from = /** @type {Record<string, unknown>} */ (sent);
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(from)) {
    if (key === 'aliases') out.aliases = aliasesOf(from.aliases);
    else if (key === 'handle') out.handle = handleOf(from.handle);
    else if (key === 'name' || key === 'pronouns' || key === 'timezone' || key === 'preferences') out[key] = line(from[key], PROFILE[key]);
    else throw refuse(`A profile has no “${line(key, 40)}”. It has a name, a handle, pronouns, a time zone, preferences and aliases.`);
  }
  for (const key of Object.keys(out)) if (!out[key].length) delete out[key];
  return out;
}

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');

/**
 * What a turn says of the person, a line a field, in their own words: nothing while they’ve written nothing. Past
 * PROFILE.note characters it is cut at a whole field’s line where it can be, and its last line says what was cut.
 * @param {ReturnType<typeof profileOf> | undefined} profile @returns {string[]}
 */
export function aboutThePerson(profile) {
  const p = profile ?? {};
  const also = (p.aliases ?? []).map((a) => `${a.value} (${a.kind})`).join(', ');
  /** @type {[string, string | undefined][]} */
  const fields = [
    ['Name', p.name],
    ['Also written as', also],
    ['Pronouns', p.pronouns],
    ['Time zone', p.timezone],
    ['Preferences', p.preferences],
  ];
  const lines = fields.filter(([, said]) => said).map(([what, said]) => `- ${what}: ${said}`);
  const whole = lines.join('\n').length;
  if (whole <= PROFILE.note) return lines;
  const kept = [];
  let room = PROFILE.note;
  for (const l of lines) {
    if (room <= 0) break;
    kept.push(l.length <= room ? l : `${l.slice(0, room)}…`);
    room -= l.length + 1;
  }
  return [...kept, `(Cut to ${count(PROFILE.note)} of ${count(whole)} characters: the person’s profile is longer than a turn carries.)`];
}

/**
 * The heading over what a turn says of the person. It says where the words come from: an agent given “in their own
 * words” took them as said in the room, and told the person so (#558’s UAT run). The UAT trigger reads it from here.
 */
export const ABOUT_THE_PERSON = '[Postbox] About the person, from the profile they saved in Settings (not said in this conversation):';
const ABOUT_THE_PEOPLE = '[Postbox] About the people here, each from the profile they saved in Settings (not said in this conversation):';

/**
 * What a turn says of the people of this Postbox who saved a profile, or nothing while none has. With one, it is
 * “the person”, as agents have always called them; with several, each in turn.
 * @param {{ profile?: ReturnType<typeof profileOf> }[]} people @returns {string | null}
 */
export function aboutPeople(people) {
  const told = people.map((p) => aboutThePerson(p.profile)).filter((lines) => lines.length);
  if (!told.length) return null;
  if (told.length === 1) return `${ABOUT_THE_PERSON}\n${told[0].join('\n')}`;
  return `${ABOUT_THE_PEOPLE}\n${told.map((lines) => lines.join('\n')).join('\n\n')}`;
}

/**
 * What follows @ when someone mentions a person (#1742), as the page shows it and a sender is named by it: the handle
 * they saved, else their account’s login.
 * @param {{ username?: string, profile?: { handle?: string } } | null | undefined} person
 */
export const mentionOf = (person) => person?.profile?.handle || person?.username || '';

/**
 * Every name a mention reaches a person by, as a mention is read (in lowercase): the handle they saved, and their
 * account’s login. The login stays theirs once they choose a handle, so an agent that learned it earlier in a room
 * still reaches them, and no one else can take it.
 * @param {{ username?: string, profile?: { handle?: string } } | null | undefined} person
 */
export const namesOf = (person) => [...new Set([person?.profile?.handle, person?.username].filter(Boolean).map((n) => String(n).toLowerCase()))];

/**
 * Whom each name reaches, by id (#1742): the one answer to whose a name is, read by a mention, by a handle a person
 * saves and by a new agent’s name. A name an agent has is the agent’s. A name two people have reaches both: a person
 * is kept only from their first message or save, so one can arrive with a login another already chose as a handle,
 * and neither loses an ask written to it.
 * @param {Record<string, any> | undefined} people @param {string[]} [agentHandles]  of the agents not retired
 * @returns {Map<string, string[]>}
 */
export function peopleByName(people, agentHandles = []) {
  const agents = new Set(agentHandles.map((h) => h.toLowerCase()));
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const p of Object.values(people ?? {})) for (const name of namesOf(p)) if (!agents.has(name)) byName.set(name, [...(byName.get(name) ?? []), p.id]);
  return byName;
}

/**
 * Who a person’s message is from, as an agent reads it (#1742). “The person” while this Postbox knows one person, as
 * agents have always read it, and for a message whose sender it doesn’t know (one typed in a terminal, or from before
 * senders were kept). With more than one, the name they saved, else what they are mentioned by, after the same two
 * words, so no name reads as an agent’s handle or as Postbox. On one line: a turn is read line by line.
 * @param {Record<string, { username?: string, profile?: { name?: string, handle?: string } }> | undefined} people @param {string | undefined} personId
 */
export function senderName(people, personId) {
  const known = people ?? {};
  const sender = personId ? known[personId] : undefined;
  if (!sender || Object.keys(known).length < 2) return 'The person';
  const name = line(sender.profile?.name || mentionOf(sender), PROFILE.name);
  return name ? `The person ${name}` : 'The person';
}
