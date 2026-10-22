// The tester: a model that plays the person using Postbox. Each step it reads what’s on screen, judges what
// the agents did, reports what’s wrong, and picks the next thing to do. It runs on the claude CLI you’re
// signed in to (no API key), isolated from your own Claude Code settings, with one tool: Read, for the
// screenshots the runner saves. One Claude Code session per run, resumed each step, so it remembers the run.

import { spawn } from 'node:child_process';

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
          issue: { type: ['integer', 'null'], description: 'The open GitHub issue this is, if it matches one in the list; otherwise null.' },
        },
        required: ['title', 'category', 'severity', 'component', 'evidence', 'issue'],
      },
    },
    action: {
      type: 'object',
      properties: {
        type: { enum: ['send', 'thread', 'act', 'app_click', 'attach_screenshot', 'full_screen', 'wait', 'next_phase', 'done'] },
        text: { type: 'string', description: 'send, thread, attach_screenshot: the message to write.' },
        item: { type: 'string', description: 'thread, act, app_click, attach_screenshot, full_screen: the item label, such as I7.' },
        fills: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'] } },
        choose: { type: 'array', items: { type: 'string' } },
        button: { type: 'string' },
        target: { type: 'string', description: 'app_click: the visible text to click inside the app.' },
        seconds: { type: 'integer' },
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

Judge every step, and report findings: anything a careful user would call wrong. That includes broken or confusing UI; errors; anything stuck, hidden or unreadable; agents doing the wrong thing, such as asking several questions as prose instead of a form, offering options in prose instead of a choice block, a broken or unreadable app, a claim without a source, or ignoring what you asked. Only report what you saw, with evidence. Report each problem once; don’t repeat a finding you already made. If it matches one of these open issues, give its number:
${issues.map((i) => `#${i.number} ${i.title}`).join('\n') || '(none listed)'}

Then choose one action:
- send {text}: a message in the conversation.
- thread {item, text}: reply in a topic thread on that message.
- act {item, fills?, choose?, button?}: use a block or card: fill fields by label, pick options by label, press a button by its text.
- app_click {item, target}: click something inside that app by its visible text.
- attach_screenshot {item, text}: attach a screenshot of that item, and send it with your message.
- full_screen {item}: press that app’s Expand button.
- wait {seconds}: when an agent is still working.
- next_phase: when this phase’s goal is met, or blocked after two honest tries.
- done: after the last phase.

Scenario: ${scenario.title}
${scenario.summary}`;
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
