// What an agent runs with, from the client’s state: shared/agent-facts.mjs says it in words; this looks up the
// session’s persona and the server’s defaults.

import { runsWith } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';

/** @returns {import('/shared/agent-facts.mjs').Facts} */
export const factsOf = (se) => runsWith(se, client.state.personas[se.personaId], client.config ?? {});
