// The work ledger (#132): what each turn of a conversation’s agents changed, ran and published, and what it cost,
// so the person can see the state of the work without asking an agent to recount it.
//
// It is built from the turn’s tool calls (the stream mapper hands them over: ctx.toolUse, ctx.toolResult,
// ctx.taskEnded and ctx.usage), never from the agent’s words:
// - Files: an Edit, Write or NotebookEdit call names a file. Its contents before the turn are read as the call
//   starts, and replaced by the tool’s own record of them (tool_use_result.originalFile) when it has one; its
//   contents after are read when the turn ends. Both go to the blob store, so a change can be reviewed and
//   restored, and lines are counted from that diff, not from the edits. A command that changes files isn’t seen.
// - Commands: each Bash call exactly as it ran, with its exit, duration and all the output it returned. One run
//   in the background ends with a task notification, which gives its exit and its output file.
// - Version control: commits and pushes Claude Code reports on the command’s result (gitOperation), with the
//   commit’s files and lines from git itself; branches from the command line. Commits and branches it doesn’t
//   report, such as a commit inside `… && git commit`, from git before and after the command (#156).
// - Outside Postbox: gh commands and MCP tools that write (create_pull_request, add_issue_comment…), with links.
// - Effort: each turn’s wall time, tool calls, tokens and spend (the result’s total_cost_usd).
// Whether a file is uncommitted, committed or pushed is asked of git when the Work view opens: read-only commands,
// without git’s optional locks, so an agent’s own git never waits on Postbox.
//
// A turn on a remote host (#120; architecture.md, “Remote hosts”) is recorded from its stream only. Its files are on
// the host, and a path there may name a different file here, or one of the person’s own: so the ledger never reads,
// diffs or restores a file for it, and never runs git or reads a command’s output file for it either. An edit is
// kept as a step (kind 'edit': the file, the host, how many edits) with no copy and no lines; commands, branches,
// commits and pushes are kept as the stream reports them, with their host; effort is kept as for any turn.

import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  COMMAND_TOOLS,
  commandFacts,
  diffCount,
  EDIT_TOOLS,
  exitCodeOf,
  externalTool,
  isBinary,
  MAX_OUTPUT_BYTES,
  READ_TOOLS,
  urlsIn,
} from '../shared/work.mjs';
import { describeTool } from './adapters/claude-stream.mjs';
import { fileDiff, output, restore } from './ledger-answers.mjs';
import { commandSeen, commandStarted, folderWatch, turnEnded } from './ledger-commands.mjs';
import { clip, gitState, pushed, recordCommit, rootOf, runGit, tracked } from './ledger-git.mjs';
import { known, memoryBlobs, nodeIo, sameSnap } from './ledger-io.mjs';
import { hostEdit, hostFolder, hostOf } from './ledger-remote.mjs';
import { newId } from './store.mjs';

export { nodeIo };

export class Ledger {
  /**
   * @param {{ store: import('./store.mjs').Store, blobs?: { put(b: Buffer): Promise<{ sha256: string, size: number }>, get(sha: string): Promise<Buffer> } | null,
   *           io?: typeof nodeIo, git?: typeof runGit, home?: string, now?: () => number }} deps
   */
  constructor({ store, blobs = null, io = nodeIo, git = runGit, home = homedir(), now = Date.now }) {
    this.store = store;
    this.blobs = blobs ?? memoryBlobs();
    this.io = io;
    this.git = git;
    this.home = home;
    this.now = now;
    this.roots = new Map(); // folder → its repository’s top folder, or null
    this.pushedCache = new Set(); // root:sha known to be on a remote
    this.pending = new Set(); // work that hasn’t finished writing, so tests can wait for it
    this.folders = folderWatch(); // git folders, to see what a command did there (#156)
  }

  get s() {
    return this.store.state;
  }

  /** The conversation a thread’s work belongs to: side and topic threads count toward theirs. */
  convOf(threadId) {
    const t = this.s.threads[threadId];
    return t?.parentId && this.s.threads[t.parentId] ? t.parentId : threadId;
  }
  entries(convId) {
    return this.store.pending.work(convId); // as the ledger writes them: it reads back its own entries to patch them (#601)
  }
  entry(convId, id) {
    return this.entries(convId).find((e) => e.id === id) ?? null;
  }
  add(convId, entry) {
    this.store.emit('work.add', { convId, entry });
    return entry;
  }
  patch(convId, id, patch) {
    this.store.emit('work.patch', { convId, id, patch });
  }
  /** Keeps a promise until it settles, so idle() can wait for it. */
  track(p) {
    const q = Promise.resolve(p).catch((e) => console.error(`The work ledger couldn’t record something: ${e.message}`));
    this.pending.add(q);
    q.finally(() => this.pending.delete(q));
    return q;
  }
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  // ── A turn ────────────────────────────────────────────────────────────────────────────

  /**
   * A turn starts. folder is where the agent works (a promise is fine: adapters find it asynchronously),
   * projectFolder the project’s root: a change outside both is flagged. A turn on a host (hostOf) records only what
   * its stream says, against the host’s folder for it.
   * @param {any} turn @param {{ se: any, folder?: string|null|Promise<string|null>, projectFolder?: string|null }} where
   */
  startTurn(turn, { se, folder = null, projectFolder = null }) {
    const convId = this.convOf(turn.threadId);
    const host = this.hostOf(turn, se);
    /** @type {any} */
    const w = {
      convId,
      se: { id: se.id, handle: se.handle },
      host,
      folder: null,
      projectFolder: host ? null : projectFolder,
      files: new Map(), // path → { path, tools, who, before: Promise<snap>, firstTool }
      edits: new Map(), // on a host: path → its edit entry’s id
      calls: new Map(), // tool_use id → { name, input, who, at, path? }
      commands: new Map(), // tool_use id → command entry id
      results: new Map(), // tool_use id → its command’s result, while it’s being recorded
      externals: new Map(), // tool_use id → external entry id
      denied: new Set(),
      usage: new Map(), // process key → { costUsd, tokens }
      toolCalls: 0,
      pending: [],
      ended: false,
    };
    turn.work = w;
    // A host’s folder is known once the turn has its host turn (se.remoteTurn.folder), before its first tool call.
    if (!host)
      w.pending.push(
        Promise.resolve(folder).then(
          (f) => {
            w.folder = f ?? null;
          },
          () => {},
        ),
      );
    this.add(convId, {
      kind: 'turn',
      id: turn.id,
      turnId: turn.id,
      threadId: turn.threadId,
      sessionId: se.id,
      handle: se.handle,
      startedAt: turn.startedAt ?? this.now(),
      status: 'running',
      toolCalls: 0,
      ...(host ? { host } : {}),
    });
  }

  /** The host a turn runs on (server/ledger-remote.mjs). */
  hostOf(turn, se) {
    return hostOf(this, turn, se);
  }

  base(turn, extra = {}) {
    const w = turn.work;
    return { turnId: turn.id, threadId: turn.threadId, sessionId: w.se.id, handle: w.se.handle, at: this.now(), ...(w.host ? { host: w.host } : {}), ...extra };
  }
  abs(w, p) {
    return isAbsolute(p) ? resolve(p) : resolve(w.folder ?? w.projectFolder ?? '/', p);
  }

  /**
   * A tool call with its whole input, before it runs.
   * @param {any} turn @param {{ id: string, name: string, input?: any, who?: string|null }} call
   */
  toolUse(turn, { id, name, input = {}, who = null }) {
    const w = turn.work;
    if (!w || w.ended || !id || w.calls.has(id)) return;
    w.toolCalls += 1;
    if (w.host) hostFolder(this, turn);
    /** @type {{ name: string, input: any, who: string|null, at: number, path: string|null }} */
    const call = { name, input, who, at: this.now(), path: null };
    w.calls.set(id, call);
    const field = EDIT_TOOLS[name];
    if (field && typeof input?.[field] === 'string' && input[field].trim()) {
      const path = this.abs(w, input[field]);
      call.path = path;
      // On a host, the file isn’t here to read: its edit is recorded when the tool says it worked (toolResult).
      if (w.host) return;
      let f = w.files.get(path);
      if (!f) {
        // Read now, before the tool writes: the tool runs in another process, so this is the moment to catch it.
        f = { path, tools: 0, who, firstTool: id, before: this.capture(this.io.readNow(path)) };
        w.files.set(path, f);
      }
      f.tools += 1;
      return;
    }
    if (READ_TOOLS[name]) return this.recordRead(turn, { id, name, input, who });
    if (COMMAND_TOOLS.has(name) && typeof input?.command === 'string') {
      const e = this.add(
        w.convId,
        this.base(turn, {
          kind: 'command',
          id: newId('wc'),
          toolUseId: id,
          who,
          command: clip(input.command, 20000),
          description: input.description ? clip(input.description, 300) : '',
          background: input.run_in_background === true,
          startedAt: this.now(),
          state: 'running',
        }),
      );
      w.commands.set(id, e.id);
      // Its git folder is read before and after, here; a host’s is on the host (#120).
      if (!w.host) commandStarted(this, turn, e.id);
      return;
    }
    const ext = externalTool(name);
    if (ext) {
      const e = this.add(
        w.convId,
        this.base(turn, {
          kind: 'external',
          id: newId('wx'),
          toolUseId: id,
          who,
          via: 'mcp',
          server: ext.server,
          tool: ext.tool,
          what: clip(describeTool(name, input), 200),
          input: clip(JSON.stringify(input ?? {}, null, 2), 4000),
          state: 'running',
          urls: [],
        }),
      );
      w.externals.set(id, e.id);
    }
  }

  /** A file read or searched, or a page fetched or searched for (#195): its path, pattern, URL or query. */
  recordRead(turn, { id, name, input, who }) {
    const w = turn.work;
    const what = input?.[READ_TOOLS[name]];
    if (typeof what !== 'string' || !what.trim()) return;
    const path = name === 'Read' ? this.abs(w, what) : null;
    const where = typeof input.path === 'string' && input.path ? this.display(this.abs(w, input.path), w) : null;
    this.add(
      w.convId,
      this.base(turn, { kind: 'read', id: newId('wg'), toolUseId: id, who, tool: name, what: clip(path ? this.display(path, w) : what, 500), where }),
    );
  }

  /**
   * What the turn showed in the conversation (#195): each app it showed or updated, at its version, and each block it
   * showed or asked again with. A block that came out invalid showed only its fallback, so it isn’t listed.
   */
  recordPublishes(turn) {
    const w = turn.work;
    const threads = [...new Set([turn.threadId, w.convId])];
    for (const threadId of threads)
      for (const it of this.store.pending.items(threadId)) {
        if (it.kind !== 'block' || it.turnId !== turn.id || !it.valid) continue;
        const b = it.block;
        const app = b.type === 'app' ? this.store.pending.app(b.id) : null;
        const title = app?.title ?? b.title ?? b.statement ?? b.prompt ?? b.fallback ?? b.id;
        this.add(
          w.convId,
          this.base(turn, {
            kind: 'publish',
            id: newId('wu'),
            threadId,
            itemId: it.id,
            what: app ? 'app' : 'block',
            type: b.type,
            blockId: b.id,
            title: clip(String(title).replace(/\s+/g, ' '), 200),
            version: app ? app.current : null,
          }),
        );
      }
  }

  /** The backend refused a call without running it. */
  denied(turn, toolUseId) {
    const w = turn.work;
    if (!w) return;
    w.denied.add(toolUseId);
    const cmd = w.commands.get(toolUseId);
    if (cmd) this.patch(w.convId, cmd, { state: 'denied' });
    const ext = w.externals.get(toolUseId);
    if (ext) this.patch(w.convId, ext, { state: 'denied' });
  }

  /**
   * What a tool call returned.
   * @param {any} turn @param {{ id: string, isError?: boolean, text?: string, result?: any, vcsCwd?: string|null }} res
   */
  toolResult(turn, { id, isError = false, text = '', result = null, vcsCwd = null }) {
    const w = turn.work;
    const call = w?.calls.get(id);
    if (!w || !call) return;
    /** @type {any} */
    const r = result && typeof result === 'object' ? result : null;
    if (call.path && w.host) {
      if (!isError && !w.denied.has(id)) hostEdit(this, turn, call);
      return;
    }
    if (call.path) {
      const f = w.files.get(call.path);
      // The tool’s own record of the file before it changed it, which beats the read Postbox raced it for.
      if (f && f.firstTool === id && r && Object.hasOwn(r, 'originalFile')) {
        if (typeof r.originalFile === 'string')
          f.before = this.capture({ exists: true, size: Buffer.byteLength(r.originalFile), bytes: Buffer.from(r.originalFile) });
        else if (r.originalFile === null && r.type === 'create') f.before = Promise.resolve({ exists: false });
      }
      return;
    }
    const cmdId = w.commands.get(id);
    if (cmdId) {
      const done = this.track(this.commandEnded(turn, cmdId, { isError, text, r, vcsCwd }).then(() => commandSeen(this, turn, cmdId)));
      w.results.set(id, done);
      w.pending.push(done);
      return;
    }
    const extId = w.externals.get(id);
    if (extId)
      this.patch(w.convId, extId, {
        state: w.denied.has(id) ? 'denied' : isError ? 'failed' : 'done',
        urls: urlsIn(text),
        result: clip(text, 2000),
        endedAt: this.now(),
      });
  }

  async commandEnded(turn, cmdId, { isError, text, r, vcsCwd }) {
    const w = turn.work;
    const e = this.entry(w.convId, cmdId);
    if (!e) return;
    // The output: stdout and stderr as the tool kept them, else the result’s text without its “Exit code” line.
    const streams = r && (typeof r.stdout === 'string' || typeof r.stderr === 'string');
    const out = streams
      ? [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x).join('\n')
      : String(text ?? '').replace(/^(?:Error: )?Exit code \d+\n?/, '');
    const exit = isError ? (exitCodeOf(text) ?? (typeof r === 'string' ? exitCodeOf(r) : null)) : 0;
    // Refused by the backend, or by the person on a permission card (the runtime’s answer starts this way).
    const state =
      w.denied.has(e.toolUseId) || (isError && /^The person didn’t allow/.test(text))
        ? 'denied'
        : r?.interrupted === true
          ? 'stopped'
          : typeof r?.backgroundTaskId === 'string'
            ? 'background'
            : isError
              ? 'failed'
              : 'done';
    const output = await this.keepOutput(Buffer.from(out));
    this.patch(w.convId, cmdId, {
      state,
      exit: state === 'background' ? null : exit,
      ms: this.now() - e.startedAt,
      output,
      ...(state === 'background' ? { taskId: r.backgroundTaskId } : {}),
    });
    if (state !== 'done' && state !== 'background') return;
    // What it did to version control and to services outside Postbox.
    const facts = commandFacts(e.command, out);
    const op = r?.gitOperation && typeof r.gitOperation === 'object' ? r.gitOperation : null;
    const cwd = vcsCwd ?? w.folder ?? w.projectFolder;
    for (const name of facts.branches) {
      if (this.entries(w.convId).some((x) => x.kind === 'branch' && x.name === name && x.cwd === cwd)) continue;
      this.add(w.convId, this.base(turn, { kind: 'branch', id: newId('wb'), commandId: cmdId, name: clip(name, 200), cwd }));
    }
    const commit = op?.commit && typeof op.commit.sha === 'string' ? { sha: op.commit.sha, branch: String(op.commit.branch ?? '') } : facts.commit;
    if (commit) await this.recordCommit(turn, cmdId, commit, cwd, facts.commit?.message ?? '');
    if (op?.push || facts.push)
      this.add(
        w.convId,
        this.base(turn, {
          kind: 'push',
          id: newId('wp'),
          commandId: cmdId,
          branch: clip(op?.push?.branch ?? commit?.branch ?? '', 200),
          remote: facts.push?.remote ? clip(facts.push.remote, 300) : null,
          refs: (facts.push?.refs ?? []).slice(0, 20),
          cwd,
        }),
      );
    for (const x of facts.external)
      this.add(
        w.convId,
        this.base(turn, {
          kind: 'external',
          id: newId('wx'),
          commandId: cmdId,
          via: x.kind,
          what: x.what,
          command: clip(e.command, 2000),
          urls: x.urls,
          state: 'done',
        }),
      );
  }

  recordCommit(...a) {
    return recordCommit(this, ...a);
  }

  /** A background command or subagent ended. */
  taskEnded(turn, { toolUseId, status = '', summary = '', outputFile = null }) {
    const w = turn.work;
    const cmdId = w?.commands.get(toolUseId);
    if (!cmdId) return;
    w.pending.push(
      this.track(
        (async () => {
          // Its result first: a replayed stream (a remote turn attached again) hands both over at once.
          await w.results.get(toolUseId);
          const e = this.entry(w.convId, cmdId);
          if (!e) return;
          const exit = /exit code (\d+)/i.exec(summary);
          const code = exit ? Number(exit[1]) : null;
          const state = /kill|stop/i.test(status) ? 'stopped' : status === 'completed' && (code ?? 0) === 0 ? 'done' : 'failed';
          let output = e.output ?? null;
          // A host’s output file is on the host; the path names nothing here.
          if (outputFile && isAbsolute(outputFile) && !w.host) {
            const tail = await this.io.readTail(outputFile, MAX_OUTPUT_BYTES).catch(() => null);
            if (tail) output = { ...(await this.keepOutput(tail.bytes)), cut: tail.cut };
          }
          this.patch(w.convId, cmdId, { state, exit: code, ms: this.now() - e.startedAt, output, endedInBackground: true });
          await commandSeen(this, turn, cmdId);
        })(),
      ),
    );
  }

  /**
   * What became of a background command after its turn, as the runtime saw it (#164): Stop kept it running (kept), or
   * it ended (state: 'done' | 'failed' | 'stopped', by: 'you' when the person stopped it). The turn’s end alone can’t
   * tell a job you stopped with its agent from one still running. An end the CLI reported (taskEnded) knows the exit,
   * so it isn’t overwritten; one Postbox saw only as its process going (a kept job’s) doesn’t.
   * @param {{ threadId: string, toolUseId: string, startedAt?: number }} job
   * @param {{ kept?: boolean, state?: string|null, by?: string|null }} what
   */
  jobUpdate(job, { kept = false, state = null, by = null }) {
    const convId = this.convOf(job.threadId);
    const e = this.entries(convId).find((x) => x.kind === 'command' && x.toolUseId === job.toolUseId);
    if (!e) return;
    if (kept) this.patch(convId, e.id, { keptRunning: true, ...(e.state === 'unknown' ? { state: 'background' } : {}) });
    else if (state && ['running', 'background', 'unknown'].includes(e.state)) {
      this.folders.live.delete(e.id); // it ended: a commit made after it isn’t its (#156)
      this.patch(convId, e.id, {
        state: state === 'stopped' || state === 'failed' ? state : 'unknown',
        ms: this.now() - (e.startedAt ?? this.now()),
        leftRunning: false,
        ...(by === 'you' ? { stoppedBy: 'you' } : {}),
      });
    }
  }

  /** What the backend reports the turn’s process has spent so far (its totals run for the process). */
  usage(turn, { key = 'run', costUsd = null, tokens = null }) {
    turn.work?.usage.set(key, { costUsd, tokens });
  }

  /**
   * The turn ended: read what each file it changed looks like now, and record the turn’s effort.
   * @returns {Promise<string|null>} the turn’s line for the transcript, from shared/work.mjs turnLine
   */
  async endTurn(turn, { status = 'done' } = {}) {
    const w = turn.work;
    if (!w || w.ended) return null;
    w.ended = true;
    const run = (async () => {
      await Promise.allSettled(w.pending);
      turnEnded(this, w);
      this.recordPublishes(turn);
      // A host turn has no files to read (they’re on the host), so this is a no-op for it; the guard says so.
      for (const f of w.host ? [] : w.files.values()) {
        const before = await f.before;
        const after = await this.capture(await this.io.read(f.path));
        await this.recordChange(turn, f, before, after);
      }
      const usage = [...w.usage.values()];
      const priced = usage.filter((u) => typeof u.costUsd === 'number');
      const tokened = usage.filter((u) => u.tokens);
      const sum = (k) => tokened.reduce((n, u) => n + (Number(u.tokens[k]) || 0), 0);
      const t = this.entry(w.convId, turn.id);
      const endedAt = this.now();
      this.patch(w.convId, turn.id, {
        status,
        endedAt,
        ms: endedAt - (t?.startedAt ?? endedAt),
        toolCalls: w.toolCalls,
        costUsd: priced.length ? priced.reduce((n, u) => n + u.costUsd, 0) : null,
        tokens: tokened.length ? { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') } : null,
      });
      // A command with no result when its turn ended: stopped with it, or still running in the background,
      // where Postbox can’t see it end (#129) unless the runtime does (jobUpdate). One you kept running still is.
      for (const id of w.commands.values()) {
        const e = this.entry(w.convId, id);
        if (e?.state === 'running') this.patch(w.convId, id, { state: status === 'stopped' ? 'stopped' : 'unknown', ms: endedAt - e.startedAt });
        else if (e?.state === 'background') this.patch(w.convId, id, { ...(e.keptRunning ? {} : { state: 'unknown' }), leftRunning: true });
      }
      for (const id of w.externals.values()) {
        const e = this.entry(w.convId, id);
        if (e?.state === 'running') this.patch(w.convId, id, { state: 'unknown' });
      }
    })();
    await this.track(run);
    return null;
  }

  /** Stores a read in the blob store and describes it: { exists, size, sha256, binary } (or big, unreadable). */
  async capture(read) {
    const r = await read;
    if (!r?.exists) return { exists: false };
    if (!r.bytes)
      return { exists: true, size: r.size ?? null, ...(r.big ? { big: true } : {}), ...(r.unreadable ? { unreadable: clip(r.unreadable, 200) } : {}) };
    const { sha256 } = await this.blobs.put(r.bytes);
    return { exists: true, size: r.bytes.length, sha256, binary: isBinary(r.bytes) };
  }

  async keepOutput(bytes) {
    const cut = bytes.length > MAX_OUTPUT_BYTES;
    const kept = cut ? bytes.subarray(bytes.length - MAX_OUTPUT_BYTES) : bytes;
    if (!kept.length) return { size: 0 };
    const { sha256 } = await this.blobs.put(kept);
    return { sha256, size: kept.length, ...(cut ? { cut: true } : {}) };
  }

  async textOf(snap) {
    if (!snap?.exists) return '';
    return (await this.blobs.get(snap.sha256)).toString('utf8');
  }
  /**
   * Lines added and deleted between two snapshots; null when Postbox has no copy of either.
   * @returns {Promise<{ added: number, deleted: number, binary?: boolean } | null>}
   */
  async countBetween(a, b) {
    if (!known(a) || !known(b)) return null;
    if (a.binary || b.binary) return { added: 0, deleted: 0, binary: true };
    return diffCount(await this.textOf(a), await this.textOf(b));
  }

  /** Where a path is shown from: the project, the agent’s folder, the home folder, or as it is. */
  display(path, w) {
    for (const root of [w.projectFolder, w.folder]) if (root && (path === root || path.startsWith(root + sep))) return relative(root, path) || basename(path);
    // The home folder here isn’t the host’s.
    if (this.home && !w.host && path.startsWith(this.home + sep)) return `~/${relative(this.home, path)}`;
    return path;
  }
  inside(path, w) {
    return [w.projectFolder, w.folder].some((root) => root && (path === root || path.startsWith(root + sep)));
  }

  async recordChange(turn, f, before, after) {
    const w = turn.work;
    if (sameSnap(before, after) && known(before)) return; // touched, but left as it was
    const counts = await this.countBetween(before, after);
    const handle = w.se.handle;
    let file = this.entries(w.convId).find((e) => e.kind === 'file' && e.path === f.path);
    if (!file) {
      file = this.add(w.convId, {
        kind: 'file',
        id: newId('wf'),
        path: f.path,
        rel: clip(this.display(f.path, w), 500),
        outside: !this.inside(f.path, w),
        existed: Boolean(before.exists),
        tracked: before.exists ? await this.tracked(f.path) : null,
        before,
        after,
        added: counts?.added ?? 0,
        deleted: counts?.deleted ?? 0,
        binary: Boolean(counts?.binary),
        uncounted: !counts,
        written: counts?.added ?? 0,
        writtenDel: counts?.deleted ?? 0,
        handles: [handle],
        lastHandle: handle,
        turns: [turn.id],
        firstAt: this.now(),
        lastAt: this.now(),
        restored: null,
      });
    } else {
      // What the agents left, against what was there before their first change.
      const net = await this.countBetween(file.before, after);
      this.patch(w.convId, file.id, {
        after,
        added: net?.added ?? 0,
        deleted: net?.deleted ?? 0,
        binary: Boolean(net?.binary),
        uncounted: !net,
        written: (file.written ?? 0) + (counts?.added ?? 0),
        writtenDel: (file.writtenDel ?? 0) + (counts?.deleted ?? 0),
        handles: [...new Set([...file.handles, handle])],
        lastHandle: handle,
        turns: [...file.turns, turn.id].slice(-200),
        lastAt: this.now(),
        restored: null,
      });
    }
    this.add(w.convId, {
      ...this.base(turn),
      kind: 'change',
      id: newId('wd'),
      fileId: file.id,
      who: f.who ?? null,
      tools: f.tools,
      before,
      after,
      added: counts?.added ?? 0,
      deleted: counts?.deleted ?? 0,
      binary: Boolean(counts?.binary),
      uncounted: !counts,
    });
  }

  // ── Git, read only ────────────────────────────────────────────────────────────────────

  rootOf(...a) {
    return rootOf(this, ...a);
  }
  tracked(...a) {
    return tracked(this, ...a);
  }
  pushed(...a) {
    return pushed(this, ...a);
  }
  gitState(...a) {
    return gitState(this, ...a);
  }

  // ── Reading and restoring ─────────────────────────────────────────────────────────────

  /** @param {string} convId @param {string} fileId @param {string|null} [changeId] */
  fileDiff(convId, fileId, changeId = null) {
    return fileDiff(this, convId, fileId, changeId);
  }
  /** @param {string} convId @param {string} entryId */
  output(convId, entryId) {
    return output(this, convId, entryId);
  }
  /** @param {string} convId @param {string} fileId */
  restore(convId, fileId) {
    return restore(this, convId, fileId);
  }

  /** After a restart: turns and commands that were running can’t finish, so they say so. */
  expireStale() {
    for (const [convId, list] of Object.entries(this.s.work ?? {}))
      for (const e of list) {
        if (e.kind === 'turn' && e.status === 'running') this.patch(convId, e.id, { status: 'interrupted' });
        if ((e.kind === 'command' || e.kind === 'external') && (e.state === 'running' || e.state === 'background'))
          this.patch(convId, e.id, { state: 'unknown' });
      }
  }
}
