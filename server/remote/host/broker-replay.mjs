// The broker after a daemon restart (#120): each turn folder’s tools.jsonl and prompts.jsonl replayed, so everything
// waiting for Postbox is waiting again. broker.mjs’s header says what each record means.

import { promises as fsp } from 'node:fs';
import { REMOTE_LIMITS, TOOL_ROUTES, TURN_FILES, validateMessage } from '../../../shared/remote-protocol.mjs';
import { watchCodex } from './broker-codex.mjs';
import { armOrphan } from './broker-prompts.mjs';
import { CANCELED, key } from './broker-state.mjs';
import { toolBytes } from './broker-tools.mjs';

/** @typedef {import('./broker-state.mjs').Broker} Broker */

/**
 * The shim a prompt or call record names (#353, #908): its key’s SHA-256, or null for one that sent no key (before
 * #908), which no shim can take. A record an older daemon wrote has no owner at all (undefined), and the first shim to
 * send it again takes it.
 * @param {any} r
 */
function ownerOf(r) {
  if (r.owner === null) return null;
  return typeof r.owner === 'string' && /^[0-9a-f]{64}$/.test(r.owner) ? r.owner : undefined;
}

/**
 * Replays every turn folder’s records, and starts watching the held Codex turns still running.
 * @param {Broker} b @param {{ turn: string, state: string }[]} turns
 */
export async function load(b, turns) {
  for (const t of turns) await loadTurn(b, t.turn);
  for (const q of b.prompts.values()) if (q.replayed && !q.answer) armOrphan(b, q);
  for (const t of turns) if (t.state === 'running') await watchCodex(b, t.turn);
}

/** Each JSON line of a turn file; a torn last line (a crash mid-append) is skipped. @param {string} path */
async function lines(path) {
  let text;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === 'object' && typeof v.op === 'string' && typeof v.id === 'string') out.push(v);
    } catch {}
  }
  return out;
}

/** Replays one turn’s tools.jsonl and prompts.jsonl. @param {Broker} b @param {string} turn */
async function loadTurn(b, turn) {
  for (const r of await lines(b.p.turn(turn, TURN_FILES.tools))) {
    const k = key(turn, r.id);
    if (r.op === 'stopping') b.stopping.add(turn);
    else if (r.op === 'call' && !b.tools.has(k) && (r.route === 'queue' || r.route === 'ask' || r.route === 'read') && Object.hasOwn(TOOL_ROUTES, r.name)) {
      const body = { turn, id: r.id, name: r.name, args: r.args ?? {} };
      // A record that wouldn’t make a valid tool message is left out, never sent.
      if (validateMessage('daemon-to-postbox', { type: 'tool', ...body }).ok) {
        const arrived = Number.isSafeInteger(r.at) && r.at >= 0 ? r.at : b.now();
        const bytes = toolBytes(turn, r.name, r.args ?? {});
        b.tools.set(k, { turn, id: r.id, name: r.name, route: r.route, args: r.args, replied: false, owner: ownerOf(r), bytes, arrived });
      }
    } else if (r.op === 'owner') {
      // The first shim to send an ownerless call again took it (broker-tools.mjs’s answerResend).
      const t = b.tools.get(k);
      if (t && t.owner === undefined) t.owner = ownerOf(r);
    } else if (r.op === 'reply') {
      const t = b.tools.get(k);
      if (t) {
        t.replied = true;
        t.args = null;
        if ((t.route === 'ask' || t.route === 'read') && typeof r.ok === 'boolean' && typeof r.text === 'string' && r.text.length <= REMOTE_LIMITS.replyChars)
          t.result = { ok: r.ok, text: r.text };
      }
    }
  }
  for (const r of await lines(b.p.turn(turn, TURN_FILES.prompts))) {
    const k = key(turn, r.id);
    if (r.op === 'prompt' && !b.prompts.has(k)) {
      const at = Number.isSafeInteger(r.at) && r.at >= 0 ? r.at : b.now();
      // A record an older daemon wrote has no entry: it gets one from its own `at`, the same at every start.
      const entry = r.entry ?? `at-${at}`;
      if (validateMessage('daemon-to-postbox', { type: 'prompt', id: r.id, turn, entry, request: r.request }).ok)
        b.prompts.set(k, { turn, id: r.id, entry, request: r.request, answer: null, over: false, at, owner: ownerOf(r), asked: new Set(), replayed: true });
    } else if (r.op === 'answer') {
      const q = b.prompts.get(k);
      if (q && validateMessage('daemon-to-shim', { type: 'permission-answer', id: r.id, result: r.result }).ok) q.answer = r.result;
    } else if (r.op === 'expired') {
      b.prompts.delete(k);
      const reason = r.reason === CANCELED ? CANCELED : 'expired';
      if (Number.isSafeInteger(r.at) && r.at >= 0) b.expiries.set(k, { turn, id: r.id, at: r.at, reason });
    } else if (r.op === 'expiry-sent' || r.op === 'codex-answered') {
      b.expiries.delete(k);
      b.codexHeard.add(k);
    } else if (r.op === 'codex' && Number.isSafeInteger(r.at)) b.codexSeen.set(k, r.at);
  }
}
