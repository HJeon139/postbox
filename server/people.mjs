// The people this Postbox knows (#558): each principal a provider answers with (server/identity/index.mjs) is one
// person, with the provider’s name for them as a default they can change. A person holds the profile they save
// (shared/profile.mjs), which is all agents are told of them, and their record is kept in the event log, as
// state.people, from the first time they save one. It doesn’t ask how Postbox is run: on this computer there is one person because one account asks.

import { createHash } from 'node:crypto';
import { profileOf } from '../shared/profile.mjs';

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
    return Object.values(this.store.state.people).find((x) => x.identity.issuer === p.issuer && x.identity.subject === p.subject) ?? null;
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
   * A person saves their own profile: checked whole, and from the next turn what agents are told of them.
   * @param {any} person @param {unknown} sent
   */
  saveProfile(person, sent) {
    const kept = this.store.state.people[person.id];
    const saved = { ...(kept ?? { ...person, createdAt: Date.now() }), profile: profileOf(sent) };
    this.store.emit('person', saved);
    return saved;
  }
}
