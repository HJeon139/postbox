// A Postbox start on a data folder, for redis-ownership.test.mjs’s simultaneous-start spec (review finding SR-6 on
// #525). It stops just before it writes the config, says so, and goes on only when the spec says `go`: the widest
// window two starts have to both get past the ownership check.

import { RedisSupervisor } from '../../server/redis-supervisor.mjs';

const sup = new RedisSupervisor({ home: /** @type {string} */ (process.env.POSTBOX_REDIS_HOME), dataDir: process.argv[2] });
const write = sup.writeConf.bind(sup);
sup.writeConf = async (...args) => {
  process.send?.({ kind: 'checked' });
  await new Promise((ok) => process.on('message', (m) => m === 'go' && ok(undefined)));
  return write(...args);
};
process.on('message', async (m) => {
  if (m !== 'stop') return;
  await sup.stop();
  process.exit(0);
});
try {
  await sup.start();
  process.send?.({ kind: 'ready', pid: sup.child?.pid, socket: sup.socket });
} catch (e) {
  const s = /** @type {any} */ (sup.status);
  process.send?.({ kind: 'failed', code: e.code, cause: s.cause, message: e.message });
}
