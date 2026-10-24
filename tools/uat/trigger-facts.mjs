// Helpers the triggers share (tools/uat/triggers.mjs, tools/uat/allowonce-triggers.mjs): a line of evidence cut to
// length, the room's items, and a tool result's text.

import { clip as clipTo } from '../../shared/text.mjs';

export const clip = (s, n = 120) => clipTo(s, n);
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
