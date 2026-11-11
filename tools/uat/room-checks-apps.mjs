// Agents’ apps and attachments, as the page shows them: what an app draws, its versions and its check, full screen,
// and an attached image. Part of tools/uat/room-checks.mjs’s CHECKS, kept apart for size.

import { clip } from '../../shared/text.mjs';
import { SLACK_MS } from './room-history.mjs';

export const APP_CHECKS = [
  {
    id: 'app-shows-missing-data',
    inputs: ['apps'],
    issue: 47,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(([, a]) => /isn[’']t loaded|not loaded|restart postbox|failed to load|no data (?:yet|found)|couldn[’']t load/i.test(a?.text ?? ''))
        .map(([key, a]) => ({ key, title: 'An app that passed its check shows only a missing-data message', evidence: `“${clip(a.text, 160)}”` })),
  },
  {
    id: 'unreadable-app-marks',
    inputs: ['apps'],
    issue: 53,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(
          ([, a]) => a && ((a.tinyMarks >= 50 && a.tinyMarks / Math.max(1, a.marks) > 0.3) || (a.tinyText >= 5 && a.tinyText / Math.max(1, a.svgText) > 0.3)),
        )
        .map(([key, a]) => ({
          key,
          title: 'An app draws marks or text too small to read, and passed its check',
          evidence: `${a.tinyMarks} of ${a.marks} SVG marks under 4 px; ${a.tinyText} of ${a.svgText} SVG labels under 9 px.`,
        })),
  },
  {
    id: 'mixed-font-stacks',
    inputs: ['apps'],
    issue: 44,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(([, a]) => (a?.fonts ?? []).filter((x) => !/mono/i.test(x)).length > 1)
        .map(([key, a]) => ({
          key,
          title: 'An app mixes font stacks, so its text renders in different families where the stacks resolve differently (Firefox)',
          evidence: a.fonts.filter((x) => !/mono/i.test(x)).join(' | '),
        })),
  },
  {
    id: 'status-colors-for-categories',
    inputs: ['state', 'threads'],
    issue: 52,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId))
        .filter((app) => {
          const code = app.versions?.[app.current - 1]?.code ?? '';
          return /var\(--(?:good|alert|warn)\)/.test(code) && !/--s[1-8]\b/.test(code);
        })
        .map((app) => ({
          key: app.id,
          title: 'An app colors categories with status colors',
          evidence: `“${app.title}” uses --good/--alert and none of --s1…--s8.`,
        })),
  },
  {
    // Since #49’s fix, a new version brings the app to the newest point (item.move sets movedAt), and every later
    // message pushes it up again: no finding (#213). An app its last version didn’t move, with anything from before
    // that version under it, is the defect. A version with no time counts every item after the app, as before.
    id: 'updated-app-far-up',
    inputs: ['state', 'threads'],
    issue: 49,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && app.versions?.length > 1)
        .flatMap((app) => {
          const list = f.state.items[app.threadId] ?? [];
          const at = list.findIndex((it) => it.id === app.itemId);
          const landed = app.versions.at(-1)?.at;
          const timed = Number.isFinite(landed);
          if (at < 0 || (timed && Number.isFinite(list[at].movedAt) && list[at].movedAt >= landed - SLACK_MS)) return [];
          const up = list.slice(at + 1).filter((it) => !timed || !(it.at > landed)).length;
          if (up < (timed ? 1 : 6)) return [];
          return [
            {
              key: app.id,
              title: 'An updated app stays where it was first shown, far above the conversation',
              evidence: `“${app.title}” is v${app.versions.length}, ${up} message${up === 1 ? '' : 's'} up when that version landed, and that version didn’t move it.`,
            },
          ];
        }),
  },
  {
    id: 'version-menu-overflow',
    inputs: ['state', 'threads'],
    issue: 36,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && app.versions?.length >= 15)
        .map((app) => ({
          key: app.id,
          title: 'An app has enough versions to overflow its version menu',
          evidence: `“${app.title}” has ${app.versions.length} versions.`,
        })),
  },
  {
    id: 'check-starved',
    inputs: ['state', 'threads'],
    issue: 37,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && (app.check?.problems ?? []).some((p) => p.code === 'no-answer'))
        .map((app) => ({
          key: app.id,
          title: 'An app’s check timed out and is stored as “shown with problems”',
          evidence: `“${app.title}”: ${clip(app.check.problems[0].message)}`,
        })),
  },
  {
    id: 'full-screen-noop',
    inputs: ['probes'],
    issue: 45,
    run: (f) =>
      (f.probes?.fullScreen ?? [])
        // Full screen fills the window; a frame that only grows taller in the column isn’t that.
        .filter((p) => p.before && p.after && (p.after.w < p.viewport.w * 0.9 || p.after.h < p.viewport.h * 0.8))
        .map((p) => ({
          key: p.key,
          title: 'An app’s Expand button doesn’t show it full screen',
          evidence: `The frame went from ${p.before.w}×${p.before.h} to ${p.after.w}×${p.after.h} in a ${p.viewport.w}×${p.viewport.h} window.`,
        })),
  },
  {
    id: 'image-not-shown',
    inputs: ['probes'],
    issue: 48,
    run: (f) =>
      (f.probes?.attachments ?? [])
        .filter((a) => a.attachments > 0 && a.images === 0)
        .map((a) => ({
          key: a.key,
          title: 'An attached image shows as a file chip, not the image',
          evidence: `${a.attachments} attachment, 0 images rendered.`,
        })),
  },
];
