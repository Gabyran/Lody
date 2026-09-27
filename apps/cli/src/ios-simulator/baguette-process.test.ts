import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { startBaguetteProcess } from './baguette-process';

it('joins native cleanup when its IPC lifecycle lease ends', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'lody-simulator-lifecycle-'));
  const worker = join(scratch, 'worker.mjs');
  const binary = join(scratch, 'fake-baguette');
  const marker = join(scratch, 'cleaned');
  let handle: Awaited<ReturnType<typeof startBaguetteProcess>> | undefined;
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('./baguette-worker.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: worker,
      logLevel: 'silent',
    });
    await writeFile(
      binary,
      `#!${process.execPath}\nimport http from 'node:http';\nimport fs from 'node:fs';\nconst port=Number(process.argv[process.argv.indexOf('--port')+1]);\nconst server=http.createServer((_req,res)=>res.end('[]'));\nserver.listen(port,'127.0.0.1');\nprocess.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{fs.writeFileSync(${JSON.stringify(marker)},'reaped');process.exit(0);});});\n`,
      { mode: 0o700 }
    );
    const abort = new AbortController();
    handle = await startBaguetteProcess(binary, abort.signal, worker);
    expect((await fetch(`http://127.0.0.1:${handle.port}/simulators`)).status).toBe(200);
    abort.abort();
    await handle.closed;
    expect(await readFile(marker, 'utf8')).toBe('reaped');
    await expect(fetch(`http://127.0.0.1:${handle.port}/simulators`)).rejects.toThrow();
  } finally {
    await handle?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
