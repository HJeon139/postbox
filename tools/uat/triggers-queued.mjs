// #827’s trigger of a host-mode run, host-queued-refused (tools/uat/triggers-host.mjs has the rest): an agent on a
// host called show_app or update_app with something the host’s daemon refuses, such as a codePath outside its folder,
// and the call itself came back as an error, in the daemon’s words. Before #827 the shim answered “Sent app …” at
// once and dropped the daemon’s refusal, so that call read as a success and the app never showed.
//
// The evidence is the agent’s own recorded stream (tools/uat/postbox-calls.mjs): the call, its result’s is_error, and
// its text. A call answered “Sent …” is a taken one, whatever Postbox did with it later, and isn’t an error, so it
// never fires; nor does the shim’s error for a daemon that didn’t take the call in time, which isn’t the host’s refusal.

import { postboxCalls } from './postbox-calls.mjs';
import { onHost, placeOf } from './remote-facts.mjs';

const APP_CALLS = new Set(['show_app', 'update_app']);
/** The shim’s own words for a daemon that didn’t take the call in time (shim-calls.mjs), which isn’t a refusal. */
const NOT_TAKEN = /^Postbox’s daemon on this host /;

/** @param {any} f */
function queuedRefused(f) {
  const streams = (f.streams ?? []).filter((s) => onHost(f, s.handle));
  return postboxCalls(streams)
    .filter((c) => APP_CALLS.has(c.name) && c.error && !NOT_TAKEN.test(c.text))
    .map((c) => ({
      at: c.at,
      evidence: `${placeOf(f, c.handle)}: @${c.handle}’s ${c.name} was refused in the call: “${c.text.slice(0, 160)}”`,
    }));
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const QUEUED_TRIGGERS = {
  'host-queued-refused': {
    issue: 827,
    says: 'an app call that a host refused came back to its agent as an error, in the call, instead of “Sent”',
    recorded: (f) => Boolean(f.hosts?.hosts?.length),
    run: queuedRefused,
  },
};
