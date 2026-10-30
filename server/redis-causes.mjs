// Why the store’s Redis child isn’t running, and what Postbox says about it (server/redis-supervisor.mjs, down()):
// read from the child’s log when it stops, or named by the supervisor itself. Moved from redis-supervisor.mjs.

/** @typedef {'socket' | 'owned' | 'binary-missing' | 'corrupt-aof' | 'died'} DownCause */

/** Why the child stopped, from what it logged. @param {string} log @returns {DownCause} */
export function causeOf(log) {
  if (/Failed opening Unix socket|Could not create server TCP listening socket/i.test(log)) return 'socket';
  if (/Bad file format reading the append only file|Unrecoverable error reading the append only file|AOF.*(corrupt|format)/i.test(log)) return 'corrupt-aof';
  return 'died';
}

/** @type {Record<DownCause, (s: { home: string, dataDir: string }, detail?: string) => string>} */
export const MESSAGES = {
  socket: () =>
    'The store’s Redis couldn’t open its private socket. Check that the data folder’s redis/run folder (or the private folder Postbox made for it in the temporary folder) belongs to you and isn’t a link, then Retry.',
  owned: (_, detail) => `Postbox didn’t start the store’s Redis: it found one already running on this data folder. ${detail}`,
  // No data path in these: a refused write’s reason reaches /mcp callers, and the server log has the path (down()).
  'binary-missing': () => 'The store’s Redis isn’t where Postbox keeps it. Start Postbox again to download it.',
  'corrupt-aof': () =>
    'The store’s append-only file is damaged, so Redis won’t load it. Restore the data folder from its backup, or repair it with redis-check-aof (the server log names the file), then Retry.',
  died: () => 'The store’s Redis stopped. Postbox is starting it again; writes wait until it’s back.',
};
