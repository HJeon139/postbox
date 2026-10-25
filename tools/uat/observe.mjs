// What changed on screen since the tester last looked, as the runner shows it each step: every item by its label (I1,
// I2…), with its text, buttons and fields, a screenshot of each block and app, and what’s inside each app; then each
// agent’s state.

import { join, relative } from 'node:path';

/** What changed on screen, labeled for the tester, and each agent’s state. */
export async function observe({ d, labels, keys, seen, paths, timeline, dir, facts }) {
  const out = [];
  const items = await d.items();
  for (const it of items) {
    if (!labels.has(it.key)) {
      const l = `I${labels.size + 1}`;
      labels.set(it.key, l);
      keys.set(l, it.key);
    }
    if (seen.get(it.key) === it.text) continue;
    const changed = seen.has(it.key);
    seen.set(it.key, it.text);
    const label = labels.get(it.key);
    const lines = [
      `[${label}] ${changed ? '(changed) ' : ''}${it.where}${it.block ? ` · ${it.block}` : ''}${it.app ? ' · agent app' : ''}${it.diagram ? ' · diagram' : ''}`,
    ];
    lines.push(it.text.length > 1800 ? `${it.text.slice(0, 1800)}…` : it.text);
    if (it.buttons.length) lines.push(`Buttons: ${it.buttons.join(' | ')}`);
    if (it.fields.length) lines.push(`Fields: ${it.fields.join(' | ')}`);
    if (it.block || it.app || it.diagram || it.math) {
      const shot = await d.shotItem(it.key, join(paths.shots, `${String(timeline.length).padStart(2, '0')}-${label}.png`));
      if (shot) lines.push(`Screenshot: ${relative(dir, shot)}`);
    }
    if (it.app) {
      const inside = await d.appInside(it.key);
      facts.apps[it.key] = inside;
      if (inside) lines.push(`Inside the app: ${inside.text.slice(0, 700)}`);
      else lines.push('Inside the app: (couldn’t be read)');
    }
    out.push(lines.join('\n'));
  }
  const st = facts.state;
  const states = facts.threads
    .flatMap((t) => st.threads[t]?.members ?? [])
    .map((id) => st.sessions[id])
    .filter(Boolean)
    .map((se) => `@${se.handle} in “${st.threads[se.threadId]?.title}”: ${se.state}${se.needs ? ` (needs you: ${se.needs.text})` : ''}`);
  return { items: out, states };
}
