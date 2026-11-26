// Which Postbox wrote a data folder (#683). An older Postbox that loaded a folder a newer one wrote couldn’t replay the
// event types it doesn’t know (apply throws on them, shared/state.mjs), so it started without what the newer one had
// logged since its last snapshot, and its next snapshot made that loss permanent. The folder now records the event
// types the last Postbox to load it knows, with its version, in `format.json`; a Postbox that finds one it doesn’t know
// refuses the folder before it takes the lock, and changes nothing in it.

import { readFileSync } from 'node:fs';
import { EVENTS } from '../shared/state.mjs';

export const FORMAT_FILE = 'format.json';

/** This Postbox’s version, from its package.json. */
const OURS = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** What this Postbox records: its version, and every event type it can replay. */
const record = () => ({ version: OURS, events: Object.keys(EVENTS).sort() });

/**
 * Refuses a folder a newer Postbox wrote: one whose record names an event type this one can’t replay. A folder with no
 * record is one no Postbox since #683 has loaded, which this one can read. Reads only.
 * @param {{ readFile: Function }} io @param {(name: string) => string} at  a path in the folder
 */
export async function checkFormat(io, at) {
  let text;
  try {
    text = await io.readFile(at(FORMAT_FILE), 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return;
    throw e;
  }
  const was = JSON.parse(text);
  const unknown = (Array.isArray(was?.events) ? was.events : []).filter((t) => typeof t === 'string' && !Object.hasOwn(EVENTS, t));
  if (!unknown.length) return;
  const version = typeof was.version === 'string' ? was.version : 'a newer version';
  const kinds = unknown.length === 1 ? 'a kind of event' : `${unknown.length} kinds of event`;
  throw Object.assign(
    new Error(
      `This data folder was last opened by Postbox ${version}, which records ${kinds} this Postbox (${OURS}) can’t read: ${unknown.join(', ')}. Run Postbox ${version} or newer on it. Nothing in the folder was changed.`,
    ),
    { code: 'NEWER_FORMAT' },
  );
}

/**
 * Records this Postbox as the last to load the folder, once it holds the lock and has read it, unless the record says
 * so already. Written whole, through a temporary file and a rename.
 * @param {{ readFile: Function, writeFile: Function, rename: Function }} io @param {(name: string) => string} at
 */
export async function recordFormat(io, at) {
  const text = `${JSON.stringify(record())}\n`;
  const was = await io.readFile(at(FORMAT_FILE), 'utf8').catch(() => null);
  if (was === text) return;
  const tmp = at(`${FORMAT_FILE}.${process.pid}.tmp`);
  await io.writeFile(tmp, text);
  await io.rename(tmp, at(FORMAT_FILE));
}
