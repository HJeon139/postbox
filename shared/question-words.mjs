// What an unanswered AskUserQuestion call hears (#521, #1059), in one place for this computer
// (server/ask-question.mjs) and a host’s shim (server/remote/host/shim-calls.mjs): the question stays open in the
// conversation, and its answer comes later as a message, so the agent doesn’t ask it again.

/** Claude Code’s tool for asking the person a question. */
export const QUESTION_TOOL = 'AskUserQuestion';

export const STILL_OPEN = 'The question stays open in the conversation; their answer reaches you as a message, so don’t ask it again.';

/** That nobody answered within `limit`, a duration in words such as “24 hours”. @param {string} limit */
export const nobodyAnsweredWithin = (limit) => `Nobody answered within ${limit}.`;

/** What a host question’s call hears at the host’s permissionWaitMax (#1059). @param {string} limit */
export const nobodyAnswered = (limit) => `${nobodyAnsweredWithin(limit)} ${STILL_OPEN}`;
