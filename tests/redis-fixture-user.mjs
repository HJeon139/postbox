// Test-only commands on the store’s Redis (#508’s requirements, SR-3). Postbox’s own user may run only what the store
// sends, so a spec that sets up a failure (CONFIG SET maxmemory), reads Redis’s stats (INFO), counts a stream (XLEN) or
// drops a connection (CLIENT KILL) does it as the `fixture` user, which a child has only when a test asked for it before
// the child started. Importing this module asks; Postbox itself never does.

import { RedisSupervisor } from '../server/redis-supervisor.mjs';

RedisSupervisor.fixtureUser = true;

/** A connection with every command, to a store’s Redis. @param {any} store  a Store on a data folder */
export const admin = (store) => store.redis.sup.fixtureClient();
