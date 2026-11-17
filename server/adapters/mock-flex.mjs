// The mock librarian’s part in the flexible-apps prototype (designs/prototypes/flexible-apps.md): it shows the demo
// and probe apps, and reads what an app shared with read_app when Postbox says at its next turn that it changed, or
// when the person clicks in the app.

import { netProbeApp, pulledChartApp, reachApp, readingListApp, sendProbeApp } from '../mock/flex-apps.mjs';

// The stand-in for another site (tools/probe-site.mjs), and the same server at this computer’s local network address.
const OTHER = process.env.POSTBOX_PROBE_OTHER ?? 'http://127.0.0.1:4518';
const LAN = process.env.POSTBOX_PROBE_LAN ?? 'http://192.168.0.2:4518';
const has = (text, re) => re.test(String(text ?? '').toLowerCase());

/** What a reading list’s rows say, in a sentence or two. @param {{ title: string, status: string, rating: number }[]} rows */
function aboutRows(rows) {
  const by = (s) => rows.filter((r) => r.status === s).map((r) => `*${r.title}*`);
  const rated = rows.filter((r) => r.rating > 0).sort((a, b) => b.rating - a.rating);
  const parts = [
    `${rows.length} books: ${by('Reading').length ? `reading ${by('Reading').join(', ')}` : 'nothing in progress'}`,
    by('Done').length ? `finished ${by('Done').join(', ')}` : '',
    by('To read').length ? `still to read ${by('To read').join(', ')}` : '',
  ].filter(Boolean);
  const top = rated[0] ? ` You rate *${rated[0].title}* highest (${rated[0].rating} of 5).` : '';
  return `${parts.join('; ')}.${top}`;
}

/** Reads an app the way a real agent would, and says what it found. @param {any} a @param {string} appId */
async function readAndSay(a, appId, lead) {
  await a.tool(`read_app ${appId}`, 300);
  const r = a.t.read_app({ appId });
  if (!r.ok) return a.say(r.message);
  const app = JSON.parse(r.message);
  if (appId === 'reading-list' && app.published?.rows) return a.say(`${lead} ${aboutRows(app.published.rows)}\n\n`);
  const notes = app.notes.length
    ? `It also sent ${app.notes.length} note${app.notes.length === 1 ? '' : 's'} on its own: ${app.notes.map((n) => `${n.action} ${JSON.stringify(n.values)}`).join('; ')}.\n\n`
    : '';
  return a.say(`${lead} ${app.title} published:\n\n\`\`\`json\n${JSON.stringify(app.published, null, 2).slice(0, 1500)}\n\`\`\`\n\n${notes}`);
}

/**
 * Handles a message that belongs to the prototype, and says whether it did. A notice that an app changed comes in the
 * turn’s batch, beside the person’s message, so it’s looked for anywhere in the message.
 * @param {any} m  the turn’s message @param {any} a  the mock’s kit
 */
export async function flexTurn(m, a) {
  if (m.kind === 'event' && m.event.blockId === 'reading-list') {
    await readAndSay(a, 'reading-list', 'You asked, so I read your list:');
    return true;
  }
  if (m.kind === 'event' && m.event.blockId === 'send-probe') {
    await a.say(`Got ${m.event.action} ${JSON.stringify(m.event.values)}.`);
    return true;
  }
  // The person’s own words, without Postbox’s notices, which name the app and would match its trigger.
  const text = String(m.text ?? '').replace(/\[app [^\]]+\][^\n]*/g, '');
  const changed = [...new Set([...JSON.stringify(m).matchAll(/\[app ([\w.:-]+)\]/g)].map((x) => x[1]))];
  if (changed.length && !has(text, /reading list|send probe|net probe|pulled chart|flexible apps/)) {
    for (const id of changed) await readAndSay(a, id, `Postbox told me ${id} changed, so I read it before answering.`);
    return true;
  }
  if (has(text, /flexible apps/)) {
    await flexTour(a);
    return true;
  }
  if (has(text, /reading list/)) {
    await a.think(300);
    await a.say('Here’s your reading list. Change anything: I read it at my next turn, without you sending it. The button asks me now.');
    a.t.show_app({ id: 'reading-list', title: 'Reading list', code: readingListApp(), fallback: 'A reading list you can edit.' });
    return true;
  }
  if (has(text, /send probe/)) {
    a.t.show_app({ id: 'send-probe', title: 'Send probe', code: sendProbeApp(), fallback: 'Buttons that send in each way an app can.' });
    return true;
  }
  if (has(text, /net probe/)) {
    const origin = process.env.POSTBOX_PROBE_POSTBOX ?? 'http://localhost:4517';
    a.t.show_app({
      id: `net-probe-${Date.now().toString(36)}`,
      title: 'Network probe',
      code: netProbeApp({ other: OTHER, lan: LAN, postbox: origin, popup: has(text, /popup/) }),
      permissions: ['net.fetch'],
      fallback: 'Security probes.',
    });
    return true;
  }
  if (has(text, /pulled chart/)) {
    a.t.show_app({
      id: 'pulled-chart',
      title: 'Visits by month',
      code: pulledChartApp({ other: OTHER }),
      permissions: ['net.fetch'],
      fallback: 'A chart of visits by month.',
    });
    return true;
  }
  return false;
}

/** The demo of what the prototype recommends, in one reply: 0 clicks, 1 click, a link, and public data through Postbox. */
async function flexTour(a) {
  await a.think(300);
  await a.say(
    'Here’s your reading list. **Edit it as you like**: every change is shared with me as you make it, with no button and no card, and I read it at my next turn. **Ask the librarian about my list** starts my turn at once, one click. **Look it up** opens Project Gutenberg in a new tab.\n\n',
  );
  a.t.show_app({ id: 'reading-list', title: 'Reading list', code: readingListApp(), fallback: 'A reading list you can edit.' });
  await a.say('This chart’s data comes from another site, fetched by Postbox for the app, with no cookies:\n\n');
  a.t.show_app({
    id: 'pulled-chart',
    title: 'Visits by month',
    code: pulledChartApp({ other: OTHER }),
    permissions: ['net.fetch'],
    fallback: 'A chart of visits by month.',
  });
  await a.say('And what an app can and can’t reach, tried live by the app itself:\n\n');
  const postbox = process.env.POSTBOX_PROBE_POSTBOX ?? 'http://localhost:4517';
  a.t.show_app({
    id: 'reach',
    title: 'What an app can reach',
    code: reachApp({ other: OTHER, postbox }),
    permissions: ['net.fetch'],
    fallback: 'What an app can reach.',
  });
}
