// What every headless Chrome check (tools/check-*.mjs and tools/checks/*.mjs) shares: the ports it runs on, and
// one output contract, so that `npm run check:browser` (tools/check-all.mjs) reads results, not text.
//   - One line per case: `  ok    name`, or `  FAIL  name` with the reason indented under it.
//   - A last line: `N passed, M failed.`, and exit code 1 on any failure.
//   - When PB_CHECK_RESULTS names a file, the same results as JSON: { passed, failed, cases: [{ name, ok, detail? }] }.
// An error thrown outside a case fails the check as “the check ran to the end”, with the error, instead of
// leaving it without a summary.

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

/** @type {{ name: string, ok: boolean, detail?: string }[]} */
const cases = [];

/** Records one case and prints its line. Returns whether it passed. */
export function record(ok, name, detail = '') {
  const pass = !!ok;
  const why = !pass && detail !== '' ? String(detail) : '';
  cases.push(why ? { name, ok: pass, detail: why } : { name, ok: pass });
  console.log(pass ? `  ok    ${name}` : `  FAIL  ${name}${why ? `\n        ${why.split('\n').join('\n        ')}` : ''}`);
  return pass;
}

/** How many cases have failed so far. */
export const failed = () => cases.filter((c) => !c.ok).length;

/** Prints the summary, writes PB_CHECK_RESULTS when it’s set, and exits: 1 when any case failed. */
export function finish() {
  const bad = failed();
  const passed = cases.length - bad;
  console.log(`\n${passed} passed, ${bad} failed.`);
  if (process.env.PB_CHECK_RESULTS) writeFileSync(process.env.PB_CHECK_RESULTS, `${JSON.stringify({ passed, failed: bad, cases }, null, 2)}\n`);
  process.exit(bad ? 1 : 0);
}

const crashed = (e) => {
  record(false, 'the check ran to the end', e?.stack ?? String(e));
  finish();
};
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);

/** Whether nothing listens on a port of 127.0.0.1. */
export const free = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

/**
 * The ports a check runs on: PB_PORT for Postbox (and the `span - 1` ports after it, for a second server) and
 * PB_CHROME_PORT for Chrome, or the check’s own defaults. Sessions working in parallel set them, and check-all
 * gives every check its own. Fails the check at once when one is in use.
 */
export async function ports(port, chromePort, { span = 1 } = {}) {
  const PORT = Number(process.env.PB_PORT ?? port);
  const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? chromePort);
  const busy = [];
  for (const p of [...Array.from({ length: span }, (_, i) => PORT + i), CHROME_PORT]) if (!(await free(p))) busy.push(p);
  if (busy.length) {
    const one = busy.length === 1;
    record(
      false,
      'the ports it needs are free',
      `${one ? 'Port' : 'Ports'} ${busy.join(' and ')} ${one ? 'is' : 'are'} in use. Stop whatever is on ${one ? 'it' : 'them'}, or set PB_PORT and PB_CHROME_PORT.`,
    );
    finish();
  }
  return { PORT, CHROME_PORT };
}
