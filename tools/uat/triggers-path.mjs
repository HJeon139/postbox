// #672’s trigger of a host-mode run, host-node-found (tools/uat/triggers-host.mjs has the rest): an agent on a host
// ran `node --version` with the Bash tool, exactly that and with no PATH of its own, and it printed a version. Before
// #672 a host turn ran with the daemon’s PATH, a non-interactive ssh shell’s, which on a host whose Node comes from a
// version manager has no node: the command failed with exit 127, and the agent had to find Node and add it by hand.
//
// The evidence is the agent’s own recorded stream: the Bash call, its result’s is_error, and its text. A command that
// sets PATH, names a version manager or a full path to node isn’t this one, so it never fires.

import { onHost, placeOf } from './remote-facts.mjs';
import { resultText } from './trigger-facts.mjs';

/** Exactly `node --version`, or `node -v`: the agent found node on its PATH as it was given. */
const PLAIN_NODE = /^\s*node\s+(--version|-v)\s*$/;
/** What `node --version` prints. */
const VERSION = /^v\d+\.\d+\.\d+/m;

/** Every Bash call in an agent’s stream, with its result. @param {{ handle: string, events: any[] }} s */
function bashCalls(s) {
  const results = new Map();
  for (const e of s.events ?? [])
    if (e?.type === 'user')
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
  const out = [];
  for (const e of s.events ?? []) {
    if (e?.type !== 'assistant') continue;
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b?.type !== 'tool_use' || b.name !== 'Bash') continue;
      const r = results.get(b.id);
      const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
      out.push({ command: String(b.input?.command ?? ''), error: r?.is_error === true, text: resultText(r), at: Number.isFinite(at) ? at : null });
    }
  }
  return out;
}

/** @param {any} f */
function nodeFound(f) {
  const out = [];
  for (const s of (f.streams ?? []).filter((x) => onHost(f, x.handle)))
    for (const c of bashCalls(s))
      if (PLAIN_NODE.test(c.command) && !c.error && VERSION.test(c.text))
        out.push({ at: c.at, evidence: `${placeOf(f, s.handle)}: @${s.handle}’s \`${c.command.trim()}\` printed ${c.text.match(VERSION)?.[0]}` });
  return out;
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const PATH_TRIGGERS = {
  'host-node-found': {
    issue: 672,
    says: 'an agent on a host ran `node --version` as it was given, with no PATH of its own, and it printed a version',
    recorded: (f) => Boolean(f.hosts?.hosts?.length),
    run: nodeFound,
  },
};
