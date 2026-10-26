// What the host’s shim (shim.mjs, #120) says to the harness on stdout, one JSON-RPC message per line, and the words
// in it: the answer to initialize, a queued tool’s text, and how long a wait was. It logs only to stderr.

/** The same answer to initialize as the laptop’s server/mcp.mjs; tests/integration/remote-shim.test.mjs compares them. */
const PROTOCOL = '2025-06-18';
export const INITIALIZE = {
  protocolVersion: PROTOCOL,
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: 'postbox', version: '0.2.0' },
  instructions:
    'Postbox renders your UI. Reply in Markdown; use show_block for questions and show_app for interactive software. Tools never block: answers arrive as new messages.',
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const log = (text) => process.stderr.write(`postbox shim: ${text}\n`);

/** @param {object} msg */
export const send = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
export const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
export const fail = (id, code, text) => send({ jsonrpc: '2.0', id, error: { code, message: text } });
export const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** What a queued tool returns at once. It says the call was sent, never how the laptop took it. */
export function queuedText(name, args) {
  const said = (v) => (typeof v === 'string' && v ? v : null);
  const block = said(args.block?.id);
  const since = 'Postbox applies it as soon as it’s connected to this host';
  switch (name) {
    case 'show_block':
      return `Sent block ${block ?? '(no id)'} to Postbox, which checks it and shows it as soon as it’s connected to this host.`;
    case 'update_block':
      return `Sent the update to block ${block ?? '(no id)'} to Postbox, which checks it and applies it as soon as it’s connected to this host.`;
    case 'show_app':
      return `Sent app ${args.id} to Postbox, which checks it and shows it as soon as it’s connected to this host. Use that id to update it.`;
    case 'update_app':
      return `Sent the new version of app ${said(args.id) ?? '(no id)'} to Postbox. ${since}.`;
    case 'define_term':
      return `Sent “${said(args.term) ?? ''}” to the glossary. ${since}.`;
    case 'propose_agent':
      return 'Proposed. The person decides whether to create it.';
    case 'schedule_wake':
      return `Asked Postbox to wake you in ${Number(args.in_minutes) || 1} minutes. ${since}.`;
    case 'wake_agent':
      return `Sent your message for ${said(args.handle) ?? 'that agent'} to Postbox. ${since}.`;
    case 'ask_for_tool':
      return `Asked for ${said(args.tool) ?? 'that tool'}. The person sees a card once Postbox is connected to this host. End your turn: their answer arrives as a message.`;
    default:
      return `Sent ${name} to Postbox. ${since}.`;
  }
}

/** @param {number} ms */
export function minutes(ms) {
  if (ms >= 2 * 60 * MINUTE && ms % (60 * MINUTE) === 0) return `${ms / (60 * MINUTE)} hours`;
  if (ms >= MINUTE) return `${Math.round(ms / MINUTE)} minute${Math.round(ms / MINUTE) === 1 ? '' : 's'}`;
  return `${Math.round(ms / SECOND)} seconds`;
}
