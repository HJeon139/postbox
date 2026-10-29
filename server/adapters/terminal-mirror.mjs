// Attach an existing Claude Code session to Postbox, and mirror what happens in it from a terminal.
//
// Claude Code keeps each session as JSON Lines at ~/.claude/projects/<folder, with / as ->/<session id>.jsonl.
// listClaudeSessions() finds recent ones without reading whole files. TranscriptTail follows one file and
// hands over each complete new line. entriesToItems() turns transcript entries into Postbox items: what you
// typed, the agent’s text, and its tool calls as activity. Postbox’s own turns are recorded in the same file,
// so the runtime ignores lines written while a Postbox turn runs, and skips past them when the turn ends.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contentBlocks } from './claude-content.mjs';
import { describeTool } from './claude-stream.mjs';

export { contentBlocks };

export const projectsRoot = () => join(homedir(), '.claude', 'projects');

const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Reads up to n bytes from the start or the end of a file, as complete lines. */
function readEdge(file, n, fromEnd) {
  const size = statSync(file).size;
  const len = Math.min(n, size);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  // A cut at either edge leaves a partial line; drop it.
  if (fromEnd && len < size) lines.shift();
  if (!fromEnd && len < size) lines.pop();
  return lines.map(parse).filter(Boolean);
}

function parse(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The text a person typed, or null if this entry isn’t one (a tool result, a command wrapper, a reminder). */
export function typedText(e) {
  if (e?.type !== 'user' || e.isSidechain || e.isMeta) return null;
  const c = e.message?.content;
  const text =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : '';
  if (!text.trim() || (Array.isArray(c) && c.some((b) => b.type === 'tool_result'))) return null;
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout)/.test(text)) return null;
  return text;
}

/** Recent Claude Code sessions, newest first: { id, cwd, title, updatedAt, file }. */
export async function listClaudeSessions({ root = projectsRoot(), limit = 30 } = {}) {
  root ||= projectsRoot();
  const found = [];
  for (const dir of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
      const file = join(root, dir, name);
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) found.push({ id: name.slice(0, 36), file, updatedAt: s.mtimeMs });
    }
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt);
  return found.slice(0, limit).map((f) => {
    const head = readEdge(f.file, 64 * 1024, false);
    const tail = readEdge(f.file, 64 * 1024, true);
    const cwd = head.find((e) => e.cwd)?.cwd ?? tail.find((e) => e.cwd)?.cwd ?? null;
    const titled = [...tail].reverse().find((e) => e.type === 'custom-title')?.customTitle;
    const first = head.map(typedText).find(Boolean);
    return { ...f, cwd, title: clip(titled ?? first ?? 'Untitled session', 80) };
  });
}

/** Follows a transcript from an offset; poll() returns the complete lines added since. */
export class TranscriptTail {
  constructor(file, offset = null) {
    this.file = file;
    this.offset = offset ?? this.size();
    this.partial = '';
  }
  size() {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }
  /** Skips everything written so far, such as a Postbox turn that just ended. */
  skipToEnd() {
    this.offset = this.size();
    this.partial = '';
  }
  poll() {
    const size = this.size();
    if (size < this.offset) this.offset = 0; // the file was replaced
    if (size === this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop() ?? '';
    return lines.map(parse).filter(Boolean);
  }
}

/**
 * Turns transcript entries into Postbox items. Consecutive assistant entries since the last thing you typed
 * become one agent item, with its tool calls as activity steps.
 * @returns {any[]}  { kind: 'user', text } and { kind: 'agent', text, steps: [{ id, label, state }] }
 */
export function entriesToItems(entries) {
  /** @type {any[]} */
  const out = [];
  /** @type {any} */
  let agent = null;
  for (const e of entries) {
    if (e.isSidechain) continue;
    const typed = typedText(e);
    if (typed) {
      out.push({ kind: 'user', text: typed });
      agent = null;
      continue;
    }
    if (e.type === 'assistant') {
      agent ??= out[out.push({ kind: 'agent', text: '', steps: [] }) - 1];
      for (const b of contentBlocks(e.message?.content)) {
        if (b.type === 'text' && b.text?.trim()) agent.text += (agent.text ? '\n\n' : '') + b.text;
        if (b.type === 'tool_use') agent.steps.push({ id: b.id, label: describeTool(b.name, b.input), state: 'running' });
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result') continue;
        for (const it of out) if (it.kind === 'agent') for (const s of it.steps) if (s.id === b.tool_use_id) s.state = b.is_error ? 'failed' : 'done';
      }
    }
  }
  return out.filter((it) => it.kind === 'user' || it.text || it.steps.length);
}

/** The last few exchanges of a transcript, for a thread that starts with some history. */
export function recentHistory(file, { bytes = 256 * 1024, items = 12 } = {}) {
  return entriesToItems(readEdge(file, bytes, true)).slice(-items);
}
