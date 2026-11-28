// Backend conformance (#585): checks that what Postbox gives each backend as its guide is what the backend itself
// saved or sent, with no model, no sign-in and no token. Opt-in: it starts real CLIs, so it never runs in npm run
// check or CI. Run it again when a backend’s version changes (tools/AGENTS.md, “Backend conformance”).
//
//   node tools/backend-conformance.mjs [codex] [agy] [--record <folder>]
//
// Prints each backend’s version and each check’s result, and exits 1 when any check fails. --record writes the Codex
// fixtures into the folder (tools/conformance/record.mjs), such as tests/fixtures/codex-conformance.

import { BACKENDS, checkBackend, summary } from './conformance/run.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--record');
const record = at === -1 ? undefined : args[at + 1];
if (at !== -1 && (!record || record.startsWith('--'))) {
  console.error('--record needs a folder to write the fixtures into, such as tests/fixtures/codex-conformance.');
  process.exit(2);
}
const asked = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
const unknown = asked.filter((name) => !Object.hasOwn(BACKENDS, name));
if (unknown.length) {
  console.error(`No conformance check for ${unknown.join(', ')}. Name any of: ${Object.keys(BACKENDS).join(', ')}.`);
  process.exit(2);
}
const runs = [];
for (const backend of asked.length ? asked : Object.keys(BACKENDS)) runs.push(await checkBackend(backend, BACKENDS, undefined, record));
console.log(summary(runs).join('\n'));
const failed = runs.flatMap((r) => r.results).filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed.` : '\nEvery check passed.');
process.exitCode = failed ? 1 : 0;
