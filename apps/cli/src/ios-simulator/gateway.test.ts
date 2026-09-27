import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createSimulatorGateway } from './gateway';
import { LocalPreviewProxyManager } from '@/preview/local-preview-proxy';
import type { SessionId } from '@lody/shared';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  setDebug: () => {},
  child: () => logger,
  close: () => {},
};
async function setup() {
  const server = http.createServer();
  const upstream = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('bind');
  cleanups.push(async () => {
    for (const client of upstream.clients) client.terminate();
    upstream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let active = true,
    renewals = 0;
  const gateway = await createSimulatorGateway({
    operationId: 'operation',
    udid: '5519CB11-71C9-46D9-AEFF-73C96F1104E0',
    port: address.port,
    active: () => active,
    renew: () => renewals++,
  });
  cleanups.push(gateway.close);
  const proxy = new LocalPreviewProxyManager({ logger });
  const endpoint = await proxy.acquire({
    sessionId: 's' as SessionId,
    target: { protocol: 'http', host: '127.0.0.1', port: gateway.port, path: gateway.path },
    visualAnnotation: false,
  });
  cleanups.push(() => proxy.closeAll('test'));
  const url = new URL(endpoint.viewerUrl);
  const stream = new URL('stream', url);
  stream.protocol = 'ws:';
  stream.search = url.search;
  return {
    upstream,
    gateway,
    url,
    stream,
    renewals: () => renewals,
    revoke: () => {
      active = false;
    },
  };
}
describe('simulator media boundary', () => {
  it('serves fixed unannotated content behind capability auth and exposes no Baguette API', async () => {
    const { url, gateway } = await setup();
    const direct = `http://127.0.0.1:${gateway.port}${gateway.path}`;
    expect((await fetch(direct, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(
      404
    );
    expect((await fetch(`http://127.0.0.1:${gateway.port}/`)).status).toBe(404);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('lody:ios-simulator:init');
    expect(html).not.toContain('data-lody');
    const denied = new URL(url);
    denied.search = '';
    expect((await fetch(denied)).status).toBe(403);
    const forbidden = new URL(url);
    forbidden.pathname = '/simulators';
    expect((await fetch(forbidden)).status).toBe(404);
  });
  it('forwards only validated touches to the bound device, never counts video as activity', async () => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native, request] = (await incoming) as [WebSocket, http.IncomingMessage];
    expect(request.url).toContain('/simulators/5519CB11-71C9-46D9-AEFF-73C96F1104E0/stream?');
    const painted = once(client, 'message');
    native.send(Buffer.from([1, 2, 3]));
    expect((await painted)[0]).toEqual(Buffer.from([1, 2, 3]));
    expect(f.renewals()).toBe(0);
    const input = once(native, 'message');
    client.send(JSON.stringify({ type: 'touch1-down', x: 10, y: 20, width: 100, height: 200 }));
    expect(JSON.parse(String((await input)[0]))).toMatchObject({ type: 'touch1-down', x: 10 });
    expect(f.renewals()).toBe(1);
    const released = once(native, 'message');
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'install', path: '/tmp/evil.app' }));
    await closed;
    expect(JSON.parse(String((await released)[0]))).toMatchObject({
      type: 'touch1-up',
      x: 10,
      y: 20,
    });
  });
  it('revocation rejects frames and tears down the stream', async () => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native] = (await incoming) as [WebSocket];
    const closed = once(client, 'close');
    f.revoke();
    native.send(Buffer.from([1]));
    await closed;
    expect((await fetch(f.url)).status).toBe(410);
  });
});
