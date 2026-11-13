// The attach-image scenario’s trigger (#1307, tests/uat/e2e/scenarios/attachimage.md; tools/uat/triggers.mjs has what
// a trigger is): the person attached the test picture (tests/uat/e2e/attachments/picture.png, an orange triangle with
// the word KIWI in it) and an agent’s reply after it names both, so it read the image itself. Its file name says
// neither, so an agent that couldn’t open it can’t name them from the message.

import { clip, itemsOf } from './trigger-facts.mjs';

/** What the test picture shows: a reply must name all of these. */
const SHOWN = [/\bkiwi\b/i, /triang/i];

const sentPicture = (it) => it.kind === 'user' && (it.attachments ?? []).some((a) => a?.kind === 'file' && /\.png$/i.test(String(a.name ?? '')));

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const ATTACH_IMAGE_TRIGGERS = {
  'attached-image-read': {
    issue: 1307,
    says: 'the person attached a PNG, and an agent’s reply after it named what the picture shows (a triangle with the word KIWI)',
    recorded: (f) => !!f.state,
    run: (f) => {
      const items = itemsOf(f);
      return items.flatMap((it, i) => {
        if (!sentPicture(it)) return [];
        const reply = items.slice(i + 1).find((x) => x.kind === 'agent' && x.threadId === it.threadId && SHOWN.every((re) => re.test(String(x.text ?? ''))));
        if (!reply) return [];
        return [{ at: Number.isFinite(reply.at) ? reply.at : null, evidence: `@${reply.handle} said: “${clip(String(reply.text).trim(), 120)}”` }];
      });
    },
  },
};
