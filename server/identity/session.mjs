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
     * A message of theirs was posted: they are someone this Postbox knows from then on. After the post, so a send that
     * is refused writes nothing. Answers with what the post answered. @param {any} person @param {any} posted
     */
    sent: (person, posted) => {
      people.seen(person);
      return posted;
    },
    /** A person saves their own profile. @param {any} person @param {any} body */
    saveProfile: (person, body) => people.saveProfile(person, body?.profile),
  };
}
