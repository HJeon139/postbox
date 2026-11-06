// The switch bench’s report (#508, tools/bench-switch.mjs): a row per size, switch and measure, and the provenance a
// reader needs to rerun it. Pure, so tests feed it results.

import { conditionsLine } from './key-frame-report.mjs';
import { MEASURES, SHORT_ITEMS, SWITCHES } from './switch-measure.mjs';

/** Where the long rooms came from. @param {string | undefined} seed */
const seedName = (seed) =>
  seed === 'real'
    ? 'the real-shape seed (tools/uat/real-room.mjs, after #305’s measured room: its mix of kinds, a 1.5 KB median, an 87 KB largest)'
    : 'the big-room seed (tools/uat/big-room.mjs)';
const ms = (v) => (v === null ? 'none' : `${v.toFixed(1)} ms`);

/**
 * The report: a row per size, switch and measure with its runs’ p50, p95 and max, and the provenance.
 * @param {{ command: string, commit: string, date: string, machine: any, conditions: any, inputs: { sizes: number[], runs: number },
 *   results: any[] }} o
 */
export function formatReport({ command, commit, date, machine, conditions, inputs, results }) {
  const rows = results.flatMap((r) =>
    SWITCHES.flatMap((s) =>
      MEASURES.map(([key, label]) => {
        const v = r[s.name][key];
        return `| ${r.items.toLocaleString('en-US')} | ${s.label} | ${label} | ${v.n} | ${ms(v.p50)} | ${ms(v.p95)} | ${ms(v.max)} |`;
      }),
    ),
  );
  const counts = elementRows(results);
  return [
    '# Switching into a long conversation, by room size (#508)',
    '',
    'From a short conversation to the long room the big-room seed generates, by a click through Chromium’s input. Both times run from the click’s pointerdown:',
    '',
    '- **Last item drawn**: to the frame after the one that drew the long room’s last seeded item in the transcript’s visible box (rAF → rAF).',
    '- **Key’s next frame**: to the frame after a key typed into the long room’s composer as soon as its view is on the page (keydown → rAF → rAF).',
    '',
    'The project switch picks the long room’s project in the places menu, opened before the timer starts, and lands on its latest conversation, the long room. The conversation switch clicks the long room’s row in the rail, from a short room in its project. Every run checked it timed the long room, with every seeded item drawn.',
    '',
    'A report run by hand with `tools/bench-switch.mjs`; not a CI gate. Chromium only.',
    '',
    '| Items | Switch | Measure | Runs | p50 | p95 | Max |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: |',
    ...rows,
    ...counts,
    '',
    '## Provenance',
    '',
    `- Command: \`${command}\``,
    `- Inputs: long rooms of ${inputs.sizes.map((n) => n.toLocaleString('en-US')).join(', ')} items from ${seedName(inputs.seed)}; short rooms of ${SHORT_ITEMS} items; ${inputs.runs} run${inputs.runs === 1 ? '' : 's'} a switch, each in a fresh document`,
    `- Commit: ${commit}`,
    `- Date: ${date}`,
    `- Machine: ${machine.os}, ${machine.arch}, ${machine.cpu}; Node ${machine.node}; Chromium ${machine.chromium}`,
    `- Conditions: ${conditionsLine(conditions)}`,
    '',
  ].join('\n');
}

/**
 * The element counts after each switch settles (the median run): on the whole page, and in the long room’s
 * transcript, with the transcript’s count as a multiple of the smallest size’s. #508’s window keeps that multiple near
 * 1 however long the room is; building every item makes it grow with the room.
 * @param {any[]} results
 */
function elementRows(results) {
  if (!results.length || !results[0][SWITCHES[0].name].elements) return [];
  const n = (v) => v.toLocaleString('en-US');
  const rows = results.flatMap((r) =>
    SWITCHES.map((s) => {
      const base = results[0][s.name].elements.transcript;
      const { page, transcript } = r[s.name].elements;
      return `| ${n(r.items)} | ${s.label} | ${n(page)} | ${n(transcript)} | ${(transcript / base).toFixed(2)} |`;
    }),
  );
  return [
    '',
    '## Elements after the switch',
    '',
    "Counted once the page holds still after each run (`querySelectorAll('*')`), the median run. The ratio is the transcript’s count over the smallest size’s for the same switch.",
    '',
    '| Items | Switch | On the page | In the transcript | Transcript, × the smallest size |',
    '| ---: | --- | ---: | ---: | ---: |',
    ...rows,
  ];
}
