// What the verifier is asked after a run (tools/uat/review.mjs), and the shape of its answer.

// After a run, every new finding is verified before it’s filed: is it a defect in Postbox, a problem in the
// harness, not reproducible, a duplicate of an open issue, or a flaw in the agent’s own work? Only confirmed
// Postbox defects are filed, written up with the bug template.
export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { enum: ['confirmed', 'duplicate', 'harness', 'agent', 'by-design', 'not-reproduced'] },
          duplicateOf: { type: ['integer', 'null'] },
          note: { type: 'string', description: 'Why, in one or two sentences.' },
          title: { type: 'string', description: 'confirmed: the issue title, a plain statement of the defect.' },
          component: { type: 'string' },
          urgency: { type: 'string', description: 'confirmed: “High”, “Medium” or “Low”, then a sentence on the impact.' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'string' },
          actual: { type: 'string' },
          cause: { type: 'string', description: 'The suspected cause, if the evidence shows it; otherwise empty.' },
        },
        required: ['index', 'verdict', 'duplicateOf', 'note', 'title', 'component', 'urgency', 'steps', 'expected', 'actual', 'cause'],
      },
    },
  },
  required: ['results'],
};

export function verifyPrompt({ scenario, findings, timeline, issues }) {
  return `You are reviewing findings from an automated end-to-end test of Postbox, before they are filed as GitHub issues. Be skeptical: a false issue costs more than a missed one.

The scenario was “${scenario.title}”. A tester model played the person, driving the UI through a runner. The runner itself can be wrong: its screenshots, its reading of the page, or its own actions (it presses Stop on a turn that runs too long, and Stop or Send now when the tester’s action asks it to). Open screenshots with the Read tool when a finding names one.

For each finding, give a verdict:
- confirmed: a real defect or UX problem in Postbox, supported by the evidence.
- duplicate: an open issue already covers it (give its number in duplicateOf). Related isn’t duplicate: say so in the note instead. When the tester matched a finding to an issue, check that the issue really covers it.
- harness: caused by the test runner, not by Postbox.
- agent: a flaw in the agent’s own reasoning or content (a wrong number, a weak plan) that Postbox didn’t cause.
- by-design: Postbox does this on purpose, as its docs or the agent guide say.
- not-reproduced: the evidence doesn’t support it.

For confirmed findings, write the issue:
- a plain title stating the defect
- the component
- the urgency, with its impact
- steps a person can follow in Postbox, not in the runner
- what was expected
- what happened instead, with the evidence
- the suspected cause, if the evidence shows it

Write in plain American English, with curly quotes, in sentence case.

Findings:
${findings.map((f, i) => `[${i}] ${f.title} (${f.category ?? 'check'}, ${f.severity ?? '—'}, ${f.component ?? f.check}; step ${f.step}, ${f.phase ?? ''})${f.issue ? `\nThe tester matched it to #${f.issue}.` : ''}\nEvidence: ${f.evidence}${f.expected ? `\nExpected: ${f.expected}` : ''}`).join('\n\n')}

What the tester did, step by step:
${timeline.map((t) => `${t.step}. ${t.phase}: ${t.assessment} Then: ${JSON.stringify(t.action)}`).join('\n')}

Open issues:
${issues.map((i) => `#${i.number} ${i.title}`).join('\n')}`;
}
