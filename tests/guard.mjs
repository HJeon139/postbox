// Loaded before every test file (npm test): tests must be fast and self-contained, so anything that would
// reach the network or start a real process fails loudly instead. Adapters take fake spawn/fork functions,
// and the runtime takes a stub corpus, so none of them need the real thing.
//
// One exception: the store (server/store.mjs) is a Redis 8 child process, and a store opened on a data folder starts
// that folder’s child, so the suite can run on the store Postbox really has (#508’s design, “Storage”). A test may
// spawn exactly the redis-server of POSTBOX_REDIS_HOME, and connect to the Unix socket one of those children was given
// in its config file. Nothing else: no other binary, host, port or socket (tests/AGENTS.md, “The store’s Redis”).

import childProcess from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';

const refuse = (what) => () => {
  throw new Error(`A test tried to ${what}. Tests must not touch the network or start processes; pass a fake instead.`);
};

/** The real redis-server of POSTBOX_REDIS_HOME, or null. */
const redisServer = (() => {
  const home = process.env.POSTBOX_REDIS_HOME;
  if (!home) return null;
  const found = ['bin/redis-server', 'src/redis-server'].map((p) => join(home, p)).find((p) => existsSync(p));
  return found ? realpathSync(found) : null;
})();
/** The Unix sockets the Redis children were given. */
const redisSockets = new Set();
const realSpawn = childProcess.spawn;
const realConnect = net.Socket.prototype.connect;

/** Whether this spawn starts the store’s Redis, and if so, notes its socket from its config file. */
function isRedis(cmd, args) {
  if (!redisServer || typeof cmd !== 'string' || !existsSync(cmd) || realpathSync(cmd) !== redisServer) return false;
  const conf = readFileSync(String(args?.[0]), 'utf8');
  const socket = conf.match(/^unixsocket "((?:[^"\\]|\\.)*)"$/m)?.[1]?.replace(/\\(.)/g, '$1');
  if (socket) redisSockets.add(socket);
  return true;
}

/** Whether a connect call goes to one of those children’s sockets, and nowhere else. */
function toRedis(args) {
  const o = typeof args[0] === 'object' && args[0] !== null ? args[0] : { path: args[0] };
  return typeof o.path === 'string' && redisSockets.has(o.path) && o.port === undefined && o.host === undefined;
}

globalThis.fetch = refuse('fetch a URL');
net.connect = net.createConnection = function connect(...args) {
  if (!toRedis(args)) refuse('open a network connection')();
  const socket = new net.Socket();
  return realConnect.apply(socket, args);
};
net.Socket.prototype.connect = function connect(...args) {
  if (!toRedis(args)) refuse('open a network connection')();
  return realConnect.apply(this, args);
};
http.request = http.get = refuse('make an HTTP request');
https.request = https.get = refuse('make an HTTPS request');
for (const fn of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[fn] = refuse(`start a process (${fn})`);
childProcess.spawn = /** @type {any} */ (
  (cmd, args, opts) => {
    if (!isRedis(cmd, args)) refuse('start a process (spawn)')();
    return realSpawn(cmd, args, opts);
  }
);
// Named imports (import { spawn } from 'node:child_process') see the replacements too.
syncBuiltinESMExports();
