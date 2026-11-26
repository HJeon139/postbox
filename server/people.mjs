// The people this Postbox knows (#558): each principal a provider answers with (server/identity/index.mjs) is one
// person, with the provider’s name for them as a default they can change. A person holds the profile they save
// (shared/profile.mjs), which is all agents are told of them, and their record is kept in the event log, as
// state.people, from the first time they save one or send a message. It doesn’t ask how Postbox is run: on this
// computer there is one person because its provider says it answers with one (`sole`), whatever account asks.

import { createHash } from 'node:crypto';
import { peopleByName, profileOf } from '../shared/profile.mjs';

/**
 * A person’s id, from the issuer and subject that are them: the same for the same person on every request, with or
 * without a record. @param {{ issuer: string, subject: string }} p
 */
export const idOf = (p) => `pn_${createHash('sha256').update(`${p.issuer}\n${p.subject}`).digest('base64url').slice(0, 16)}`;

export class People {
  /** @param {{ store: import('./store.mjs').Store }} deps */
  constructor({ store }) {
    this.store = store;
  }

  /** The person a principal is, in the state as it is, or none yet. @param {import('./identity/index.mjs').Principal} p */
  known(p) {
    const theirs = Object.values(this.store.state.people).filter((x) => x.identity.issuer === p.issuer);
    // A provider with one person for the whole Postbox (`sole`, the local one): theirs is the record first kept under
    // it, whatever subject it was kept under. One kept under an account’s uid, as the local provider keyed people
    // until #1742, is still theirs under another account, so no profile or need is left to a person no one can be.
    if (p.sole) return theirs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0] ?? null;
    return theirs.find((x) => x.identity.subject === p.subject) ?? null;
  }

  /**
   * The person a principal is: their record if they have one, else who the provider says they are, with nothing saved.
   * Asking writes nothing, so a read stays a read: the record is first kept when they have something to keep (their
   * profile). Their id comes from who they are, so it is the same before and after.
   * @param {import('./identity/index.mjs').Principal} p
   */
  of(p) {
    return (
      this.known(p) ?? {
        id: idOf(p),
        identity: { provider: p.provider, issuer: p.issuer, subject: p.subject },
        username: p.username,
        name: p.name,
        profile: {},
      }
    );
  }

  /**
   * A person did something that is kept as theirs (sent a message, #1742): they are someone this Postbox knows from
   * then on, so a turn can name them among several and the page can show whose message it is. Kept once, with nothing
   * saved (`unsaved`), so their profile still starts from the provider’s name and agents are told nothing of them,
   * except what they are mentioned by, as the sender of a message once there is more than one person.
   * @param {any} person  as `of` answers
   */
  seen(person) {
    const kept = this.store.state.people[person.id];
    if (kept) return kept;
    const first = { ...person, createdAt: Date.now(), unsaved: true };
    this.store.emit('person', first);
    return first;
  }

  /**
   * A handle is refused when an agent that isn’t retired has it, where a mention would wake the agent and never reach
   * the person, or when it is a name of another person this Postbox knows, their handle or their login
   * (shared/profile.mjs, peopleByName). Compared in any case, as a mention is read. A person it doesn’t know yet can
   * still arrive with that login: a mention of the name then asks both.
   * @param {any} person  as it would be saved
   */
  refuseTaken(person) {
    const handle = person.profile.handle;
    if (!handle) return;
    const { personas, people } = this.store.state;
    const refuse = (/** @type {string} */ why) => Object.assign(new Error(why), { status: 422, userMessage: why });
    if (Object.values(personas).some((p) => !p.retired && p.handle.toLowerCase() === handle.toLowerCase()))
      throw refuse(`@${handle} is an agent’s name here. Pick another handle.`);
    const others = Object.fromEntries(Object.entries(people).filter(([id]) => id !== person.id));
    if (peopleByName(others).has(handle.toLowerCase())) throw refuse(`@${handle} is how someone else here is mentioned. Pick another handle.`);
  }

  /**
   * A person saves their own profile: checked whole, and from the next turn what agents are told of them.
   * @param {any} person @param {unknown} sent
   */
  saveProfile(person, sent) {
    const { unsaved: _, ...kept } = this.store.state.people[person.id] ?? { ...person, createdAt: Date.now() };
    const saved = { ...kept, profile: profileOf(sent) };
    this.refuseTaken(saved);
    this.store.emit('person', saved);
    return saved;
  }
}
