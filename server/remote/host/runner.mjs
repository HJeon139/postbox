// A turn’s runner on a remote host (#120; architecture.md, “Remote hosts”, “A turn doesn’t depend on anything staying
// connected”). The daemon writes the turn folder and start.json, then runs `<node> runner.mjs <turn>` detached, so the
// runner leads its own session and process group, with no terminal and no stdio. The runner starts the harness from
// start.json’s program and argument list, never a shell, with its stdout appended to out.jsonl and its stderr to
// err.log. It records itself in runner.json first, and writes exit.json when the harness exits. It needs nothing else
// to stay up: the daemon can restart and the SSH connection can drop while it runs.
//
// It listens on the turn folder’s `sock`, which answers the daemon’s `who` with its turn ID and, for a held stdin
// (Codex), takes each line for the harness, appending it to in.jsonl before writing it to the pipe. Each connection
// proves the token first, as every connection on the host does.
//
// Stop signals the runner’s process group, so the harness gets SIGINT straight from the daemon. The runner ignores
// SIGINT, SIGTERM and SIGHUP, so it outlives the harness and can record how it ended. On SIGINT or SIGTERM it also
// closes a held stdin, the first step in stopping a stdio JSON-RPC server (C7). Otherwise the held pipe stays open
// until the harness exits; the protocol has no message to close it sooner.
//
// This file is also how the daemon starts runners and talks to them: launchRunner, askRunner and sendStdin
// (runner-client.mjs). The runner itself is runner-turn.mjs, and its side of the socket runner-serve.mjs.

import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FILE_MODE, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { paths } from './paths.mjs';
import { Refusal, runTurn } from './runner-turn.mjs';

export { askRunner, launchRunner, logindFacts, sendStdin } from './runner-client.mjs';
export { runTurn } from './runner-turn.mjs';

/** @typedef {import('./runner-client.mjs').LogindFacts} LogindFacts */

// ── As a program ────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  // Ignored from the start: the daemon’s Stop reaches the harness through the group, and the runner records it.
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(sig, () => {});
  runTurn(process.argv[2] ?? '').then(
    () => process.exit(0),
    (e) => {
      if (!(e instanceof Refusal)) {
        // Not a refusal, so not in err.log yet: a bad turn ID, or a fault after the harness started.
        try {
          const dir = paths().turn(process.argv[2] ?? '');
          writeFileSync(`${dir}/${TURN_FILES.err}`, `postbox runner: ${e?.message ?? e}\n`, { flag: 'a', mode: FILE_MODE });
        } catch {}
      }
      process.exit(1);
    },
  );
}
