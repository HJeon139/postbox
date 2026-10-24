// The protocol’s checks on the parts of messages that more than one message carries (shared/remote-protocol.mjs):
// argv, env, files, settings, an exit, snapshot items, a permission request and its decision, and an error.

import {
  clip,
  ENV_RE,
  FILE_RE,
  fields,
  has,
  id,
  int,
  isObj,
  list,
  obj,
  oneOf,
  opt,
  RESERVED,
  SIGNAL_RE,
  str,
  turnId,
  unique,
  utf8Bytes,
} from './remote-protocol-checks.mjs';
import { ERROR_CODES, HOST_ENFORCED, REMOTE_LIMITS } from './remote-protocol-constants.mjs';
import { checkHostSettings } from './remote-settings.mjs';

export function checkArgv(v) {
  const e = list(v, 'start.argv', REMOTE_LIMITS.args, (a, i) => {
    if (typeof a !== 'string') return `start.argv[${i}] must be text.`;
    if (a.includes('\0')) return `start.argv[${i}] can’t contain a NUL character.`;
    const n = utf8Bytes(a);
    return n > REMOTE_LIMITS.argBytes ? `start.argv[${i}] is ${n} bytes; Linux limits one argument to 128 KiB.` : '';
  });
  if (e) return e;
  const total = v.reduce((n, a) => n + utf8Bytes(a) + 1, 0);
  return total > REMOTE_LIMITS.argvBytes ? `start.argv is ${total} bytes in all; the limit is ${REMOTE_LIMITS.argvBytes}.` : '';
}

export function checkEnv(v) {
  if (!isObj(v)) return 'start.env must be an object of names to values.';
  const names = Object.keys(v);
  if (names.length > REMOTE_LIMITS.envVars) return `start.env has ${names.length} variables; the limit is ${REMOTE_LIMITS.envVars}.`;
  for (const k of names) {
    if (!ENV_RE.test(k) || k.length > REMOTE_LIMITS.envNameChars)
      return `start.env’s “${clip(k)}” isn’t a variable name: capital letters, digits and _, not starting with a digit.`;
    const val = v[k];
    if (typeof val !== 'string') return `start.env.${k} must be text.`;
    if (val.includes('\0')) return `start.env.${k} can’t contain a NUL character.`;
    if (utf8Bytes(val) > REMOTE_LIMITS.envValueBytes) return `start.env.${k} is over ${REMOTE_LIMITS.envValueBytes} bytes.`;
  }
  return '';
}

/**
 * start.agentFile: a Kiro CLI custom agent file, which Kiro reads from `<its home>/agents/`, not from the turn folder.
 * Postbox sends only its name and text. The daemon picks the folder from the Kiro home the runner will use (start.env’s
 * KIRO_HOME, which must be under ~/.postbox-remote, else its own KIRO_HOME, else ~/.kiro), writes the file there 0600,
 * never over one already there, and removes it when the turn ends.
 */
export function checkAgentFile(v) {
  const e =
    fields(v, 'start.agentFile', ['name', 'text']) ||
    (typeof v.name === 'string' && FILE_RE.test(v.name) && !v.name.includes('..') && v.name.endsWith('.json')
      ? ''
      : `start.agentFile.name must be a plain file name ending in .json; got “${clip(v.name)}”.`) ||
    str(v.text, 'start.agentFile.text', Number.MAX_SAFE_INTEGER);
  if (e) return e;
  const n = utf8Bytes(v.text);
  return n > REMOTE_LIMITS.fileBytes ? `start.agentFile.text is ${n} bytes; the limit is ${REMOTE_LIMITS.fileBytes}.` : '';
}

export function checkFiles(v) {
  let total = 0;
  return (
    list(v, 'start.files', REMOTE_LIMITS.files, (f, i) => {
      const at = `start.files[${i}]`;
      const e = fields(f, at, ['name', 'text']);
      if (e) return e;
      if (typeof f.name !== 'string' || !FILE_RE.test(f.name) || f.name.includes('..'))
        return `${at}.name must be a plain file name: letters, digits, . _ and -, starting with a letter or digit, with no / or ..; got “${clip(f.name)}”.`;
      if (RESERVED.has(f.name)) return `${at}.name “${f.name}” is one of the turn folder’s own files.`;
      if (typeof f.text !== 'string') return `${at}.text must be text.`;
      const n = utf8Bytes(f.text);
      if (n > REMOTE_LIMITS.fileBytes) return `${at} (${f.name}) is ${n} bytes; the limit is ${REMOTE_LIMITS.fileBytes}.`;
      total += n;
      return total > REMOTE_LIMITS.filesBytes ? `start.files are over ${REMOTE_LIMITS.filesBytes} bytes in all.` : '';
    }) ||
    unique(
      v.map((f) => f.name),
      'start.files',
      'file',
    )
  );
}

/** `hello.settings`: only HOST_ENFORCED, each checked by remote-settings.mjs so the ranges and the path rule live in one place. */
export function checkSettings(v) {
  const e = fields(v, 'hello.settings', [], [...HOST_ENFORCED]);
  if (e) return e;
  const r = checkHostSettings(v);
  return r.ok ? '' : `hello.settings: ${r.error}`;
}

export function checkExit(v, at) {
  return (
    fields(v, at, ['code', 'signal', 'at']) ||
    (v.code === null ? '' : int(v.code, `${at}.code`, 0, 255)) ||
    (v.signal === null || (typeof v.signal === 'string' && SIGNAL_RE.test(v.signal)) ? '' : `${at}.signal must be a signal name such as SIGINT, or null.`) ||
    ((v.code === null) === (v.signal === null) ? `${at} has a code or a signal, never both or neither.` : '') ||
    int(v.at, `${at}.at`, 0, Number.MAX_SAFE_INTEGER)
  );
}

export function checkItems(v, at) {
  return (
    list(v, at, REMOTE_LIMITS.snapshotItems, (it, i) => {
      const a = `${at}[${i}]`;
      return (
        fields(it, a, ['id', 'line', 'text'], ['blockId']) ||
        id(it.id, `${a}.id`) ||
        opt(it.blockId, (b) => id(b, `${a}.blockId`)) ||
        str(it.line, `${a}.line`, REMOTE_LIMITS.snapshotLineChars) ||
        str(it.text, `${a}.text`, REMOTE_LIMITS.snapshotTextChars)
      );
    }) ||
    unique(
      v.map((it) => it.id),
      at,
      'item',
    )
  );
}

/**
 * permission_prompt’s arguments, as shared/mcp-tools.mjs’s inputSchema names them. Claude Code owns them and may add
 * one, which server/mcp.mjs’s permission() ignores, so a field not named here passes; the line limit still bounds it.
 */
export function checkRequest(v, at) {
  return (
    obj(v, at) ||
    has(v, at, ['tool_name', 'input']) ||
    str(v.tool_name, `${at}.tool_name`, 256, 1) ||
    obj(v.input, `${at}.input`) ||
    opt(v.tool_use_id, (x) => str(x, `${at}.tool_use_id`, 256)) ||
    opt(v.permission_suggestions, (x) => list(x, `${at}.permission_suggestions`, 64, (s, i) => obj(s, `${at}.permission_suggestions[${i}]`))) ||
    opt(v.agent_id, (x) => str(x, `${at}.agent_id`, 256))
  );
}

/** The decision a permission prompt tool returns: { behavior: 'allow', updatedInput } or { behavior: 'deny', message }. */
export function checkDecision(v, at) {
  if (!isObj(v)) return `${at} must be an object.`;
  if (v.behavior === 'allow')
    return (
      fields(v, at, ['behavior', 'updatedInput'], ['updatedPermissions']) ||
      obj(v.updatedInput, `${at}.updatedInput`) ||
      opt(v.updatedPermissions, (x) => list(x, `${at}.updatedPermissions`, 64, (s, i) => obj(s, `${at}.updatedPermissions[${i}]`)))
    );
  if (v.behavior === 'deny') return fields(v, at, ['behavior', 'message']) || str(v.message, `${at}.message`, REMOTE_LIMITS.messageChars, 1);
  return `${at}.behavior must be allow or deny; got “${clip(v.behavior)}”.`;
}

/**
 * { code, message, re?, turn?, id? }: re is the type of the message it answers, turn the turn it’s about, and id the
 * prompt or tool call it names, within that turn: an `re: 'prompt-expired'` error names the prompt whose end the daemon
 * couldn’t record, so Postbox ends exactly that card.
 */
export function checkError(m) {
  return (
    fields(m, 'error', ['code', 'message'], ['re', 'turn', 'id']) ||
    oneOf(m.code, 'error.code', ERROR_CODES) ||
    str(m.message, 'error.message', REMOTE_LIMITS.messageChars, 1) ||
    opt(m.re, (v) => (typeof v === 'string' && /^[a-z][a-z-]{0,31}$/.test(v) ? '' : 'error.re must be the type of the message it answers.')) ||
    opt(m.turn, (v) => turnId(v, 'error.turn')) ||
    opt(m.id, (v) => id(v, 'error.id')) ||
    (m.id !== undefined && m.turn === undefined ? 'error.id names a prompt or a tool call within a turn, so it comes with error.turn.' : '')
  );
}
