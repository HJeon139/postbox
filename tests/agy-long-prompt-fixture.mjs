// What agy’s long-prompt tests share, the fake spawn’s and the real spawn’s (#362): a recorded turn, and a turn’s context.

import { readFileSync } from 'node:fs';

/** The recorded turn’s lines, as agy prints them. */
export const AGY_TURN = new URL('fixtures/antigravity-cli/block.jsonl', import.meta.url);

export const agyTurnLines = () => readFileSync(AGY_TURN, 'utf8').trim().split('\n');

/** A turn’s context, with what an adapter reports kept. */
export const turnContext = () => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [], description: '', instructions: '' },
  project: null,
  handles: ['gem'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
  reported: () => {},
});

/** The person’s message when the operating system refused a turn’s command line. @param {number} kb the prompt’s size */
export const tooLongMessage = (kb) =>
  `This turn’s prompt came to ${kb} KB, too long for this computer to pass to the Antigravity CLI. It holds your message, the room’s catch-up and any queued messages: send a shorter message, or point the agent at a file that holds the rest.`;
