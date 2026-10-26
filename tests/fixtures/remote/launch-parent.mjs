// The daemon’s part in tests/remote-runner.test.mjs’s “outlives its parent” test: it launches a runner the way the
// daemon does, prints the runner’s PID, and exits straight away, before the runner’s turn ends.

import { launchRunner } from '../../../server/remote/host/runner.mjs';

const { pid } = launchRunner({ node: process.execPath, turn: process.argv[2], scope: 'setsid' });
process.stdout.write(`${pid}\n`);
process.exit(0);
