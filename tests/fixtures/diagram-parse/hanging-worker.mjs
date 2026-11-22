// A stand-in for server/diagram-parse-worker.mjs (#731): “hang” never answers, as a diagram that hangs Mermaid’s
// parser wouldn’t; any other source answers with a syntax error naming it.
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', ({ id, src }) => {
  if (src === 'hang') for (;;);
  parentPort?.postMessage({ id, error: { message: `Parse error in ${src}`, line: null } });
});
