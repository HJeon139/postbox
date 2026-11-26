// Who is asking, wired for the server (#558): the identity provider and the people it answers with, built once as
// Postbox starts, and what the routes in server/index.mjs ask of them. Kept out of that file, which is at its length
// ceiling.

import { People } from '../people.mjs';
import { createIdentity } from './index.mjs';

/**
 * @param {{ store: import('../store.mjs').Store, account?: import('./index.mjs').Principal }} deps
 *   account: who the computer’s account is, for the local provider; a test or a screenshot run passes a fixture’s
 */
export function whoIs({ store, account }) {
  const identity = createIdentity({ account });
  const people = new People({ store });
  return {
    people,
    /**
     * The person a request is from, as the provider says, never read from its body. /mcp is an agent’s way in, and no
     * person’s. @param {import('node:http').IncomingMessage} req @param {string} path
     */
    of: async (req, path) => (path === '/mcp' ? null : people.of(await identity.identify(req))),
    /**
     * Who a message is from, for the send (server/send-message.mjs): their id, which it is stamped with, and `keep`,
     * which makes them someone this Postbox knows. The send calls it once nothing can refuse the message, so a refused
     * one writes nothing, and before the message posts, since the turn it starts is worded as it posts and names a
     * sender only if Postbox knows them. @param {any} person
     */
    sender: (person) => ({ id: person.id, keep: () => people.seen(person) }),
    /** A person saves their own profile. @param {any} person @param {any} body */
    saveProfile: (person, body) => people.saveProfile(person, body?.profile),
  };
}
