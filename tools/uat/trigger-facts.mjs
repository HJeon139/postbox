// Helpers the triggers share (tools/uat/triggers.mjs, tools/uat/allowonce-triggers.mjs): a line of evidence cut to
// length, the room's items, a tool result's text, and a table cell for the report (tools/uat/report.mjs).

import { clip as clipTo } from '../../shared/text.mjs';

export const clip = (s, n = 120) => clipTo(s, n);
/** Text for a Markdown table cell: `\` is escaped with `|`, so a backslash in it can’t unescape a pipe (#346). */
export const cell = (s) =>
  String(s ?? '')
    .replace(/[\\|]/g, '\\$&')
    .replace(/\n/g, ' ');
export const itemsOf = (f) => (f.threads ?? []).flatMap((t) => (f.state?.items?.[t] ?? []).map((it) => ({ ...it, threadId: t })));
export const resultText = (r) =>
  typeof r?.content === 'string'
    ? r.content
    : Array.isArray(r?.content)
      ? r.content
          .map((c) => (typeof c?.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
