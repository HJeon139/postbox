// The messages spoken on the host’s Unix sockets (shared/remote-protocol.mjs): the daemon and each runner, the shim
// and the daemon. Each maps a message type to its validator, which returns an error to show or ''.

import { bool, clip, fields, id, int, obj, str, streamLine, token, turnId } from './remote-protocol-checks.mjs';
import { REMOTE_LIMITS, TOOL_ROUTES } from './remote-protocol-constants.mjs';
import { checkDecision, checkError, checkRequest } from './remote-protocol-parts.mjs';
import { RANGES } from './remote-settings.mjs';

export const HOST_CHANNELS = {
  /** daemon → runner, over the runner’s socket. */
  'daemon-to-runner': {
    /** { token }: is this runner alive, and whose is it? */
    who: (m) => fields(m, 'who', ['token']) || token(m.token, 'who.token'),
    /** { line }: a line for the held stdin. */
    stdin: (m) => fields(m, 'stdin', ['line']) || streamLine(m.line, 'stdin.line'),
  },

  /** runner → daemon. */
  'runner-to-daemon': {
    /** { turn, pid }: the answer to who, with the turn’s ID. */
    iam: (m) => fields(m, 'iam', ['turn', 'pid']) || turnId(m.turn, 'iam.turn') || int(m.pid, 'iam.pid', 2, 2 ** 31),
    /** { upTo }: in.jsonl’s size once the stdin line is written. */
    written: (m) => fields(m, 'written', ['upTo']) || int(m.upTo, 'written.upTo', 1, Number.MAX_SAFE_INTEGER),
    error: (m) => checkError(m),
  },

  /** shim → daemon, over the daemon’s socket. */
  'shim-to-daemon': {
    /** { token, turn }: sent first, and again on each reconnect. */
    hello: (m) => fields(m, 'hello', ['token', 'turn']) || token(m.token, 'hello.token') || turnId(m.turn, 'hello.turn'),
    /** { id, name, args }: a tool call, other than permission_prompt. */
    call: (m) =>
      fields(m, 'call', ['id', 'name', 'args']) ||
      id(m.id, 'call.id') ||
      (Object.hasOwn(TOOL_ROUTES, m.name) && m.name !== 'permission_prompt' ? '' : `call.name “${clip(m.name)}” isn’t a Postbox tool the daemon serves.`) ||
      obj(m.args, 'call.args'),
    /** { id, request }: permission_prompt’s arguments. Resent with the same ID after a reconnect. */
    permission: (m) => fields(m, 'permission', ['id', 'request']) || id(m.id, 'permission.id') || checkRequest(m.request, 'permission.request'),
    /** { id, at }: the shim denied it at permissionWaitMax. */
    'permission-expired': (m) =>
      fields(m, 'permission-expired', ['id', 'at']) || id(m.id, 'permission-expired.id') || int(m.at, 'permission-expired.at', 0, Number.MAX_SAFE_INTEGER),
    /** { id, at }: the harness canceled the call (MCP’s cancel notification), so nobody waits on the answer. */
    'permission-canceled': (m) =>
      fields(m, 'permission-canceled', ['id', 'at']) || id(m.id, 'permission-canceled.id') || int(m.at, 'permission-canceled.at', 0, Number.MAX_SAFE_INTEGER),
  },

  /** daemon → shim. */
  'daemon-to-shim': {
    /** { turn, permissionWaitMax }: in milliseconds, as remote-settings.mjs’s RANGES bound it. */
    welcome: (m) =>
      fields(m, 'welcome', ['turn', 'permissionWaitMax']) ||
      turnId(m.turn, 'welcome.turn') ||
      int(m.permissionWaitMax, 'welcome.permissionWaitMax', RANGES.permissionWaitMax.min, RANGES.permissionWaitMax.max),
    /** { id, ok, text }: a call’s result, as the tool’s text content. */
    result: (m) =>
      fields(m, 'result', ['id', 'ok', 'text']) || id(m.id, 'result.id') || bool(m.ok, 'result.ok') || str(m.text, 'result.text', REMOTE_LIMITS.replyChars),
    /** { id, result }: the person’s answer. */
    'permission-answer': (m) =>
      fields(m, 'permission-answer', ['id', 'result']) || id(m.id, 'permission-answer.id') || checkDecision(m.result, 'permission-answer.result'),
    error: (m) => checkError(m),
  },
};
