// Bind Postbox’s HTTP server, cleaning up only when startup itself fails.

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @param {() => Promise<void>} close
 * @param {() => unknown} drain
 */
export function listen(server, port, host, close, drain) {
  return new Promise((resolve, reject) => {
    const onError = (error) => close().then(() => reject(error), reject);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(drain());
    });
  });
}
