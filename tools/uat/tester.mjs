// The tester: a model that plays the person using Postbox. Each step it reads what’s on screen, judges what
// the agents did, reports what’s wrong, and picks the next thing to do. It runs on the claude CLI you’re
// signed in to (no API key), isolated from your own Claude Code settings but for how it signs in, with one tool: Read, for the
// screenshots the runner saves. One Claude Code session per run, resumed each step, so it remembers the run.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMentions } from '../../shared/text.mjs';
import { TELEMETRY_ACTION } from './telemetry-action.mjs';

/**
 * How the person’s Claude Code signs in, taken from their user settings, so the tester keeps it while it leaves the
 * rest of their setup out (`--setting-sources project`). On a machine that reaches Claude through Bedrock, the
 * credentials come from a command in the user settings (awsCredentialExport, awsAuthRefresh), and the model names
 * from modelOverrides: without them, the tester fell back to the default AWS credentials, whose token had expired,
 * while `claude -p` in a terminal worked. Only those keys, and the sign-in variables of `env`, are kept.
 * @param {{ read?: (path: string) => string, dir?: string }} [opts]  injected by tests
 * @returns {Record<string, unknown>}
 */
export function signInSettings({ dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), read = (p) => readFileSync(p, 'utf8') } = {}) {
  let user;
  try {
    user = JSON.parse(read(join(dir, 'settings.json')));
  } catch {
    return {};
  }
  if (!user || typeof user !== 'object') return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ['awsCredentialExport', 'awsAuthRefresh', 'apiKeyHelper', 'modelOverrides']) if (user[k] !== undefined) out[k] = user[k];
  const env = Object.fromEntries(
    Object.entries(user.env && typeof user.env === 'object' ? user.env : {}).filter(([k]) => /^(?:AWS_|ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k)),
  );
  if (Object.keys(env).length) out.env = env;
  return out;
}
/**
 * `--settings` with the sign-in, when the person’s settings have one. It goes in a file only this user can read,
 * written once per run and removed when the run exits, not inline: an inline value shows in the process list for as
 * long as the tester runs, and `env` can hold a key.
 */
let signInFile;
const signIn = () => {
  if (signInFile === undefined) {
    const s = signInSettings();
    signInFile = null;
    if (Object.keys(s).length) {
      const dir = mkdtempSync(join(tmpdir(), 'postbox-uat-'));
      signInFile = join(dir, 'settings.json');
      writeFileSync(signInFile, JSON.stringify(s), { mode: 0o600 });
      const remove = () => rmSync(dir, { recursive: true, force: true });
      process.once('exit', remove);
      // Ctrl+C or a kill skips 'exit': remove it, then let the signal end the run as it would have.
      for (const sig of ['SIGINT', 'SIGTERM'])
        process.once(sig, () => {
          remove();
          process.kill(process.pid, sig);
        });
    }
  }
  return signInFile ? ['--settings', signInFile] : [];
};

/**
 * The agent a message addresses by name without its @, as in “critic: what’s your concern?”: Postbox sends a message
 * that @-mentions no one to the agent that spoke last, so this one may not reach the critic. Only a name that opens
 * the message, followed by “:” or “,”, counts: “what did the researcher find?” is meant for whoever spoke last.
 * Nothing when the message @-mentions anyone (read as Postbox reads mentions, shared/text.mjs), or when the agent
 * it names spoke last, since the message reached it anyway.
 * @param {string} text  @param {string[]} handles  @param {{ lastSpeaker?: string|null }} [opts]  the last speaker’s handle
 * @returns {string[]}
 */
export function unaddressed(text, handles, { lastSpeaker = null } = {}) {
  if (parseMentions(text, handles).length) return [];
  const name = /^\s*([A-Za-z0-9_-]+)\s*[:,]/.exec(String(text ?? ''))?.[1]?.toLowerCase();
  const h = handles.find((x) => x.toLowerCase() === name);
  return h && h !== lastSpeaker ? [h] : [];
}

export const SCHEMA = {
  type: 'object',
  properties: {
    assessment: { type: 'string', description: 'One or two sentences on what the agents just did, judged as the person.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { enum: ['bug', 'ux', 'agent'] },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          component: { type: 'string', description: 'The part of Postbox, such as “agent app”, “form block”, “composer”, “topic thread”.' },
          evidence: { type: 'string', description: 'What you saw: quote the text, or name the screenshot.' },
          expected: { type: 'string', description: 'What a person would have expected instead.' },
          issue: { type: ['integer', 'null'], description: 'The open GitHub issue this is, if it matches one in the list; otherwise null.' },
        },
        required: ['title', 'category', 'severity', 'component', 'evidence', 'expected', 'issue'],
      },
    },
    action: {
      type: 'object',
      properties: {
        type: {
          enum: [
            'send',
            'send_then_stop',
            'thread',
            'thread_reply',
            'act',
            'review',
            'settings',
            'app_click',
            'attach_screenshot',
            'full_screen',
            'jobs',
            'wait',
            'stop',
            'agent_panel',
            'pane',
            'fullscreen',
            'fullscreen_draft',
            'restore',
            'next_phase',
            'telemetry',
            'done',
          ],
        },
        telemetry: TELEMETRY_ACTION,
        text: { type: 'string', description: 'send, send_then_stop, thread, thread_reply, attach_screenshot: the message to write.' },
        item: { type: 'string', description: 'thread, act, app_click, attach_screenshot, full_screen: the item label, such as I7.' },
        fills: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'] } },
        choose: { type: 'array', items: { type: 'string' } },
        button: { type: 'string' },
        target: {
          type: 'string',
          description: 'app_click: the visible text to click inside the app. settings, agent_panel: the agent’s handle. restore: the file’s name.',
        },
        model: { type: 'string', description: 'agent_panel: the model to pick, as the panel names it.' },
        effort: { type: 'string', description: 'agent_panel: the effort to pick.' },
        mode: { type: 'string', description: 'agent_panel: the permission mode to pick.' },
        shell: { type: 'boolean', description: 'agent_panel: turn the Shell switch on or off.' },
        open: { enum: ['work', 'thread'], description: 'pane: the view to open in the right pane.' },
        pane: { enum: ['work', 'thread'], description: 'fullscreen: the view to open full screen.' },
        permissions: { type: 'boolean', description: 'settings: also open its permissions panel.' },
        seconds: { type: 'integer' },
        verdict: { enum: ['approve', 'request_changes', 'comment'], description: 'review: your verdict.' },
        comments: {
          type: 'array',
          description: 'review: comments on lines, by the line number shown beside each line.',
          items: { type: 'object', properties: { line: { type: 'string' }, text: { type: 'string' } }, required: ['line', 'text'] },
        },
        answer: { enum: ['stop', 'keep'], description: 'jobs: stop the background jobs too, or keep them running.' },
        interrupt: {
          type: 'object',
          description: 'send, thread, act, review: act while the turn this starts is running.',
          properties: {
            after: { type: 'integer', description: 'Seconds to let the agent work first.' },
            do: { enum: ['stop', 'send_now', 'answer'] },
            jobs: { enum: ['stop', 'keep'], description: 'stop: how to answer if Postbox asks whether to stop background jobs too.' },
            text: { type: 'string', description: 'send_now: the message to send.' },
            item: { type: 'string', description: 'answer: the block to answer while the agent works, such as I7.' },
            verdict: { enum: ['approve', 'request_changes', 'comment'], description: 'answer, on a review: your verdict.' },
            comments: {
              type: 'array',
              description: 'answer, on a review: comments on lines.',
              items: { type: 'object', properties: { line: { type: 'string' }, text: { type: 'string' } }, required: ['line', 'text'] },
            },
            choose: { type: 'array', items: { type: 'string' }, description: 'answer, on a choice: the options to pick.' },
            button: { type: 'string', description: 'answer, on any other block: the button to press.' },
          },
          required: ['after', 'do'],
        },
      },
      required: ['type'],
    },
  },
  required: ['assessment', 'findings', 'action'],
};

export function systemPrompt({ scenario, issues }) {
  return `You are testing Postbox, a local web app where one person directs several AI agents in conversations. Agents answer with Markdown, with UI blocks (choice, form, table, progress, card, confirm, image, code, review), and with apps they write, which run in a sandboxed frame. Any message can start a topic thread in a side panel, where the agent is a fork of itself at that message.

You play the person: ${scenario.persona}

Work through the scenario’s phases as that person would. Write short, natural messages. Use the product the way it’s meant to be used:
- Answer blocks through their controls, not by typing the answer into the composer.
- When an agent gets something wrong, or you have a side question about something it said, open a topic thread on that message instead of derailing the conversation.
- Try what’s on screen at least once over the run: an app’s Expand button, clicking inside an app, sending something from an app to the agent, attaching a screenshot when you ask about something visual, permission or refusal cards.

Each step you get what changed on screen: items labeled I1, I2… with their visible text, their buttons and fields, and screenshots you can open with the Read tool. You also get each agent’s state, and what the automatic checks found.

Judge every step, and report findings: anything a careful user would call wrong. Say what you expected instead. That includes broken or confusing UI; errors; anything stuck, hidden or unreadable; agents doing the wrong thing, such as asking several questions as prose instead of a form, offering options in prose instead of a choice block, a broken or unreadable app, a claim without a source, or ignoring what you asked. Only report what you saw, with evidence. Report each problem once; don’t repeat a finding you already made. If it matches one of these open issues, give its number:
${issues.map((i) => `#${i.number} ${i.title}`).join('\n') || '(none listed)'}

Then choose one action:
- send {text}: a message in the conversation. To talk to an agent, write its handle with the @, as in “@critic, what’s your biggest concern?”. “critic: …” or the bare name isn’t addressing: a message that @-mentions no agent goes to whichever agent spoke last.
- send_then_stop {text, seconds?}: send a message, wait that many seconds (default 2), then press Stop on the active reply. Use this for a deliberate cancellation check.
- thread {item, text}: reply in a topic thread on that message, which opens it in the right pane.
- thread_reply {text}: reply in the thread that’s open in the right pane. Messages inside the pane have no “Reply in thread” of their own.
- act {item, fills?, choose?, button?}: use a block or card: fill fields by label, pick options by label, press a button by its text. A wake request (“Let @a wake @b?”) is a card: allow it or not with its button.
- review {item, verdict, comments}: answer a review block. Approve only what you’d sign off as it is. Otherwise request changes, with at least one comment on a line saying what to change; comment, with comments, when you only have questions.
- settings {target, permissions?}: open Settings › Personas and edit that agent (target is its handle), to see what it runs on, its model, permissions and setup; with permissions, also open its permissions panel. You get what they say and their screenshots; they close after.
- agent_panel {target, model?, effort?, mode?, shell?}: open that agent’s row in the sidebar’s Agents section, set what you give, and close it. You get what the panel says, including each setting’s scope.
- pane {open: work|thread, item?}: open Work (its top-bar button) or a thread in the right pane. You get each view’s size.
- fullscreen {pane: work|thread}: open that view full screen, read it, and close it with Escape.
- fullscreen_draft {text}: open the thread full screen, type text into its reply box without sending, and leave full screen. You get whether the draft and the scroll survived.
- restore {target}: in Work full screen, restore (or remove) that file, and confirm.
- app_click {item, target}: click something inside that app by its visible text.
- attach_screenshot {item, text}: attach a screenshot of that item, and send it with your message.
- full_screen {item}: press that app’s Expand button.
- jobs {answer}: answer Postbox’s question about an agent’s background jobs, when it’s on screen: stop (“Stop it too”) or keep (“Keep running”).
- wait {seconds}: when an agent is still working.
- stop: press Stop on a reply that is currently working, if one is visible.
- telemetry {telemetry: {do, …}, item?}: record (Record this room in the ⋯ menu; you get the header), stop, react {emoji} to item, report {history} (Telemetry report… then Make report; you get every line of the report and its hash), leave_out {line}, save, file {finding} (File issue: you get the text it showed and what Postbox did with it).
- next_phase: when this phase’s goal is met, or blocked after two honest tries.
- done: after the last phase.

Each step also lists what’s waiting on you: blocks that ask you something, review drafts, wake requests, permission cards, failed turns to retry. Answer them before you move to the next phase or finish, as a person clearing “needs you” would: an agent that asked is stuck until you do. If one isn’t on screen, open the thread it’s in.

The run waits for the agents to finish before each step. To act while a turn is running, give send, thread, act or review an interrupt {after, do, jobs?, text?}: once an agent is working, the run lets it work for after seconds, then does it. do is stop, to press Stop (if Postbox asks whether to stop its background jobs too, jobs answers: stop or keep); send_now, to write text and press Send now on it; or answer, to answer the block item while the agent works, as review (verdict, comments) or act (choose, button) would. Answer a draft that way while its agent is revising it, as a person reading along would.

Scenario: ${scenario.title}
${scenario.summary}`;
}

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

/** One-off structured call, in a fresh session (used to verify findings). */
export function askOnce({ cwd, model, prompt, schema, budgetUsd = 2 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--json-schema',
      JSON.stringify(schema),
      '--tools',
      'Read',
      '--setting-sources',
      'project',
      ...signIn(),
      '--max-budget-usd',
      String(budgetUsd),
    ];
    const child = spawn(process.env.POSTBOX_CLAUDE_BIN ?? 'claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      try {
        const r = JSON.parse(out);
        if (r.is_error || !r.structured_output) return reject(new Error(r.result || 'No answer.'));
        resolve({ value: r.structured_output, cost: r.total_cost_usd ?? 0 });
      } catch {
        reject(new Error(`No answer: ${out.slice(-300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

/**
 * @param {{ cwd: string, model: string, budgetUsd: number, log: (line: string) => void }} opts
 */
export function createTester({ cwd, model, budgetUsd, log }) {
  let session = null;
  let spent = 0;
  const ask = (prompt, system) =>
    new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--model',
        model,
        '--json-schema',
        JSON.stringify(SCHEMA),
        '--tools',
        'Read',
        '--setting-sources',
        'project',
        ...signIn(),
        '--permission-mode',
        'default',
        '--max-budget-usd',
        String(Math.max(0.5, budgetUsd - spent)),
        ...(session ? ['--resume', session] : ['--system-prompt', system]),
      ];
      const child = spawn(process.env.POSTBOX_CLAUDE_BIN ?? 'claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', () => {
        try {
          const r = JSON.parse(out);
          spent += r.total_cost_usd ?? 0;
          session = r.session_id ?? session;
          if (r.is_error || !r.structured_output) return reject(new Error(r.result || 'The tester gave no answer.'));
          resolve(r.structured_output);
        } catch {
          reject(new Error(`The tester didn’t answer: ${(err || out).slice(-400)}`));
        }
      });
      child.stdin.end(prompt);
    });
  return {
    get spent() {
      return spent;
    },
    async step(prompt, system) {
      try {
        return await ask(prompt, system);
      } catch (e) {
        log(`tester error, retrying once: ${e.message}`);
        return ask(`${prompt}\n\n(Your last answer couldn’t be read. Answer again in the required shape.)`, system);
      }
    },
  };
}
