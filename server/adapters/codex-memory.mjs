// Codex keeps its memories in the Codex home, beside the person’s sign-in, so a persona on Codex would read and write
// the person’s memories, and every other Codex persona’s (#479, split from #208). Each turn’s app-server turns them
// off for that process: use_memories stops it reading them, generate_memories stops it writing them. Checked with
// codex-cli 0.167.0 only: config/read on an app-server given these reports both false, from its sessionFlags layer.
// Not yet checked: whether a thread started this way is kept out of a later run that has memories on, which picks
// threads from Codex’s state database by their memory_mode.

/** The -c overrides that keep a turn out of Codex’s memories, for a turn here and on a host. */
export const CODEX_MEMORY_OFF = Object.freeze(['-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false']);
