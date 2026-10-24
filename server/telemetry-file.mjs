// File issue on a saved telemetry report’s finding (designs/telemetry-persona.md, R19). The issue’s text is rendered
// from the saved report.json with a fixed template, with no model and no verifier, and shown with its hash first. When
// you confirm, Postbox renders it again from the bytes on disk, and refuses if the hash differs from the one you were
// shown. Then it files under your own gh sign-in, or copies the text and opens GitHub’s new-issue page, with nothing in
// the address. Postbox never holds a token.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { httpError } from './helpers.mjs';
import { findingsOf, savedBytes } from './telemetry-save.mjs';

export const REPO = 'HJeon139/postbox';
/** Where a person without gh files by hand: the page itself, with no report content in its address. */
export const NEW_ISSUE = `https://github.com/${REPO}/issues/new`;
const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The hidden fingerprint that finds duplicates, from Postbox’s vocabulary only: live, the check id or flag, the issue
 * number, the MAST code and the area. Never refs, ids, handles or anything an agent or the person chose.
 */
export const fingerprintOf = (f) => `live:${f.check ?? 'flag'}:${f.issue ?? 'none'}:${f.telemetry?.mast ?? 'unlabeled'}:${f.telemetry?.area ?? 'unlabeled'}`;

/** A finding’s issue: its title and body, from the saved report’s values and nothing else. */
export function issueText(report, f) {
  const part = f.source === 'check' ? (report.checks?.found ?? []).find((k) => k.ref === f.ref) : (report.reactions ?? []).find((r) => r.ref === f.ref);
  const label = (report.labels ?? []).find((l) => l.on === f.ref) ?? null;
  const r = report.room ?? {};
  const agents = (report.agents ?? []).map((a) => `${a.id} on ${a.backend} (${a.model}, ${a.effort ?? 'default'} effort)`).join('; ');
  const body = [
    'A finding from a live room, reported with Postbox’s telemetry. It holds Postbox’s own values only: no project content.',
    '',
    `**Postbox:** ${report.postbox?.version ?? '?'}${report.postbox?.commit ? ` (${report.postbox.commit})` : ''} · **Room:** ${r.kind ?? 'room'}, ${r.agents ?? 0} agents, ${r.turns ?? 0} turns`,
    `**Agents:** ${agents || 'none'}`,
    ...(f.issue ? [`**Catches again:** #${f.issue}`] : []),
    '',
    '```json',
    JSON.stringify({ finding: part ?? null, label }, null, 2),
    '```',
    '',
    `<!-- ${fingerprintOf(f)} -->`,
  ].join('\n');
  return { title: f.title, body };
}

/** The finding and its issue text, from the saved report on disk. */
function rendered(rt, id, key) {
  const { report } = savedBytes(rt, id);
  const f = findingsOf(report).find((x) => x.key === key);
  if (!f) throw httpError(404, 'That finding isn’t in the saved report.');
  const { title, body } = issueText(report, f);
  const text = `${title}\n\n${body}`;
  return { f, title, body, text, hash: sha(text) };
}

/** What File issue shows before anything is sent: the exact text, and its hash (R19, step 1). */
export function issuePreview(rt, id, key) {
  const { text, hash } = rendered(rt, id, key);
  return { text, hash };
}

/** Runs the gh CLI: POSTBOX_GH_BIN, else gh on the PATH. Tests set rt.gh instead. */
export const runGh = (args) =>
  new Promise((resolve) => {
    execFile(process.env.POSTBOX_GH_BIN || 'gh', args, { timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') }),
    );
  });

/**
 * Sends a finding’s issue, once you’ve seen its text (R19, steps 2 and 3). Returns what the page does next: nothing, or
 * copy this text and open this page.
 * @param {any} rt @param {string} id @param {string} key @param {{ hash?: string }} body
 */
export async function fileIssue(rt, id, key, { hash } = {}) {
  const { f, title, body, text, hash: now } = rendered(rt, id, key);
  if (hash !== now) throw httpError(409, 'The issue’s text isn’t the one you were shown, so Postbox didn’t send it. Look at it again.');
  const gh = rt.gh ?? runGh;
  if ((await gh(['auth', 'status'])).status !== 0) return { ok: true, copy: text, open: NEW_ISSUE, hash: now };
  const fp = fingerprintOf(f);
  const seen = await gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--search', `"${fp}" in:body`, '--json', 'number', '--limit', '5']);
  const dup = seen.status === 0 ? (JSON.parse(seen.stdout || '[]')[0]?.number ?? null) : null;
  if (dup) return { ok: true, duplicate: dup };
  let made = await gh(['issue', 'create', '--repo', REPO, '--title', title, '--body', body, '--label', 'uat', '--label', 'live']);
  // An account that can’t set labels files without them; the fingerprint marks it, and triage labels it.
  if (made.status !== 0 && /label/i.test(made.stderr)) made = await gh(['issue', 'create', '--repo', REPO, '--title', title, '--body', body]);
  if (made.status !== 0) throw httpError(502, `gh couldn’t file it: ${made.stderr.trim().slice(0, 300)}`);
  return { ok: true, filed: Number(made.stdout.trim().split('/').pop()) || null, url: made.stdout.trim(), hash: now };
}
