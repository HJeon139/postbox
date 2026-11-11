// The items under test for the room checks (tools/uat/room-checks.mjs): every item in the conversations and topic
// threads under test, each with its thread.

/** Every item in the threads under test, each with its threadId. @param {any} facts */
export const itemsOf = (facts) => facts.threads.flatMap((t) => (facts.state.items[t] ?? []).map((it) => ({ ...it, threadId: t })));
