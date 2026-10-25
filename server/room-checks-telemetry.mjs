// The checks that watch telemetry in a UAT run (designs/telemetry-persona.md, U3). They read the run’s telemetry folder
// and probes (facts.telemetry, from tools/uat/telemetry-run.mjs), and none of them calls the gate’s code
// (shared/telemetry*.mjs): a check that used the gate would only test that the gate agrees with itself. A live room has
// no facts.telemetry, so a live report lists them as not run.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { POSTBOX_SERVER } from './adapters/setup.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** Latin letters that Cyrillic and Greek ones look like, mapped back, so a look-alike canary reads as itself. */
const LOOKALIKE = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Κ: 'K',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Χ: 'X',
};

/** Text as a leak would hide in it undone: look-alikes mapped back, zero-width and spacing taken out, digits spelled out read back. */
function plain(text) {
  let s = String(text).replace(/[​-‏⁠﻿]/g, '');
  s = s.replace(/[^ -~\n\t]/g, (ch) => LOOKALIKE[ch] ?? ch);
  s = s.replace(new RegExp(`\\b(${DIGITS.join('|')})\\b`, 'gi'), (w) => String(DIGITS.indexOf(w.toLowerCase())));
  return s;
}
const squeeze = (s) => s.replace(/[\s"',]+/g, '');

/** Each canary in every encoding U2’s fixture covers: as it is, base64 (whole or a third of it), and hex. */
function forms(value) {
  const b64 = Buffer.from(value).toString('base64').replace(/=+$/, '');
  return [value, b64, ...(b64.length >= 18 ? [b64.slice(0, Math.ceil(b64.length / 3))] : []), Buffer.from(value).toString('hex')];
}

/** What telemetry let out of the run: each saved report and the files derived from it, and what File issue copied. */
function outputs(t) {
  return [
    ...(t.reports ?? []).flatMap((r) => [
      { what: `report ${r.id}`, text: r.text },
      ...r.derived.map((text, i) => ({ what: `${['run.json', 'findings.json'][i]} of ${r.id}`, text })),
    ]),
    ...(t.shown?.copied ?? []).map((c, i) => ({ what: `copied text ${i + 1}`, text: c.text })),
  ];
}

/** Every five-word run in the room’s items, lowercased. */
function fiveWordRuns(f) {
  const runs = new Set();
  for (const id of f.threads ?? [])
    for (const it of f.state?.items?.[id] ?? []) {
      const words =
        String(it.text ?? '')
          .toLowerCase()
          .match(/[a-z0-9]+/g) ?? [];
      for (let i = 0; i + 5 <= words.length; i++) runs.add(words.slice(i, i + 5).join(' '));
    }
  return runs;
}

/** What the room holds that’s the person’s or an agent’s: canaries, file paths, command lines, handles, block ids, instruction lines. */
function secretsOf(f, t) {
  const out = Object.entries(t.canaries ?? {}).flatMap(([k, v]) => forms(v).map((x) => [`canary ${k}`, x]));
  const walk = (d) =>
    (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []).flatMap((e) =>
      e.name === '.git' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  for (const p of walk(t.workspace ?? '')) out.push(['a file path', relative(t.workspace, p)]);
  for (const s of f.streams ?? [])
    for (const e of s.events ?? [])
      for (const b of e.message?.content ?? [])
        if (b?.type === 'tool_use' && typeof b.input?.command === 'string') out.push(['a command line', b.input.command]);
  const personas = Object.values(f.state?.personas ?? {});
  for (const p of personas) {
    if (!['researcher', 'developer', 'critic', 'writer', 'reviewer'].includes(p.handle)) out.push(['a handle', `@${p.handle}`]);
    for (const l of String(p.instructions ?? '').split('\n')) if (l.trim().length >= 30) out.push(['an instruction line', l.trim()]);
  }
  for (const id of f.threads ?? [])
    for (const it of f.state?.items?.[id] ?? []) if (it.block?.id && it.block.id.length >= 6) out.push(['a block id', it.block.id]);
  return out.filter(([, v]) => String(v).length >= 6);
}

/** Postbox’s own words about telemetry, as its UI says them, and the field its recorder adds. */
const OWN_WORDS = [/Recording since/, /Record this room/, /Stop recording/, /Telemetry report/, /Delete recordings/, /"recording"\s*:/];

/**
 * The parts of a turn’s input that Postbox writes: [Postbox] lines, and its own tools’ results (not a command’s). From
 * the streams and the agents’ transcripts, which alone hold the input a turn started with.
 */
function postboxWritten(streams, transcripts) {
  const parse = (l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  };
  const out = [];
  for (const s of [...(streams ?? []), ...(transcripts ?? []).map((t) => ({ handle: t.handle, events: t.lines.flatMap(parse) }))]) {
    const ours = new Set();
    for (const e of s.events ?? []) {
      if (e.type === 'assistant')
        for (const b of e.message?.content ?? []) if (b?.type === 'tool_use' && String(b.name).startsWith(`mcp__${POSTBOX_SERVER}__`)) ours.add(b.id);
      if (e.type !== 'user') continue;
      const content = typeof e.message?.content === 'string' ? [{ type: 'text', text: e.message.content }] : (e.message?.content ?? []);
      for (const b of content) {
        if (b?.type === 'tool_result' && ours.has(b.tool_use_id)) out.push({ handle: s.handle, text: JSON.stringify(b.content ?? '') });
        else if (b?.type === 'text') for (const l of String(b.text).split('\n')) if (l.startsWith('[Postbox]')) out.push({ handle: s.handle, text: l });
      }
    }
  }
  return out;
}

const CHECKS = [
  {
    // Anything from the project or the room in what telemetry saved or let out (R12–R16, R19), in any encoding the
    // fixture covers, or spread over a run of five words.
    id: 'telemetry-leak',
    inputs: ['telemetry', 'state', 'threads', 'streams'],
    issue: null,
    run: (f) => {
      const t = f.telemetry;
      const hits = [];
      const runs = fiveWordRuns(f);
      for (const o of outputs(t)) {
        const text = plain(o.text);
        for (const [what, value] of secretsOf(f, t))
          if (text.includes(plain(value)) || squeeze(text).includes(squeeze(plain(value)))) hits.push(`${what} in ${o.what}`);
        const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        for (let i = 0; i + 5 <= words.length; i++)
          if (runs.has(words.slice(i, i + 5).join(' '))) {
            hits.push(`five words from the room in ${o.what}`);
            break;
          }
      }
      return hits.length ? [{ title: 'Telemetry let out something from the project or the room', evidence: [...new Set(hits)].slice(0, 8).join('; ') }] : [];
    },
  },
  {
    // An agent’s turn input that tells it the room is recorded (R5, R6): Postbox’s own telemetry words in what Postbox
    // writes. What agents or the person write is left out.
    id: 'recording-visible',
    inputs: ['telemetry', 'streams', 'transcripts'],
    issue: null,
    run: (f) => {
      const hits = postboxWritten(f.streams, f.transcripts).filter((x) => OWN_WORDS.some((w) => w.test(x.text)));
      return hits.length
        ? [
            {
              title: 'An agent’s input says the room is recorded',
              evidence: `@${hits[0].handle} read “${hits[0].text.slice(0, 160)}”${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}.`,
            },
          ]
        : [];
    },
  },
  {
    // A finding a live room could make that the saved report doesn’t list (R8).
    id: 'telemetry-missed-finding',
    inputs: ['telemetry'],
    issue: null,
    run: (f) => {
      const r = f.telemetry.reports.at(-1);
      if (!r?.text) return [];
      const listed = new Set((JSON.parse(r.text).checks?.found ?? []).map((k) => k.check));
      const missed = f.telemetry.expected.filter((c) => !listed.has(c));
      return missed.length ? [{ title: 'The telemetry report misses a check finding', evidence: `Report ${r.id} doesn’t list ${missed.join(', ')}.` }] : [];
    },
  },
  {
    // A recorded turn the report doesn’t count as recorded, or one without a whole stream it doesn’t list as a gap (R10).
    id: 'telemetry-gap-as-zero',
    inputs: ['telemetry'],
    issue: null,
    run: (f) => {
      const t = f.telemetry;
      const r = t.reports.at(-1);
      const draft = r && t.drafts.find((d) => d?.report?.id === r.id);
      if (!r?.text || !draft) return [];
      const report = JSON.parse(r.text);
      const refOf = (turnId) => Object.entries(draft.local ?? {}).find(([, v]) => v.kind === 'turn' && v.id === turnId)?.[0];
      const wrong = [];
      for (const row of t.turns) {
        const file = join(t.recordingDir, row.stream ?? '');
        // lint-allow quotes: a stream line’s JSON, matched as Claude Code writes it.
        const whole = existsSync(file) && readFileSync(file, 'utf8').includes('"type":"result"');
        const turn = (report.turns ?? []).find((x) => x.ref === refOf(row.turnId));
        if (!turn) continue;
        if (whole && turn.recorded !== true) wrong.push(`${turn.ref} has a whole stream but isn’t counted as recorded`);
      }
      for (const turn of report.turns ?? [])
        if (turn.recorded !== true && !(report.gaps ?? []).some((g) => g.turn === turn.ref)) wrong.push(`${turn.ref} has no stream and no gap`);
      return wrong.length ? [{ title: 'The telemetry report counts a missing stream as a quiet turn', evidence: wrong.slice(0, 6).join('; ') }] : [];
    },
  },
  {
    // Saved or copied bytes that differ from what the Telemetry view showed (R18, R19).
    id: 'telemetry-bytes-mismatch',
    inputs: ['telemetry'],
    issue: null,
    run: (f) => {
      const t = f.telemetry;
      const out = [];
      for (const r of t.reports)
        if (r.text && !(t.shown?.saved ?? []).includes(sha(r.text))) out.push(`report ${r.id}’s hash isn’t one the view showed at Save`);
      for (const c of t.shown?.copied ?? [])
        if (!(t.shown?.issues ?? []).some((i) => i.text === c.text)) out.push('File issue copied text the dialog didn’t show');
      for (const i of t.shown?.issues ?? []) if (i.hash && i.hash !== sha(i.text)) out.push('the issue’s hash isn’t its text’s');
      return out.length ? [{ title: 'Telemetry saved or sent bytes you weren’t shown', evidence: out.join('; ') }] : [];
    },
  },
  {
    // A runner’s 🚩 recorded on an item other than the one it reacted to (R9).
    id: 'flag-misplaced',
    inputs: ['telemetry', 'state', 'threads'],
    issue: null,
    run: (f) => {
      const items = (f.threads ?? []).flatMap((id) => f.state?.items?.[id] ?? []);
      // Only once the runner has reacted, after the last step (U4); only the runner’s own, as the person: an agent’s 🚩
      // on the item (#270) isn’t it.
      const off = f.telemetry.flags.filter((x) => x.reacted && !items.find((it) => it.id === x.item)?.reactions?.some((r) => r.emoji === '🚩' && !r.by));
      return off.length
        ? [{ title: 'A 🚩 isn’t on the item it was put on', evidence: off.map((x) => `the 🚩 for “${x.key}” isn’t on ${x.item}`).join('; ') }]
        : [];
    },
  },
  {
    // A recording or report outside the run’s telemetry folder, anything under the project, or the wrong modes (R11).
    // The runner’s own copy, telemetry/report.json in the run folder, is the runner’s.
    id: 'telemetry-at-rest',
    inputs: ['telemetry'],
    issue: null,
    run: (f) => {
      const t = f.telemetry;
      const out = t.modes.filter((m) => m.mode !== (m.dir ? 0o700 : 0o600)).map((m) => `${m.path} is ${m.mode.toString(8)}`);
      const walk = (d) =>
        (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []).flatMap((e) =>
          e.name === '.git' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
        );
      for (const p of walk(t.workspace ?? ''))
        if (/telemetry|rep_[A-Za-z0-9]{6,}/i.test(relative(t.workspace, p)) || /postbox-telemetry/.test(readFileSync(p, 'utf8').slice(0, 4000)))
          out.push(`${relative(t.workspace, p)} is in the project`);
      return out.length ? [{ title: 'Telemetry keeps files where it shouldn’t, or open to others', evidence: out.slice(0, 8).join('; ') }] : [];
    },
  },
];

/** Each runs only in a run that recorded: with no facts.telemetry, there’s nothing to check. */
export const TELEMETRY_CHECKS = CHECKS.map((c) => ({ ...c, run: (f) => (f.telemetry ? c.run(f) : []) }));
export const TELEMETRY_CHECK_IDS = TELEMETRY_CHECKS.map((c) => c.id);
