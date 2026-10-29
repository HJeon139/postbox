// The host’s shim’s tool calls (#120): a tool call sent to the daemon, queued or waited on, and permission_prompt,
// which waits for the person’s answer or denies at permissionWaitMax. shim.mjs’s header says how each waits.

import { NOT_YOUR_PROMPT, TOOL_DEFS } from '../../../shared/mcp-tools.mjs';
import { encode, message, TOOL_ROUTES } from '../../../shared/remote-protocol.mjs';
import { fail, minutes, queuedText, respond, send, textResult } from './shim-harness.mjs';
import { after, deliver, settle, TIMINGS } from './shim-state.mjs';

/**
 * @typedef {import('./shim-state.mjs').Shim} Shim
 * @typedef {import('./shim-state.mjs').Pending} Pending
 */

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

/** tools/call, for any tool. @param {Shim} sh @param {any} rpcId @param {any} params */
export function toolCall(sh, rpcId, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (typeof name !== 'string' || !TOOL_NAMES.has(name) || !Object.hasOwn(TOOL_ROUTES, name)) return fail(rpcId, -32602, `There’s no tool called “${name}”.`);
  // As on the laptop (server/mcp.mjs): a backend that asks another way gets no card, and its call returns at once.
  if (name === 'permission_prompt' && !sh.asksByPrompt) return respond(rpcId, NOT_YOUR_PROMPT);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail(rpcId, -32602, `${name}’s arguments must be an object.`);
  if (name === 'permission_prompt') return permission(sh, rpcId, args, params?._meta?.progressToken);
  const route = TOOL_ROUTES[name];
  // show_app without an id gets one here, so the text can name it and the agent can update it; the laptop would
  // pick one the same way (newId('app')).
  const sent = name === 'show_app' && typeof args.id !== 'string' ? { ...args, id: `app_${sh.nextId()}` } : args;
  const id = sh.nextId();
  let msg;
  try {
    msg = message('shim-to-daemon', 'call', { id, name, args: sent });
    encode(msg);
  } catch (e) {
    return respond(rpcId, textResult(`Postbox couldn’t send ${name}: ${e.message}`, true));
  }
  /** @type {Pending} */
  const p = { msg, kind: route === 'queue' ? 'queue' : 'ask', started: Date.now(), timers: new Set(), tool: name, down: null };
  sh.pending.set(id, p);
  if (route === 'queue') {
    deliver(sh, p, id);
    return respond(rpcId, textResult(queuedText(name, sent)));
  }
  p.rpcId = rpcId;
  sh.byRequest.set(JSON.stringify(rpcId), id);
  after(
    p,
    () => {
      if (!settle(sh, id)) return;
      respond(
        rpcId,
        textResult(
          `Postbox didn’t answer ${name} within ${minutes(TIMINGS.askMax)}, so it ended without a result. Postbox may still apply it once it answers, so check the conversation before you call it again.`,
          true,
        ),
      );
    },
    TIMINGS.askMax,
  );
  if (!sh.ready) watchDown(sh, p);
  deliver(sh, p, id);
}

/** An asked call fails once the daemon has been unreachable for TIMINGS.unreachable. @param {Shim} sh @param {Pending} p */
export function watchDown(sh, p) {
  if (p.down) return;
  const id = p.msg.id;
  p.down = setTimeout(() => {
    p.down = null;
    if (sh.ready || !settle(sh, id)) return;
    respond(
      p.rpcId,
      textResult(`Postbox’s daemon on this host isn’t reachable, so ${p.tool} couldn’t run. The daemon may be restarting; try again in a minute.`, true),
    );
  }, TIMINGS.unreachable);
  p.down.unref();
}

/**
 * permission_prompt: waits for the person’s answer, or denies at permissionWaitMax.
 * @param {Shim} sh @param {any} rpcId @param {Record<string, any>} args @param {unknown} progressToken
 */
function permission(sh, rpcId, args, progressToken) {
  const id = sh.nextId();
  let msg;
  try {
    msg = message('shim-to-daemon', 'permission', { id, request: args });
    encode(msg);
  } catch (e) {
    // A request Postbox can’t carry is denied with the reason, never allowed.
    return respond(rpcId, textResult(JSON.stringify({ behavior: 'deny', message: `Postbox couldn’t show this permission request: ${e.message}` })));
  }
  /** @type {Pending} */
  const p = { msg, kind: 'permission', rpcId, started: Date.now(), timers: new Set(), tool: 'permission_prompt' };
  if (typeof progressToken === 'string' || (typeof progressToken === 'number' && Number.isFinite(progressToken))) {
    p.progress = { token: progressToken, value: 0 };
    const tick = () => {
      if (!sh.pending.has(id) || !p.progress) return;
      p.progress.value += 1;
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: p.progress.token, progress: p.progress.value, message: 'Waiting for the person to answer in Postbox.' },
      });
      after(p, tick, TIMINGS.progress);
    };
    after(p, tick, TIMINGS.progress);
  }
  sh.pending.set(id, p);
  sh.byRequest.set(JSON.stringify(rpcId), id);
  armExpiry(sh, p, id);
  deliver(sh, p, id);
}

/** (Re)sets a prompt’s deadline from when it was asked, by the latest permissionWaitMax. @param {Shim} sh @param {Pending} p @param {string} id */
export function armExpiry(sh, p, id) {
  const old = sh.expiries.get(p);
  if (old) {
    clearTimeout(old);
    p.timers.delete(old);
  }
  const limit = Math.min(sh.waitMax, TIMINGS.waitMax);
  const t = after(p, () => expire(sh, id, limit), Math.max(0, p.started + limit - Date.now()));
  sh.expiries.set(p, t);
}

/** @param {Shim} sh @param {string} id @param {number} limit */
function expire(sh, id, limit) {
  const p = settle(sh, id);
  if (!p) return;
  const message = `Nobody answered this permission request in Postbox within ${minutes(limit)}, so it was denied. Ask again if you still need it.`;
  respond(p.rpcId, textResult(JSON.stringify({ behavior: 'deny', message })));
  notify(sh, 'permission-expired', id);
}

/**
 * Tells the daemon a prompt ended without the person’s answer (`permission-expired` or `permission-canceled`), kept
 * until it’s sent to a welcomed link, so the card can say so after a reconnect.
 * @param {Shim} sh @param {'permission-expired' | 'permission-canceled'} type @param {string} id
 */
export function notify(sh, type, id) {
  const key = `notice:${id}`;
  /** @type {Pending} */
  const notice = { msg: messageFor(type, { id, at: Date.now() }), kind: 'notice', started: Date.now(), timers: new Set() };
  sh.pending.set(key, notice);
  deliver(sh, notice, key);
}

/** @param {string} type @param {Record<string, unknown>} body */
const messageFor = (type, body) => message('shim-to-daemon', type, body);
