// The event builder: turns what you did in a block into the one event the agent receives,
// { blockId, action, values }, plus the short line shown in your voice ("Chose: weekly · Monday 9:00").
// It also validates form input and returns messages that say what to fix.

import { LIMITS, limitText } from './limits.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const fmtNum = (n) => Number(n).toLocaleString('en-US');

/**
 * @param {{ type: string, id: string, [field: string]: any }} block   a block that passed validateBlock, or an app
 * @param {string} action
 * @param {object} values
 * @returns {{ ok: true, event: { blockId: string, action: string, values: object }, voice: string }
 *         | { ok: false, error: string, fieldErrors?: Record<string, string> }}
 */
export function buildEvent(block, action, values = {}) {
  const build = BUILDERS[block?.type];
  if (!build) return { ok: false, error: `Blocks of type “${block?.type}” don’t take actions.` };
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: 'Values must be an object.' };
  const r = build(block, action, values);
  if (!r.ok) return r;
  return { ok: true, event: { blockId: block.id, action, values: r.values }, voice: r.voice };
}

const quote = (s, max = 60) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? t.slice(0, max - 1) + '…' : t}”`;
};

const BUILDERS = {
  choice(b, action, v) {
    if (action !== 'choose') return { ok: false, error: 'A choice only accepts the “choose” action.' };
    const selected = Array.isArray(v.selected) ? v.selected : [];
    const known = new Map(b.options.map((o) => [o.id, o.label]));
    for (const s of selected) if (!known.has(s)) return { ok: false, error: `“${s}” isn’t one of the options.` };
    if (new Set(selected).size !== selected.length) return { ok: false, error: 'An option was chosen twice.' };
    const other = typeof v.other === 'string' ? v.other.trim() : '';
    if (other && !b.other) return { ok: false, error: 'This choice doesn’t have an “other” field.' };
    const count = selected.length + (other ? 1 : 0);
    if (count === 0) return { ok: false, error: b.multiple ? 'Choose at least one option.' : 'Choose an option.' };
    if (!b.multiple && count > 1) return { ok: false, error: 'Choose only one option.' };
    if (b.multiple && b.max && count > b.max) return { ok: false, error: `Choose up to ${b.max}.` };
    if (other.length > 500) return { ok: false, error: 'Keep your answer under 500 characters.' };
    const labels = [...selected.map((s) => known.get(s)), ...(other ? [quote(other)] : [])];
    return { ok: true, values: { selected, ...(other ? { other } : {}) }, voice: `Chose: ${labels.join(' · ')}` };
  },

  form(b, action, v) {
    if (action !== 'submit') return { ok: false, error: 'A form only accepts the “submit” action.' };
    const out = {},
      fieldErrors = {};
    for (const f of b.fields) {
      const r = checkField(f, v[f.id]);
      if (r.error) fieldErrors[f.id] = r.error;
      else if (r.value !== undefined) out[f.id] = r.value;
    }
    for (const k of Object.keys(v)) if (!b.fields.some((f) => f.id === k)) return { ok: false, error: `“${k}” isn’t a field in this form.` };
    const n = Object.keys(fieldErrors).length;
    if (n) return { ok: false, error: n === 1 ? '1 field needs fixing.' : `${n} fields need fixing.`, fieldErrors };
    const shown = b.fields
      .filter((f) => out[f.id] !== undefined && out[f.id] !== '' && f.kind !== 'longtext')
      .slice(0, 2)
      .map(
        (f) =>
          `${f.label} ${f.kind === 'toggle' ? (out[f.id] ? 'on' : 'off') : f.kind === 'select' ? f.options.find((o) => o.id === out[f.id])?.label : f.kind === 'number' ? fmtNum(out[f.id]) : quote(out[f.id], 32)}`,
      );
    return { ok: true, values: out, voice: `Sent: ${b.title ?? 'form'}${shown.length ? ' · ' + shown.join(' · ') : ''}` };
  },

  table(b, action, v) {
    if (!b.rowAction || action !== b.rowAction.id) return { ok: false, error: 'This table has no such row action.' };
    const row = b.rows.find((r) => r.id === v.rowId);
    if (!row) return { ok: false, error: `There’s no row “${v.rowId}”.` };
    const first = row.cells[b.columns[0].id];
    return { ok: true, values: { rowId: row.id }, voice: `${b.rowAction.label}: ${first ?? row.id}` };
  },

  card(b, action, _v) {
    const a = (b.actions ?? []).find((x) => x.id === action);
    if (!a) return { ok: false, error: 'This card has no such action.' };
    return { ok: true, values: {}, voice: b.title ? `${a.label} · ${b.title}` : a.label };
  },

  confirm(b, action) {
    if (action === 'confirm') return { ok: true, values: {}, voice: `Confirmed: ${b.confirmLabel}` };
    if (action === 'cancel') return { ok: true, values: {}, voice: `Didn’t confirm: ${b.cancelLabel ?? b.title ?? b.confirmLabel}` };
    return { ok: false, error: 'A confirm only accepts “confirm” or “cancel”.' };
  },

  review(_b, action, v) {
    if (action !== 'submit') return { ok: false, error: 'A review only accepts the “submit” action.' };
    const verdicts = { comment: 'Comment', approve: 'Approve', request_changes: 'Request changes' };
    if (!(v.verdict in verdicts)) return { ok: false, error: 'Pick a verdict: comment, approve or request changes.' };
    const comments = Array.isArray(v.comments) ? v.comments : [];
    for (const c of comments) {
      if (typeof c?.text !== 'string' || !c.text.trim()) return { ok: false, error: 'A comment is empty.' };
      if (c.line === undefined && c.anchor === undefined && c.threadId === undefined)
        return { ok: false, error: 'Each comment needs a line, an anchor or a thread.' };
    }
    if (v.verdict !== 'approve' && comments.length === 0) return { ok: false, error: 'Add a comment, or approve.' };
    const n = comments.length;
    return {
      ok: true,
      values: { verdict: v.verdict, comments },
      voice: `Submitted review: ${verdicts[v.verdict]}${n ? ` · ${n} comment${n === 1 ? '' : 's'}` : ''}`,
    };
  },

  app(b, action, v) {
    if (!ID.test(action)) return { ok: false, error: 'An app action must be a short id.' };
    let size = 0;
    try {
      size = JSON.stringify(v).length;
    } catch {
      return { ok: false, error: 'App values must be plain JSON.' };
    }
    if (size > LIMITS.eventBytes) return { ok: false, error: `App values are larger than ${limitText('eventBytes')}.` };
    const { summary, ...values } = v;
    const what = typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 160) : action;
    return { ok: true, values, voice: `Sent from ${b.title ?? 'the app'}: ${what}` };
  },
};

function checkField(f, raw) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim());
  if (f.kind === 'toggle') {
    if (empty) return { value: f.default === true };
    return typeof raw === 'boolean' ? { value: raw } : { error: 'Turn this on or off.' };
  }
  if (empty) return f.required ? { error: 'This field is required.' } : { value: undefined };
  switch (f.kind) {
    case 'number': {
      // Plain decimal only: Number() would also read “0x10” as 16 and “1e3” as 1000.
      const t = String(raw).replace(/,/g, '').trim();
      const n = typeof raw === 'number' ? raw : /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : Number.NaN;
      const hasMin = typeof f.min === 'number',
        hasMax = typeof f.max === 'number';
      const range =
        hasMin && hasMax
          ? `Enter a number from ${fmtNum(f.min)} to ${fmtNum(f.max)}.`
          : hasMin
            ? `Enter a number of at least ${fmtNum(f.min)}.`
            : hasMax
              ? `Enter a number no more than ${fmtNum(f.max)}.`
              : 'Enter a number.';
      if (!Number.isFinite(n)) return { error: range };
      if ((hasMin && n < f.min) || (hasMax && n > f.max)) return { error: range };
      if (typeof f.step === 'number' && f.step > 0 && Math.abs((n - (f.min ?? 0)) / f.step - Math.round((n - (f.min ?? 0)) / f.step)) > 1e-9)
        return { error: `Use steps of ${fmtNum(f.step)}.` };
      return { value: n };
    }
    case 'date': {
      const s = String(raw).trim();
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return { error: 'Enter a date as YYYY-MM-DD, for example 2026-10-27.' };
      if (typeof f.min === 'number' || typeof f.max === 'number') return { value: s };
      return { value: s };
    }
    case 'select':
      return f.options.some((o) => o.id === raw) ? { value: raw } : { error: 'Choose one of the options.' };
    default: {
      if (typeof raw !== 'string') return { error: 'Enter text.' };
      const max = f.maxLength ?? (f.kind === 'longtext' ? 20000 : 500);
      if (raw.length > max) return { error: `Keep this under ${fmtNum(max)} characters.` };
      if (f.required && !raw.trim()) return { error: 'This field is required.' };
      return { value: raw };
    }
  }
}
