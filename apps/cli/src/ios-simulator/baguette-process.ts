import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type BaguetteProcess = { port: number; closed: Promise<void>; stop(): Promise<void> };
export async function startBaguetteProcess(
  binary: string,
  signal: AbortSignal,
  workerPath = fileURLToPath(new URL('./baguette-worker.js', import.meta.url))
): Promise<BaguetteProcess> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'DEVELOPER_DIR', 'ELECTRON_RUN_AS_NODE'])
    if (process.env[key]) env[key] = process.env[key];
  const worker = spawn(process.execPath, [workerPath, binary], {
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const stop = () => {
    if (worker.connected) worker.disconnect();
  };
  let resolveReady: (port: number) => void = () => {};
  let rejectReady: (reason: unknown) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve) => {
    const end = () => {
      signal.removeEventListener('abort', stop);
      rejectReady(new Error('Simulator capture process stopped.'));
      resolve();
    };
    worker.once('exit', end);
    worker.once('error', () => {
      if (!worker.pid) end();
      else stop();
    });
  });
  worker.on('message', (raw: unknown) => {
    const parsed = z
      .object({ type: z.literal('ready'), port: z.number().int().min(1).max(65535) })
      .strict()
      .safeParse(raw);
    if (parsed.success) resolveReady(parsed.data.port);
    else {
      rejectReady(new Error('Invalid simulator worker response.'));
      stop();
    }
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const port = await ready;
    signal.throwIfAborted();
    return {
      port,
      closed,
      stop: async () => {
        stop();
        await closed;
      },
    };
  } catch (error) {
    stop();
    await closed;
    throw error;
  }
}
