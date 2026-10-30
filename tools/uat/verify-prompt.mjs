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

The run’s records are in your working folder. The tester saw only the page, so they hold what it couldn’t: search them with Grep before you call a finding not-reproduced, a duplicate or the agent’s, and cite what you found (the file, and a line or a count).
- events.jsonl: the run’s history from Postbox’s event stream, one event a line: every item in the conversation as it was added, patched and moved, and each session’s state as it changed. state.json: Postbox’s whole state as the run ended, with each session’s context, the notices Postbox gave an agent for its next turn, and the messages it sent one agent from another (agentMessages, the latest six). An agent paraphrasing a notice means the notice is in state.json word for word. (Postbox’s store itself is in data/redis, which isn’t readable as text.)
- streams/: each agent turn’s raw stream, a file a turn named for its agent: its tool calls with their inputs, and each call’s result as the agent got it.
- run.log: each step’s action, and each one the runner held (“action held”). A held step didn’t happen as the tester asked: check here that the wait or move a finding relies on really ran.

Three readings the records need:
- What wake_agent answered says what Postbox did with that call. “Woke @x.” sent it; “Woke @x: it’s busy, so it answers when its current turn ends” queued it for x’s next turn, which isn’t a refusal; “… wasn’t sent: …” refused it. A notice “Your mention of @x woke no one: …” in a session’s context is about an @-mention in that agent’s reply, not about a wake_agent call: match a refusal to the call or mention it answers, by agent and time, before you call one reported as success.
- An open issue that proposes changing a behavior means the behavior isn’t by-design, even if a message tells agents to work around it: a finding about it is a duplicate of that issue, or related to it.
- Judge the claim a finding makes, not the defect nearby. When the records contradict its claim (it says a wake was refused, or reported as sent, and the call’s own answer says otherwise), it’s not-reproduced, even if another finding or an open issue covers a real defect close to it: say which in the note.

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
