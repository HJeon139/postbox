// Before a run: stop the test browsers and servers a killed earlier run left behind (tools/orphans.mjs).
import { stopOrphans } from '../../tools/orphans.mjs';

export default async function globalSetup() {
  await stopOrphans({ log: (line) => console.log(line) });
}
