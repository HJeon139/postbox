// The host’s shim’s link to the daemon (#120): its Unix socket, connected again with a backoff whenever it drops, the
// hello with its turn’s token (read on each connect), and what the daemon sends back.

import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createMessageReader, encode, message, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { armExpiry, watchDown } from './shim-calls.mjs';
import { log, respond, textResult } from './shim-harness.mjs';
import { deliver, settle, TIMINGS } from './shim-state.mjs';

/** @typedef {import('./shim-state.mjs').Shim} Shim */

/** Connects to the daemon’s socket, and says hello once it’s up. @param {Shim} sh */
export function connect(sh) {
  sh.retry = null;
  if (sh.stopping) return;
  // Its own turn’s token, which the daemon wrote in the turn’s folder before the turn started (broker-shim.mjs).
  const tokenPath = sh.P.turn(sh.turn, TURN_FILES.shimToken);
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch (e) {
    if (!sh.quiet) log(`Couldn’t read this turn’s token at ${tokenPath} (${e.code ?? e.message}); trying again until it can.`);
    sh.quiet = true;
    return reconnectLater(sh);
  }
  let hello;
  try {
    hello = encode(message('shim-to-daemon', 'hello', { token, turn: sh.turn }));
  } catch (e) {
    log(`The token at ${tokenPath} isn’t one the daemon takes: ${e.message}`);
    return reconnectLater(sh);
  }
  const s = createConnection(sh.P.socket);
  sh.sock = s;
  const reader = createMessageReader('daemon-to-shim', {
    onMessage: (m) => sh.sock === s && fromDaemon(sh, m),
    onError: (e) => log(`The daemon sent a line the shim refused: ${e.message}`),
  });
  s.on('connect', () => s.write(hello));
  s.on('data', (chunk) => reader.push(chunk));
  s.on('error', (e) => {
    // A daemon that isn’t up yet, or restarting, is the usual case: say so once, not on every attempt.
    if (sh.sock !== s || sh.quiet) return;
    sh.quiet = true;
    log(`The daemon’s socket isn’t answering (${/** @type {any} */ (e).code ?? e.message}); trying again until it does.`);
  });
  s.on('close', () => {
    if (sh.sock !== s) return;
    sh.sock = null;
    sh.ready = false;
    for (const p of sh.pending.values()) if (p.kind === 'ask') watchDown(sh, p);
    reconnectLater(sh);
  });
}

/** @param {Shim} sh */
function reconnectLater(sh) {
  if (sh.stopping || sh.retry) return;
  sh.retry = setTimeout(() => connect(sh), sh.backoff);
  sh.backoff = Math.min(sh.backoff * 2, TIMINGS.backoffMax);
}

/** @param {Shim} sh @param {{ type: string, [field: string]: any }} m */
function fromDaemon(sh, m) {
  switch (m.type) {
    case 'welcome': {
      if (m.turn !== sh.turn) log(`The daemon welcomed turn ${m.turn}, not ${sh.turn}.`);
      sh.ready = true;
      sh.quiet = false;
      sh.backoff = TIMINGS.backoff;
      sh.waitMax = m.permissionWaitMax;
      for (const [id, p] of sh.pending) {
        if (p.down) clearTimeout(p.down);
        p.down = null;
        if (p.kind === 'permission') armExpiry(sh, p, id);
      }
      for (const [id, p] of [...sh.pending]) deliver(sh, p, id);
      return;
    }
    case 'result': {
      const p = sh.pending.get(m.id);
      if (!p || (p.kind !== 'queue' && p.kind !== 'ask')) return;
      settle(sh, m.id);
      // A queued call’s agent already has its answer; a refusal here is the daemon’s to report to Postbox.
      if (p.kind === 'queue') {
        if (!m.ok) log(`Postbox’s daemon refused ${p.tool} (${m.id}): ${m.text}`);
        return;
      }
      respond(p.rpcId, textResult(m.text, !m.ok));
      return;
    }
    case 'permission-answer': {
      const p = sh.pending.get(m.id);
      if (p?.kind !== 'permission') return;
      settle(sh, m.id);
      const r = m.result;
      // The laptop’s permission() shape, key for key.
      const decision =
        r.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: r.updatedInput, ...(r.updatedPermissions ? { updatedPermissions: r.updatedPermissions } : {}) }
          : { behavior: 'deny', message: r.message };
      respond(p.rpcId, textResult(JSON.stringify(decision)));
      return;
    }
    case 'error': {
      log(`The daemon said ${m.code}: ${m.message}`);
      // A token it refuses or a turn that has ended won’t answer what waits, so those calls end now, with its reason.
      // A prompt is denied, never allowed.
      if (m.code === 'bad-token' || m.code === 'turn-ended') refuseAll(sh, m);
      return;
    }
  }
}

/** Every asked call and prompt ends with the daemon’s refusal; a prompt is denied. @param {Shim} sh @param {{ [field: string]: any }} m */
function refuseAll(sh, m) {
  for (const [id, p] of [...sh.pending]) {
    if (p.kind === 'ask') {
      settle(sh, id);
      respond(p.rpcId, textResult(`Postbox’s daemon on this host refused ${p.tool}: ${m.message}`, true));
    } else if (p.kind === 'permission') {
      settle(sh, id);
      respond(p.rpcId, textResult(JSON.stringify({ behavior: 'deny', message: `Postbox’s daemon on this host refused the prompt: ${m.message}` })));
    }
  }
}
