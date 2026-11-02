#!/usr/bin/env node
// What a snapshot would weigh under each way of keeping old turns' work and activity out of the live state (#305,
// designs/305-archive-turns.md, "Alternatives"), on a copy of a real store. Run it on a snapshot.json:
//
//   node tools/measure-archive-policies.mjs path/to/snapshot.json
//
// Each row is the whole snapshot after the policy, its stringify time (best of five), and the saving against today.
// The policies move bytes by the same rules the design uses: an archived turn's work entries are replaced by one summary
// entry, and an archived reply's activity by a count; the skeleton keeps every entry but not its heavy text.

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/measure-archive-policies.mjs snapshot.json');
  process.exit(2);
}
const fresh = () => JSON.parse(readFileSync(path, 'utf8'));
const size = (v) => Buffer.byteLength(JSON.stringify(v ?? null));
const mb = (b) => (b / 1048576).toFixed(2);

/** The turn ids of one conversation, oldest first by the earliest entry or reply that names each. */
function turnOrder(s, convId) {
  const first = new Map();
  const see = (id, at) => {
    if (id && (!first.has(id) || at < first.get(id))) first.set(id, at);
  };
  for (const e of s.work?.[convId] ?? []) see(e.turnId, e.at ?? e.startedAt ?? 0);
  for (const list of Object.values(s.items ?? {})) for (const it of list) if (it.turnId && it.activity) see(it.turnId, it.at ?? Infinity);
  return [...first].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** The handle that ran each turn, from its turn entry. */
const handleOf = (s, convId) => new Map((s.work?.[convId] ?? []).filter((e) => e.kind === 'turn').map((e) => [e.turnId, e.handle]));

/** Keeps the turns `keepFor(convId)` names; archives every other turn's work and reply activity. */
function archive(s, keepFor) {
  for (const convId of Object.keys(s.work ?? {})) {
    const keep = keepFor(s, convId);
    s.work[convId] = s.work[convId].filter((e) => !e.turnId || keep.has(e.turnId) || ['branch', 'commit', 'push', 'file'].includes(e.kind));
    for (const list of Object.values(s.items ?? {}))
      for (const it of list)
        if (it.activity && it.turnId && !keep.has(it.turnId)) it.activity = { archived: 'x'.repeat(64), count: it.activity.steps?.length ?? 0 };
  }
  return s;
}

const lastK = (k) => (s, convId) => new Set(turnOrder(s, convId).slice(-k));
const perAgent = (k) => (s, convId) => {
  const who = handleOf(s, convId);
  const byHandle = new Map();
  for (const id of turnOrder(s, convId)) (byHandle.get(who.get(id) ?? '?') ?? byHandle.set(who.get(id) ?? '?', []).get(who.get(id) ?? '?')).push(id);
  return new Set([...byHandle.values()].flatMap((ids) => ids.slice(-k)));
};

/** Keeps every entry and step, minus the text a person reads only on demand: a command’s line, a step’s detail. */
function skeleton(s) {
  for (const list of Object.values(s.work ?? {}))
    for (const e of list) {
      if (e.kind === 'command' || e.kind === 'external') delete e.command;
    }
  for (const list of Object.values(s.items ?? {})) for (const it of list) for (const st of it.activity?.steps ?? []) delete st.detail;
  return s;
}

const policies = [
  ['today (nothing archived)', (s) => s],
  ['last 2 turns of the conversation (the design as drafted)', (s) => archive(s, lastK(2))],
  ['last 5 turns of the conversation', (s) => archive(s, lastK(5))],
  ['last 10 turns of the conversation', (s) => archive(s, lastK(10))],
  ['each agent’s last 2 turns', (s) => archive(s, perAgent(2))],
  ['each agent’s last 5 turns', (s) => archive(s, perAgent(5))],
  ['skeleton: every entry kept, command lines and step details behind the blob route', skeleton],
  ['skeleton, then each agent’s last 2 turns archived', (s) => archive(skeleton(s), perAgent(2))],
];

const base = size(fresh());
console.log(`${path}: ${mb(base)} MB\n`);
for (const [name, apply] of policies) {
  const s = apply(fresh());
  let ms = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    JSON.stringify(s);
    ms = Math.min(ms, performance.now() - t0);
  }
  const b = size(s);
  console.log(`${mb(b).padStart(6)} MB  ${ms.toFixed(1).padStart(5)} ms  ${(100 - (100 * b) / base).toFixed(0).padStart(3)}% smaller  ${name}`);
}

// I4's open states (designs/305-archive-turns.md): a turn with a command left running, background or unknown stays hot.
{
  const s = fresh();
  const open = new Set(['running', 'background', 'unknown']);
  let turns = 0;
  let held = 0;
  let all = 0;
  for (const list of Object.values(s.work ?? {})) {
    const ids = new Set(list.filter((e) => e.turnId).map((e) => e.turnId));
    const stuck = new Set(list.filter((e) => e.kind !== 'turn' && open.has(e.state)).map((e) => e.turnId));
    turns += ids.size;
    for (const e of list) {
      all += size(e);
      if (stuck.has(e.turnId)) held += size(e);
    }
  }
  console.log(`\nI4: ${turns} turns, of which turns with an entry left open hold ${mb(held)} MB of ${mb(all)} MB of work`);
}

// What opening one old turn reads (access pattern A2): the size of a turn's work entries.
{
  const s = fresh();
  const per = [];
  for (const list of Object.values(s.work ?? {})) {
    const by = new Map();
    for (const e of list) if (e.turnId) by.set(e.turnId, (by.get(e.turnId) ?? 0) + size(e));
    per.push(...by.values());
  }
  per.sort((a, b) => a - b);
  console.log(
    `A2: a turn's work is ${(per.at(-1) / 1024).toFixed(0)} KB at most, ${(per[Math.floor(per.length / 2)] / 1024).toFixed(1)} KB at the median (${per.length} turns)`,
  );
}
