// The P0 hotfixes’ checks (#108, #123, #125, #126), over the history tools/uat/room-history.mjs reads. Part of
// tools/uat/room-checks.mjs’s CHECKS, kept apart for size.

import { clip } from '../../shared/text.mjs';
import { claudeSessionOf } from './room-checks-tools.mjs';
import { backgroundJobs, blockHistory, clip200, clock, jobRecord, postboxCallsAfter, SLACK_MS, secs, streamSpan, wakesSent } from './room-history.mjs';
import { itemsOf } from './room-items.mjs';

export const P0_CHECKS = [
  {
    // Two processes in one Claude Code session (#126): a turn that started while the session’s previous turn was still
    // making requests, or a stopped turn whose process went on calling Postbox’s tools after Stop. Claude Code turns
    // only; the Kiro CLI adapter stops a turn the same way, and isn’t judged here.
    id: 'two-processes-one-session',
    inputs: ['state', 'threads', 'streams'],
    issue: 126,
    run: (f) => {
      const out = [];
      /** @type {Map<string, { s: any, start: number|null, last: number|null }[]>} */
      const byClaude = new Map();
      for (const s of f.streams ?? []) {
        const id = claudeSessionOf(s.events);
        if (!id) continue;
        byClaude.set(id, [...(byClaude.get(id) ?? []), { s, ...streamSpan(s) }]);
      }
      for (const [id, list] of byClaude) {
        const timed = list.filter((x) => x.start !== null).sort((a, b) => /** @type {number} */ (a.start) - /** @type {number} */ (b.start));
        for (let i = 1; i < timed.length; i++) {
          const b = timed[i];
          const a = timed.slice(0, i).find((x) => x.last !== null && /** @type {number} */ (x.last) > /** @type {number} */ (b.start) + SLACK_MS);
          if (!a) continue;
          const start = /** @type {number} */ (b.start);
          const last = /** @type {number} */ (a.last);
          out.push({
            key: `overlap:${id}:${start}`,
            title: 'Two turns of one agent session ran at the same time',
            evidence: `@${b.s.handle}’s turn started at ${clock(start)} while the session’s previous turn (Claude Code session ${id.slice(0, 8)}) went on until ${clock(last)}, ${secs(last - start)} later.`,
          });
        }
      }
      // A stopped turn’s Postbox calls after Stop. The stopped item names the session; the session names its Claude
      // Code session, and so the streams that are its turns.
      for (const it of itemsOf(f)) {
        if (it.kind !== 'agent' || it.status !== 'stopped' || !Number.isFinite(it.stoppedAt)) continue;
        const claudeId = f.state.sessions?.[it.sessionId]?.backendState?.claudeSessionId;
        if (!claudeId) continue;
        for (const s of f.streams ?? []) {
          const span = streamSpan(s);
          if (claudeSessionOf(s.events) !== claudeId || span.start === null || span.start > it.stoppedAt) continue;
          const calls = postboxCallsAfter(s.events, it.stoppedAt + SLACK_MS);
          if (!calls.length) continue;
          const names = [...new Set(calls.map((c) => c.name))];
          out.push({
            key: `after-stop:${it.id}`,
            title: 'A stopped turn went on calling Postbox’s tools',
            evidence: `@${it.handle} was stopped at ${clock(it.stoppedAt)}, and its process then made ${calls.length} Postbox call${calls.length === 1 ? '' : 's'} (${names.slice(0, 4).join(', ')}), the last ${secs(Math.max(...calls.map((c) => c.at)) - it.stoppedAt)} after Stop.`,
          });
          break;
        }
      }
      return out;
    },
  },
  {
    // A background command whose step says done while it runs (#126, which takes this part of #129). Running is read
    // from the stream: it started in the background and the stream hasn’t reported its end. A fix’s own job record,
    // when there is one, says whether it ended.
    id: 'background-step-closed',
    inputs: ['state', 'threads', 'streams'],
    issue: 126,
    run: (f) => {
      /** @type {Map<string, { step: any, it: any }>} */
      const steps = new Map();
      for (const it of itemsOf(f)) for (const st of it.activity?.steps ?? []) if (st?.id) steps.set(st.id, { step: st, it });
      return (f.streams ?? []).flatMap(({ handle, events }) =>
        backgroundJobs(events).flatMap((j) => {
          const shown = steps.get(j.id);
          if (shown?.step.state !== 'done') return [];
          const record = jobRecord(f.state, j);
          // A fix keeps the job’s record while it runs, and its step running until it ends: a step it closed (one that
          // names its job) with no record left has ended, whatever the stream, whose CLI Keep running ends, says.
          if (record ? record.ended : j.ended || shown.step.job) return [];
          return [
            {
              key: j.id,
              title: 'A background command’s step reads done while the command still runs',
              evidence: `@${handle}’s step “${clip(shown.step.label, 100)}” says done, but ${record ? 'Postbox’s record of the job' : 'the stream'} hasn’t seen it end${j.task ? ` (background id ${j.task})` : ''}: ${clip(j.command, 120) || 'a background command'}.`,
            },
          ];
        }),
      );
    },
  },
  {
    // One session showing two blocks with one id in a conversation (#125): an answer, an update and an outcome all
    // name a block by id, so they can’t tell the two apart. A block that failed to validate isn’t shown as one.
    id: 'duplicate-block-id',
    inputs: ['state', 'threads'],
    issue: 125,
    run: (f) => {
      /** @type {Map<string, any[]>} */
      const groups = new Map();
      for (const it of itemsOf(f)) {
        if (it.kind !== 'block' || !it.valid || !it.block?.id) continue;
        const k = `${it.threadId}\n${it.sessionId}\n${it.block.id}`;
        groups.set(k, [...(groups.get(k) ?? []), it]);
      }
      return [...groups.values()]
        .filter((list) => list.length > 1)
        .map((list) => {
          const times = list.map((it) => it.at).filter((n) => Number.isFinite(n));
          return {
            key: `${list[0].threadId}:${list[0].sessionId}:${list[0].block.id}`,
            title: 'An agent showed two blocks with the same id in one conversation',
            evidence: `@${list[0].handle} showed “${clip(list[0].block.id, 80)}” ${list.length} times in “${f.state.threads?.[list[0].threadId]?.title ?? list[0].threadId}”: ${list
              .map((it) => `${it.id} (“${clip(it.block.title ?? it.block.prompt ?? it.block.type, 60)}”)`)
              .join(', ')}${times.length > 1 ? `, ${secs(Math.max(...times) - Math.min(...times))} apart` : ''}.`,
          };
        });
    },
  },
  {
    // An answer and the revision it was for (#123). Two ways it goes wrong, read from the history: an answer applied to
    // a revision other than the one the person was answering (what the runner read just before it answered, or the
    // revision a fix records on the answer), and an update that reopened an answered block before the agent read the
    // answer, which erases it unread.
    id: 'approval-for-other-revision',
    inputs: ['events', 'probes'],
    issue: 123,
    run: (f) => {
      const out = [];
      const { answers, reopened } = blockHistory(f.events ?? []);
      for (const r of reopened)
        out.push({
          key: `reopened:${r.itemId}:${r.revision}`,
          title: 'An agent’s update reopened a block the person had answered, before the agent read the answer',
          evidence: `@${r.handle}’s update made revision ${r.revision} of “${clip(r.title, 80)}”${r.ms !== null ? ` ${secs(r.ms)}` : ''} after the person’s ${r.answer.action} on revision ${r.answer.revision}, with no turn in between to read it, so the answer was erased unread.`,
        });
      const probes = f.probes?.answers ?? [];
      for (const a of answers) {
        // The runner’s note for this answer: its latest one on the block before the answer landed.
        const probe = Number.isFinite(a.at)
          ? probes.filter((p) => p.key === a.itemId && Number.isFinite(p.at) && p.at <= a.at + SLACK_MS).sort((x, y) => y.at - x.at)[0]
          : undefined;
        const saw = a.saw ?? probe?.revision ?? null;
        if (saw === null || saw === a.revision) continue;
        out.push({
          key: `answer:${a.itemId}:${a.seq}`,
          title: 'An answer was applied to a revision the person didn’t answer',
          evidence: `The person answered revision ${saw} of @${a.handle}’s “${clip(a.title, 80)}”, and Postbox applied their ${a.action} to revision ${a.revision}.`,
        });
      }
      return out;
    },
  },
  {
    // An allowed wake that delivered less than the agent sent (#108): the request kept a 200-character preview, and
    // allowing it delivered the preview. The delivered message is the sender’s item in the side thread; what it sent
    // is the request’s full text (a fix keeps it), or else its wake_agent call or reply.
    id: 'wake-text-clipped',
    inputs: ['state', 'threads', 'streams'],
    issue: 108,
    run: (f) => {
      const items = itemsOf(f);
      const sent = wakesSent(f);
      return items
        .filter((it) => it.kind === 'hop' && it.status === 'allowed' && typeof it.reason === 'string')
        .flatMap((hop) => {
          const full = typeof hop.text === 'string' ? hop.text : null;
          const side = items.filter(
            (x) =>
              x.kind === 'agent' &&
              !x.turnId &&
              x.sessionId === hop.fromSessionId &&
              (x.at ?? 0) >= (hop.at ?? 0) &&
              f.state.threads?.[x.threadId]?.kind === 'side',
          );
          const delivered = (full !== null ? side.find((x) => x.text === full) : null) ?? side.find((x) => x.text === hop.reason);
          if (!delivered) return [];
          const original =
            full ??
            sent.find(
              (m) => m.from === hop.from && (m.to === null || m.to === hop.to) && m.text.length > delivered.text.length && clip200(m.text) === hop.reason,
            )?.text ??
            null;
          // Clipped, not only made plain: a message of 200 characters or fewer was never cut.
          const short =
            original !== null ? original.length > 200 && delivered.text.length < original.length : /…$/.test(hop.reason) && hop.reason.length >= 200;
          if (!short) return [];
          return [
            {
              key: hop.id,
              title: 'An allowed agent wake delivered less than the agent sent',
              evidence:
                original !== null
                  ? `@${hop.from} sent @${hop.to} ${original.length.toLocaleString('en-US')} characters; once the wake was allowed, @${hop.to} got ${delivered.text.length.toLocaleString('en-US')}, ending “${clip(delivered.text.slice(-60), 60)}”.`
                  : `Once the wake was allowed, @${hop.to} got only the request’s ${delivered.text.length}-character preview, ending “${clip(delivered.text.slice(-60), 60)}”.`,
            },
          ];
        });
    },
  },
];
