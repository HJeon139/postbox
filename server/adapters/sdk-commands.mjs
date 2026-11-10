// The Agent SDK’s commands and skills, for the / menu (#67), read from a running query (server/adapters/agent-sdk.mjs).

import { commandsOf } from './claude-init.mjs';

/**
 * The SDK’s supportedCommands() (name, description, argumentHint), marked as skills where init says so, and without
 * the ones bound to a terminal. It’s a control request, which the SDK documents for streaming input only: if it
 * fails, init’s list stands.
 * @param {any} q @param {any} init @param {any} ctx
 */
export function listCommands(q, init, ctx) {
  if (typeof q?.supportedCommands !== 'function' || !ctx.commands) return;
  const skills = new Set(
    commandsOf(init)
      .filter((c) => c.skill)
      .map((c) => c.name),
  );
  const terminal = new Set(Array.isArray(init?.terminal_slash_commands) ? init.terminal_slash_commands : []);
  Promise.resolve()
    .then(() => q.supportedCommands())
    .then(
      (list) => Array.isArray(list) && ctx.commands(list.filter((c) => !terminal.has(c?.name)).map((c) => (skills.has(c?.name) ? { ...c, skill: true } : c))),
      () => {},
    );
}
