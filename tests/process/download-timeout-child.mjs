// A Node whose only pending work is a Redis download whose request never answers. It must stay up until the
// download’s time limit gives the download up (server/redis-download.mjs), not exit with the wait unsettled.
import { fetchRedisBuild } from '../../server/redis-download.mjs';

const hanging = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
try {
  await fetchRedisBuild({ dataDir: process.argv[2], platform: 'linux', arch: 'x64', fetch: hanging, timeoutMs: 200 });
  console.log('finished without an error');
} catch (e) {
  console.log(`settled: ${e.code}`);
}
