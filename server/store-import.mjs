// The one-time import of the old store into Redis lands in the next commit.

/**
 * @param {string} _dir @param {import('./redis-client.mjs').RedisClient} _client
 */
export async function importLegacy(_dir, _client) {
  return false;
}
