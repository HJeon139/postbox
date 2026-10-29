// A Postbox that tests/process/start-signal.test.mjs stops with a signal while it starts (SR-6). argv: the data folder,
// then which moment it reports on stdout, after which the test sends its signal:
//   before-spawn  its start is about to write redis.conf: no Redis child yet
//   spawned       its Redis child is spawned and hasn’t said it’s ready (the supervisor never reads the ready line)
//   ready         its Redis child is ready, and the rest of the start never finishes (#525 review’s repro)
//   slow-stop     as ready, and stopping the child takes 30 s, so only a second signal ends Postbox soon
//   started       the start finished: Postbox runs
//   fails         the start fails after its Redis child is ready (its first connection is refused)

import { main } from '../../bin/postbox.mjs';
import { start } from '../../server/index.mjs';
import { RedisSupervisor } from '../../server/redis-supervisor.mjs';

const [dataDir, moment] = process.argv.slice(2);
const proto = RedisSupervisor.prototype;
const { writeConf, run, end, client } = proto;
const hang = () => new Promise(() => setInterval(() => {}, 1000));

if (moment === 'before-spawn')
  proto.writeConf = async function (...a) {
    console.log(`AT before-spawn state=${this.status.state} child=${this.child?.pid ?? 'none'}`);
    await new Promise((ok) => setTimeout(ok, 300));
    return writeConf.apply(this, a);
  };
if (moment === 'spawned')
  proto.run = function (...a) {
    const p = run.apply(this, a);
    // Nothing reads the child’s output, so its ready line never arrives.
    this.child?.stdout?.pause();
    this.child?.stderr?.pause();
    console.log(`AT spawned state=${this.status.state} REDIS_PID=${this.child?.pid}`);
    return p;
  };
if (moment === 'ready' || moment === 'slow-stop')
  proto.run = async function (...a) {
    await run.apply(this, a);
    console.log(`AT ${moment} state=${this.status.state} REDIS_PID=${this.child?.pid}`);
    return hang();
  };
if (moment === 'slow-stop')
  proto.end = async function (...a) {
    await new Promise((ok) => setTimeout(ok, 30_000));
    return end.apply(this, a);
  };
if (moment === 'fails')
  proto.client = function () {
    console.log(`AT fails state=${this.status.state} REDIS_PID=${this.child?.pid}`);
    return Promise.reject(new Error('The test refused the store’s first connection.'));
  };
if (moment === 'started') {
  let pid;
  proto.client = function () {
    pid = this.child?.pid;
    return client.apply(this, []);
  };
  await main(['--port', '4499', '--data', dataDir], (o) => start({ ...o, quiet: true, listen: false, hosts: null }));
  console.log(`AT started REDIS_PID=${pid}`);
} else await main(['--port', '4499', '--data', dataDir], (o) => start({ ...o, quiet: true, listen: false, hosts: null }));
