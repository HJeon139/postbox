// The messages Postbox and its daemon send each other over the SSH channel’s stdio (shared/remote-protocol.mjs). Each
// maps a message type to its validator, which returns an error to show or ''. Field types are in each validator.

import {
  bool,
  clip,
  fields,
  hostPath,
  id,
  int,
  LOGS,
  lineSpan,
  list,
  obj,
  oneOf,
  opt,
  str,
  streamLine,
  TURN_STATES,
  token,
  turnId,
  unique,
} from './remote-protocol-checks.mjs';
import { HARNESSES, MESSAGE_FILE, REMOTE_LIMITS, STDIN_KINDS, TOOL_ROUTES } from './remote-protocol-constants.mjs';
import {
  checkAgentFile,
  checkArgv,
  checkDecision,
  checkEnv,
  checkError,
  checkExit,
  checkFiles,
  checkItems,
  checkRequest,
  checkSettings,
} from './remote-protocol-parts.mjs';

export const POSTBOX_CHANNELS = {
  /** Postbox → daemon, over the SSH channel’s stdin. */
  'postbox-to-daemon': {
    /** { version, token, takeover?, settings? } */
    hello: (m) =>
      fields(m, 'hello', ['version', 'token'], ['takeover', 'settings']) ||
      int(m.version, 'hello.version', 1, 1_000_000) ||
      token(m.token, 'hello.token') ||
      opt(m.takeover, (v) => bool(v, 'hello.takeover')) ||
      opt(m.settings, (v) => checkSettings(v)),
    /** { turn, harness, folder, argv, env, stdin, files, agentFile? } */
    start: (m) =>
      fields(m, 'start', ['turn', 'harness', 'folder', 'argv', 'env', 'stdin', 'files'], ['agentFile']) ||
      turnId(m.turn, 'start.turn') ||
      oneOf(m.harness, 'start.harness', HARNESSES) ||
      hostPath(m.folder, 'start.folder') ||
      checkArgv(m.argv) ||
      checkEnv(m.env) ||
      oneOf(m.stdin, 'start.stdin', STDIN_KINDS) ||
      checkFiles(m.files) ||
      (m.stdin === 'file' && !m.files.some((f) => f.name === MESSAGE_FILE)
        ? `A turn that reads its stdin from a file must send ${MESSAGE_FILE} in start.files.`
        : '') ||
      opt(m.agentFile, (v) => (m.harness === 'kiro-cli' ? checkAgentFile(v) : `start.agentFile is only for kiro-cli; this start is for ${m.harness}.`)),
    /** { turn, home, threads: [{ id, items: SnapshotItem[] }] }: the whole snapshot, replacing any before. */
    snapshot: (m) =>
      fields(m, 'snapshot', ['turn', 'home', 'threads']) ||
      turnId(m.turn, 'snapshot.turn') ||
      id(m.home, 'snapshot.home') ||
      list(m.threads, 'snapshot.threads', REMOTE_LIMITS.snapshotThreads, (t, i) => {
        const at = `snapshot.threads[${i}]`;
        return fields(t, at, ['id', 'items']) || id(t.id, `${at}.id`) || checkItems(t.items, `${at}.items`);
      }) ||
      unique(
        m.threads.map((t) => t.id),
        'snapshot.threads',
        'thread',
      ) ||
      (m.threads.some((t) => t.id === m.home) ? '' : `snapshot.home “${clip(m.home)}” must be one of snapshot.threads.`),
    /** { turn, thread, items }: items added or changed in one thread of the snapshot; an existing ID is replaced in place. */
    'snapshot-items': (m) =>
      fields(m, 'snapshot-items', ['turn', 'thread', 'items']) ||
      turnId(m.turn, 'snapshot-items.turn') ||
      id(m.thread, 'snapshot-items.thread') ||
      checkItems(m.items, 'snapshot-items.items'),
    /** { turn, from, log? }: lines from that byte offset, then new ones as they come. */
    read: (m) =>
      fields(m, 'read', ['turn', 'from'], ['log']) ||
      turnId(m.turn, 'read.turn') ||
      int(m.from, 'read.from', 0, Number.MAX_SAFE_INTEGER) ||
      opt(m.log, (v) => oneOf(v, 'read.log', LOGS)),
    /** { turn, line }: a line for a held stdin, without its \n. */
    write: (m) => fields(m, 'write', ['turn', 'line']) || turnId(m.turn, 'write.turn') || streamLine(m.line, 'write.line'),
    /** { turn, prompt, result }: the person’s answer to a waiting permission prompt, the `prompt` with that turn and ID. */
    answer: (m) =>
      fields(m, 'answer', ['turn', 'prompt', 'result']) ||
      turnId(m.turn, 'answer.turn') ||
      id(m.prompt, 'answer.prompt') ||
      checkDecision(m.result, 'answer.result'),
    /** { turn, id, ok, text }: Postbox’s answer to the `tool` with that turn and ID. */
    reply: (m) =>
      fields(m, 'reply', ['turn', 'id', 'ok', 'text']) ||
      turnId(m.turn, 'reply.turn') ||
      id(m.id, 'reply.id') ||
      bool(m.ok, 'reply.ok') ||
      str(m.text, 'reply.text', REMOTE_LIMITS.replyChars),
    /** { turn } */
    stop: (m) => fields(m, 'stop', ['turn']) || turnId(m.turn, 'stop.turn'),
    /** { turn, upTo }: Postbox has applied out.jsonl up to this offset. */
    ack: (m) => fields(m, 'ack', ['turn', 'upTo']) || turnId(m.turn, 'ack.turn') || int(m.upTo, 'ack.upTo', 0, Number.MAX_SAFE_INTEGER),
    /** {}: stop everything and delete ~/.postbox-remote. */
    remove: (m) => fields(m, 'remove', []),
    /** {}: run the host’s signInCheck (hello.settings’), answered by `checked`. */
    check: (m) => fields(m, 'check', []),
  },

  /** daemon → Postbox, over the SSH channel’s stdout. */
  'daemon-to-postbox': {
    /** The reply to a good hello. */
    welcome: (m) =>
      fields(m, 'welcome', ['version', 'home', 'node', 'harnesses', 'problems', 'turns']) ||
      int(m.version, 'welcome.version', 1, 1_000_000) ||
      hostPath(m.home, 'welcome.home') ||
      fields(m.node, 'welcome.node', ['path', 'version']) ||
      hostPath(m.node.path, 'welcome.node.path') ||
      str(m.node.version, 'welcome.node.version', 64) ||
      list(m.harnesses, 'welcome.harnesses', HARNESSES.length, (h, i) => {
        const at = `welcome.harnesses[${i}]`;
        return (
          fields(h, at, ['name', 'path', 'version', 'looked']) ||
          oneOf(h.name, `${at}.name`, HARNESSES) ||
          (h.path === null ? '' : hostPath(h.path, `${at}.path`)) ||
          (h.version === null ? '' : str(h.version, `${at}.version`, 200)) ||
          list(h.looked, `${at}.looked`, REMOTE_LIMITS.looked, (p, j) => hostPath(p, `${at}.looked[${j}]`))
        );
      }) ||
      unique(
        m.harnesses.map((h) => h.name),
        'welcome.harnesses',
        'harness',
      ) ||
      list(m.problems, 'welcome.problems', REMOTE_LIMITS.problems, (p, i) => {
        const at = `welcome.problems[${i}]`;
        return fields(p, at, ['code', 'message']) || id(p.code, `${at}.code`) || str(p.message, `${at}.message`, REMOTE_LIMITS.messageChars, 1);
      }) ||
      list(m.turns, 'welcome.turns', REMOTE_LIMITS.turns, (t, i) => {
        const at = `welcome.turns[${i}]`;
        return (
          fields(t, at, ['turn', 'harness', 'state', 'size', 'exit']) ||
          turnId(t.turn, `${at}.turn`) ||
          oneOf(t.harness, `${at}.harness`, HARNESSES) ||
          oneOf(t.state, `${at}.state`, TURN_STATES) ||
          int(t.size, `${at}.size`, 0, Number.MAX_SAFE_INTEGER) ||
          (t.state === 'ended' ? checkExit(t.exit, `${at}.exit`) : t.exit === null ? '' : `${at}.exit must be null unless the turn has ended.`)
        );
      }),
    /** { turn }: the runner is up and runner.json is written. */
    started: (m) => fields(m, 'started', ['turn']) || turnId(m.turn, 'started.turn'),
    /** { turn, log?, offset, next, text, cut? } */
    line: (m) =>
      fields(m, 'line', ['turn', 'offset', 'next', 'text'], ['log', 'cut']) ||
      turnId(m.turn, 'line.turn') ||
      opt(m.log, (v) => oneOf(v, 'line.log', LOGS)) ||
      int(m.offset, 'line.offset', 0, Number.MAX_SAFE_INTEGER) ||
      int(m.next, 'line.next', 0, Number.MAX_SAFE_INTEGER) ||
      opt(m.cut, (v) => (v === true ? '' : 'line.cut is only ever true.')) ||
      (m.cut ? (m.text === '' ? '' : 'A cut line’s text must be empty.') : streamLine(m.text, 'line.text')) ||
      (m.cut ? (m.next > m.offset ? '' : 'A cut line must move the offset on.') : lineSpan(m.offset, m.next, m.text)),
    /** { turn, upTo }: a `write` reached the held stdin; upTo is in.jsonl’s size after it. */
    written: (m) => fields(m, 'written', ['turn', 'upTo']) || turnId(m.turn, 'written.turn') || int(m.upTo, 'written.upTo', 1, Number.MAX_SAFE_INTEGER),
    /** { turn, log, size }: a `read` has sent every line of that log up to `size`, its size when the first pass got there. */
    'caught-up': (m) =>
      fields(m, 'caught-up', ['turn', 'log', 'size']) ||
      turnId(m.turn, 'caught-up.turn') ||
      oneOf(m.log, 'caught-up.log', LOGS) ||
      int(m.size, 'caught-up.size', 0, Number.MAX_SAFE_INTEGER),
    /** { turn, exit, size }: after the turn’s last line; exit is null for an interrupted turn. */
    ended: (m) =>
      fields(m, 'ended', ['turn', 'exit', 'size']) ||
      turnId(m.turn, 'ended.turn') ||
      (m.exit === null ? '' : checkExit(m.exit, 'ended.exit')) ||
      int(m.size, 'ended.size', 0, Number.MAX_SAFE_INTEGER),
    /** { turn, id, name, args }: a shim tool call for Postbox; id is the shim’s, unique only within the turn. */
    tool: (m) =>
      fields(m, 'tool', ['turn', 'id', 'name', 'args']) ||
      turnId(m.turn, 'tool.turn') ||
      id(m.id, 'tool.id') ||
      (Object.hasOwn(TOOL_ROUTES, m.name) && TOOL_ROUTES[m.name] !== 'host' ? '' : `tool.name “${clip(m.name)}” isn’t a tool Postbox answers.`) ||
      obj(m.args, 'tool.args'),
    /** { id, turn, request }: a permission prompt waiting in the shim; id is the shim’s, unique only within the turn. */
    prompt: (m) =>
      fields(m, 'prompt', ['id', 'turn', 'request']) || id(m.id, 'prompt.id') || turnId(m.turn, 'prompt.turn') || checkRequest(m.request, 'prompt.request'),
    /** { id, turn, at, reason? }: nobody can answer it any more: the host denied it at permissionWaitMax (`expired`,
     * the default), or the harness canceled the call (`canceled`). */
    'prompt-expired': (m) =>
      fields(m, 'prompt-expired', ['id', 'turn', 'at'], ['reason']) ||
      id(m.id, 'prompt-expired.id') ||
      turnId(m.turn, 'prompt-expired.turn') ||
      int(m.at, 'prompt-expired.at', 0, Number.MAX_SAFE_INTEGER) ||
      opt(m.reason, (v) => oneOf(v, 'prompt-expired.reason', ['expired', 'canceled'])),
    /** {}: everything is stopped and deleted; the daemon exits next. */
    removed: (m) => fields(m, 'removed', []),
    /** { ok, code, at }: how the signInCheck a `check` ran exited; ok exactly when code is 0, at when it ended. */
    checked: (m) =>
      fields(m, 'checked', ['ok', 'code', 'at']) ||
      bool(m.ok, 'checked.ok') ||
      (m.code === null ? '' : int(m.code, 'checked.code', 0, 255)) ||
      int(m.at, 'checked.at', 0, Number.MAX_SAFE_INTEGER) ||
      (m.ok === (m.code === 0) ? '' : 'checked.ok is true exactly when checked.code is 0.'),
    error: (m) => checkError(m),
  },
};
