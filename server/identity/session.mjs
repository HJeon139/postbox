// Who is asking, wired for the server (#558, prototype): the identity provider, the front door, the people it knows
// and their seats, built once as Postbox starts, and what the routes in server/index.mjs ask of them. Kept out of
// that file, which is at its length ceiling.

import { ScriptedPerson } from '../adapters/mock-person.mjs';
import { People } from '../people.mjs';
import { Seats } from '../seats.mjs';
import { frontDoor } from './front.mjs';
import { createIdentity } from './index.mjs';

/**
 * @param {{ rt: any, dataDir: string, port: number, env?: NodeJS.ProcessEnv }} deps
 */
export function whoIs({ rt, dataDir, port, env = process.env }) {
  // The unix user on this computer, or whoever the load balancer signed in.
  const identity = createIdentity(env);
  const people = new People({ dataDir, taken: (h) => Boolean(rt.personas.byHandle(h)), mode: identity.mode });
  rt.people = people;
  for (const name of (env.POSTBOX_MOCK_PEOPLE ?? '').split(',').filter(Boolean)) people.scripted(name.trim());
  new Seats({ rt, people, drivers: { mock: new ScriptedPerson() } }).listen();
  return {
    /** Hosted: the public https address it also answers as, and the address it binds for the load balancer. */
    front: frontDoor(env, port, identity.mode),
    /** Whether this is a run on this computer, for the person who runs it. */
    local: () => identity.mode === 'local',
    /** What the page gets of the people here, for the one looking. @param {any} person */
    page: (person) => people.page(person),
    /**
     * The person a request is from, proved by the provider and never read from its body. /mcp is an agent’s way in.
     * @param {import('node:http').IncomingMessage} req @param {string} path
     */
    of: async (req, path) => (path === '/mcp' ? null : people.of(await identity.identify(req))),
    /** A person’s message: sent as them, and what waited for them in that conversation is answered by it. */
    sendAs(/** @type {string} */ threadId, /** @type {any} */ body, /** @type {any} */ person) {
      const sent = rt.sendMessage(threadId, { ...body, by: people.byline(person) });
      people.answered(person, threadId);
      return sent;
    },
    /** A person changes their own profile. @param {any} person @param {unknown} fields */
    edit: (person, fields) => people.page(people.edit(person, fields)),
    /** A person reads or dismisses an entry of their queue. @param {any} person @param {string} id @param {any} body */
    settle: (person, id, body) => ({ entry: people.settle(person, id, body?.state) }),
  };
}
