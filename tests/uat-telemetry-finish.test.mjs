// #833: a UAT run that couldn’t open the Telemetry report at its end crashed before writing report.md, findings.json
// or run.json, so the tester’s findings, the verifier and the cost were lost. Telemetry is one record of the run: its
// failure is now a finding, and the run goes on to write the rest.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishTelemetry } from '../tools/uat/telemetry-run.mjs';

test('a telemetry step that fails leaves a finding and returns, so the run still writes its records', async () => {
  const findings = new Map();
  const lines = [];
  const td = {
    react: async () => {},
    report: async () => {
      throw new Error('Couldn’t find “Telemetry report” in the ⋯ menu on screen.');
    },
  };
  const shown = { views: [], saved: [] };
  const out = await finishTelemetry({
    td,
    flags: [{ item: 'it_1', key: 'k' }],
    dir: '/nowhere',
    data: '/nowhere',
    main: 'th_1',
    shown,
    log: (l) => lines.push(l),
    findings,
  });
  assert.equal(out, null);
  assert.deepEqual(findings.get('telemetry-failed'), {
    source: 'run',
    check: 'telemetry',
    issue: null,
    title: 'The run couldn’t finish its telemetry report',
    evidence: 'Couldn’t find “Telemetry report” in the ⋯ menu on screen.',
  });
  assert.match(lines.at(-1), /^Telemetry: couldn’t finish: Couldn’t find/);
});
