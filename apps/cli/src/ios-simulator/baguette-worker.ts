import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

// IPC is ownership: losing the daemon always reaps the native server.
const abort = new AbortController();
const stop = () => abort.abort();
process.on('disconnect', stop);
process.on('message', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<void> | undefined;
try {
  if (!process.connected) throw new Error('Missing lifecycle owner');
  const binary = z.string().min(1).parse(process.argv[2]);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  );
  abort.signal.throwIfAborted();
  child = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', String(port), '--no-plugins'], {
    stdio: 'ignore',
    env: process.env,
  });
  exited = new Promise<void>((resolve) => {
    child?.once('error', () => {
      stop();
      resolve();
    });
    child?.once('exit', () => {
      stop();
      resolve();
    });
  });
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/simulators`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (response.ok) break;
    } catch {
      signal.throwIfAborted();
    }
    await delay(100, undefined, { signal });
  }
  process.send?.({ type: 'ready', port });
  await new Promise<void>((resolve) => {
    if (abort.signal.aborted) resolve();
    else abort.signal.addEventListener('abort', () => resolve(), { once: true });
  });
} catch {
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child?.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(kill);
  }
  process.removeListener('disconnect', stop);
  process.removeListener('message', stop);
  if (process.connected) process.disconnect();
}
