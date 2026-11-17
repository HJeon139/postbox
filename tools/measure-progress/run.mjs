// One run of one section of the live-progress measurement, in a process of its own (tools/measure-progress.mjs runs it
// N times, each fresh, so one run’s JIT order or leftovers can’t move another’s numbers). It prints its rows as one
// line of JSON after RESULT. A dropped event, one the store couldn’t write, fails the run: a number from a log that lost
// events isn’t one.
//
//   node --expose-gc tools/measure-progress/run.mjs <section> [args]

import { virtualClock } from './drive.mjs';
import { restartBuild, restartLoad } from './restart.mjs';
import { backends, crowded, long } from './sections.mjs';

/** @type {string[]} */
const dropped = [];
const error = console.error;
console.error = (/** @type {any[]} */ ...args) => {
  const text = args.map(String).join(' ');
  if (/event after the store closed was dropped|An event wasn’t written/.test(text)) dropped.push(text);
  error(...args);
};

const [section, ...args] = process.argv.slice(2);
/** @type {Record<string, (...a: string[]) => Promise<any[]>>} */
const SECTIONS = { backends, long, crowded, 'restart-build': restartBuild, 'restart-load': restartLoad };
if (!Object.hasOwn(SECTIONS, section)) throw new Error(`No section “${section}”. Name one of: ${Object.keys(SECTIONS).join(', ')}.`);
if (section !== 'restart-load') virtualClock();
const rows = await SECTIONS[section](...args);
if (dropped.length) {
  error(`The run dropped ${dropped.length} event(s), so its numbers don’t count: ${dropped[0]}`);
  process.exit(1);
}
console.log(`RESULT ${JSON.stringify(rows)}`);
process.exit(0);
