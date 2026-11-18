// Loaded with --import into every Node process a bench starts: Postbox’s own (server/index.mjs) waits 30 s before it
// starts, so a signal sent while the bench waits for it lands in a step that doesn’t use the page, with no load needed
// (#1489). Every other process starts as usual.

import { join } from 'node:path';

if (process.argv[1]?.endsWith(join('server', 'index.mjs'))) await new Promise((ok) => setTimeout(ok, 30_000));
