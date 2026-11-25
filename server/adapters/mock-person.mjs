// A scripted person (#558, prototype): what fills a person’s seat in the demo and the tests, as the mock agent fills
// an agent’s. It has the adapter’s interface (server/adapters/adapter.mjs) and writes through the same harness events
// (server/harness-events.mjs), so nothing about a person’s seat is a second kind of chat.

import { HarnessEvents } from '../harness-events.mjs';

const LINES = [
  { when: /edition|preface/i, say: 'keep the 1874 one-volume text, and treat “Introduction” as a preface.' },
  { when: /plan|outline/i, say: 'the plan reads fine to me. Go ahead.' },
  { when: /./, say: 'got it. I’ll look after lunch.' },
];

const pause = () => Number(process.env.POSTBOX_MOCK_SPEED ?? 1) * 600;

export class ScriptedPerson {
  name = 'mock-person';

  /** @param {{ id: string, handle: string }} _seat @param {{ kind: string, from: string, handle: string, text: string }} message @param {any} ctx */
  async deliver(_seat, message, ctx) {
    const emit = new HarnessEvents(ctx).event;
    await new Promise((ok) => setTimeout(ok, pause()).unref());
    const line = LINES.find((l) => l.when.test(message.text))?.say ?? '';
    // Whoever asked is answered by name: that wakes an agent, and puts the answer in a person’s queue.
    emit({ kind: 'text', text: `@${message.handle} ${line}`, block: 'reply' });
  }
}
