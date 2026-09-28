// Lab host external-attacker surface (gateway auth, join mailbox,
// control CAS, harness isolation). Real host + official sqlite Riverrun in temp dirs,
// real Ed25519 signatures. Ordering is forced with explicit promise gates, never sleeps.
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeSignedRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { startDemoHost, type RunningDemoHost } from '../src/platform/host';
import { generateDevice, possessionProof, type DemoDevice } from '../src/platform/device';
import { fromHex, toHex } from '../src/platform/bytes';
import { CONTROL_STREAM } from '../src/platform/protocol';
import { riverrunRecordCount } from '../src/attacks';
import { cleanupLab, labClient, tempDir } from '../src/fixtures';
import type { HonestClient } from '../src/actors';
import type { LabFetch } from '../src/services/http';

const hosts: RunningDemoHost[] = [];
afterEach(async () => {
  while (hosts.length > 0)
    await hosts
      .pop()!
      .close()
      .catch(() => undefined);
  await cleanupLab();
});

async function host(options: {
  dataDir?: string;
  testMode?: boolean;
  fetch?: LabFetch;
}): Promise<RunningDemoHost> {
  const started = await startDemoHost({
    dataDir: options.dataDir ?? tempDir('e2ee-review-e-host-'),
    host: '127.0.0.1',
    port: 0,
    testMode: options.testMode ?? true,
    fetch: options.fetch,
  });
  hosts.push(started);
  return started;
}

function frame(record: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + record.length);
  new DataView(out.buffer).setUint32(0, record.length, false);
  out.set(record, 4);
  return out;
}

async function admitDeviceRecord(
  client: HonestClient,
  ledger: Awaited<ReturnType<HonestClient['readLedger']>>,
  device: DemoDevice
): Promise<Uint8Array> {
  const membership = ledger.state.devices.get(toHex(client.device.publicKey))!.membershipId;
  const proposal = ledger.prepare(
    {
      type: 'admitDevice',
      kind: 'personal',
      signingPublicKey: device.publicKey,
      encryptionPublicKey: device.enc,
      possessionSignature: await device.sign(
        possessionSigningBytes({
          genesis: fromHex(client.genesisHex!),
          targetMembershipId: membership,
          signingPublicKey: device.publicKey,
          encryptionPublicKey: device.enc,
          kind: 'personal',
        })
      ),
    },
    client.device.publicKey
  );
  const signature = await client.device.sign(signingBytesForBody(proposal.bodyBytes));
  return encodeSignedRecord(proposal.bodyBytes, signature);
}

describe('host control CAS', () => {
  it('pins the CAS offset, so a Guest cannot fork the control stream', async () => {
    // Gate only the host->Riverrun forward of control append-cas. Both attacker
    // requests pass host verification against the same head before either lands.
    let armed = false;
    const held: Array<{ expected: string; release: () => void; done: Promise<void> }> = [];
    let releaseAll = () => {};
    const gated: LabFetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!armed || init?.method !== 'POST' || !url.includes(`/${CONTROL_STREAM}/append-cas`)) {
        return fetch(input, init);
      }
      const expected = new Headers(init.headers).get('stream-expected-offset') ?? '';
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let finished!: () => void;
      const done = new Promise<void>((resolve) => (finished = resolve));
      held.push({ expected, release, done });
      releaseAll = () => held.forEach((entry) => entry.release());
      if (held.length === 2) {
        held.sort((a, b) => a.expected.localeCompare(b.expected));
        void (async () => {
          held[0]!.release();
          await held[0]!.done;
          held[1]!.release();
        })();
      }
      await gate;
      try {
        return await fetch(input, init);
      } finally {
        finished();
      }
    };
    const server = await host({ fetch: gated });
    const alice = await labClient({ host: server, account: 'alice' });
    await alice.createSpace();
    const bob = await labClient({ host: server, account: 'bob' });
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'guest')).roleConfigured).toBe(true);
    const genesisHex = alice.genesisHex!;
    const before = await riverrunRecordCount(server.riverrunUrl, genesisHex);

    // Guest Bob prepares two legal admitDevice records on the same verified head.
    const ledger = await bob.readLedger();
    const x = await admitDeviceRecord(bob, ledger, await generateDevice());
    const y = await admitDeviceRecord(bob, ledger, await generateDevice());
    const head = await bob.fetch(`/ds/${genesisHex}/${CONTROL_STREAM}`, { method: 'HEAD' });
    const t0 = head.headers.get('stream-next-offset')!;
    const t1 = String(Number(t0) + frame(x).length).padStart(t0.length, '0');
    const post = (record: Uint8Array, expected: string) =>
      bob
        .fetch(`/ds/${genesisHex}/${CONTROL_STREAM}/append-cas`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'stream-expected-offset': expected,
          },
          body: Buffer.from(frame(record)),
        })
        .then((response) => {
          releaseAll();
          return response.status;
        });
    armed = true;
    const statuses = await Promise.all([post(x, t0), post(y, t1)]);
    armed = false;

    const after = await riverrunRecordCount(server.riverrunUrl, genesisHex);
    const honestRead = await alice.readLedger().then(
      (l) => `ok length=${l.length}`,
      (error: Error) => `error ${error.message}`
    );
    const gatewayRead = (await alice.fetch(`/ds/${genesisHex}/${CONTROL_STREAM}`)).status;
    const observed = {
      statuses,
      recordsAdded: after.count - before.count,
      honestRead,
      gatewayRead,
    };
    // Secure: at most one record lands, the Org stays readable for honest members.
    expect(observed).toMatchObject({
      recordsAdded: 1,
      honestRead: expect.stringMatching(/^ok/),
      gatewayRead: 200,
    });
  });
});

describe('host join mailbox', () => {
  it('refuses to replace a pending join request from another signer', async () => {
    const server = await host({});
    const alice = await labClient({ host: server, account: 'alice' });
    await alice.createSpace();
    const genesisHex = alice.genesisHex!;
    // Mallory is an existing Guest, so she can list pending joins.
    const mallory = await labClient({ host: server, account: 'mallory' });
    const mJoin = await mallory.requestJoin(genesisHex);
    expect((await alice.approveJoin(mJoin, 'guest')).roleConfigured).toBe(true);
    await mallory.readLedger();

    const bob = await labClient({ host: server, account: 'bob' });
    const bobWire = await bob.requestJoin(genesisHex);
    const listed = (await (await mallory.fetch(`/v1/spaces/${genesisHex}/joins`)).json()) as {
      requests: Array<typeof bobWire>;
    };
    const target = listed.requests.find((r) => r.requestId === bobWire.requestId)!;
    expect(target.userId).toBe(bobWire.userId);

    // Mallory's fresh device signs a valid request carrying Bob's requestId + userId.
    const sock = await labClient({ host: server, account: 'mallory' });
    const forged = {
      requestId: fromHex(target.requestId),
      userId: fromHex(target.userId),
      signingPublicKey: sock.device.publicKey,
      encryptionPublicKey: sock.device.enc,
      expiresAt: null,
    };
    const signature = await sock.device.sign(joinRequestSigningBytes(fromHex(genesisHex), forged));
    const replaced = await sock.fetch(`/v1/spaces/${genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: target.requestId,
        userId: target.userId,
        signingPublicKey: toHex(sock.device.publicKey),
        encryptionPublicKey: toHex(sock.device.enc),
        expiresAt: null,
        signature: toHex(signature),
      }),
    });
    const mailbox = (await (await alice.fetch(`/v1/spaces/${genesisHex}/joins`)).json()) as {
      requests: Array<typeof bobWire>;
    };
    const entry = mailbox.requests.find((r) => r.requestId === bobWire.requestId);
    // Consequence if the admin approves "Bob's request" from the mailbox.
    const approved = await alice.approveJoin(entry!);
    const ledger = await alice.readLedger();
    const sockDevice = ledger.state.devices.get(toHex(sock.device.publicKey));
    const observed = {
      replaceStatus: replaced.status,
      mailboxSigner:
        entry?.signingPublicKey === toHex(bob.device.publicKey) ? 'bob' : 'mallory-sock',
      admittedAs: sockDevice
        ? `${ledger.state.members.get(toHex(sockDevice.membershipId))!.role} userId=${
            toHex(ledger.state.members.get(toHex(sockDevice.membershipId))!.userId) ===
            bobWire.userId
              ? 'BOB'
              : 'other'
          }`
        : 'not-admitted',
      approveStatus: approved.status,
      realBobAdmission: (await alice.approveJoin(bobWire)).admitted,
    };
    expect(observed).toEqual({
      replaceStatus: 409,
      mailboxSigner: 'bob',
      admittedAs: 'not-admitted',
      approveStatus: 'committed',
      realBobAdmission: true,
    });
  });
});

describe('host join account binding', () => {
  it('keeps a pending userId bound to the account that first claimed it', async () => {
    const server = await host({});
    const alice = await labClient({ host: server, account: 'alice' });
    await alice.createSpace();
    const genesisHex = alice.genesisHex!;
    const bob = await labClient({ host: server, account: 'bob' });
    const bobWire = await bob.requestJoin(genesisHex);
    // Another account signs a fresh request (new requestId, own keys) for Bob's userId.
    const sock = await labClient({ host: server, account: 'mallory' });
    const forged = {
      requestId: crypto.getRandomValues(new Uint8Array(16)),
      userId: fromHex(bobWire.userId),
      signingPublicKey: sock.device.publicKey,
      encryptionPublicKey: sock.device.enc,
      expiresAt: null,
    };
    const signature = await sock.device.sign(joinRequestSigningBytes(fromHex(genesisHex), forged));
    const claimed = await sock.fetch(`/v1/spaces/${genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: toHex(forged.requestId),
        userId: bobWire.userId,
        signingPublicKey: toHex(sock.device.publicKey),
        encryptionPublicKey: toHex(sock.device.enc),
        expiresAt: null,
        signature: toHex(signature),
      }),
    });
    expect(claimed.status).toBe(409);
    const unsigned = await sock.fetch(`/v1/spaces/${genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: toHex(forged.requestId),
        userId: toHex(crypto.getRandomValues(new Uint8Array(32))),
        signingPublicKey: toHex(sock.device.publicKey),
        encryptionPublicKey: toHex(sock.device.enc),
        expiresAt: null,
        signature: toHex(signature),
      }),
    });
    expect(unsigned.status, 'a signature over different fields is refused').toBe(400);
  });
});

describe('host harness plane', () => {
  it('ignores a harness clock/failpoint left in the data dir by a --test host', async () => {
    const dataDir = tempDir('e2ee-review-e-harness-');
    const first = await host({ dataDir, testMode: true });
    first.setNow(1_000);
    first.setFailpoint('drop-control-ack');
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await host({ dataDir, testMode: false });
    expect(second.harnessToken).toBeNull();
    const alice = await labClient({ host: second, account: 'alice' });
    const issuedAt = alice.credential!.issuedAt;
    await alice.createSpace();
    const bob = await labClient({ host: second, account: 'bob' });
    await bob.adoptGenesis(alice.genesisHex!);
    const ledger = await alice.readLedger();
    const record = await admitDeviceRecord(alice, ledger, await generateDevice());
    const direct = await alice
      .fetch(`/ds/${alice.genesisHex}/${CONTROL_STREAM}/append-cas`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'stream-expected-offset': (
            await alice.fetch(`/ds/${alice.genesisHex}/${CONTROL_STREAM}`, { method: 'HEAD' })
          ).headers.get('stream-next-offset')!,
        },
        body: Buffer.from(frame(record)),
      })
      .then(
        (response) => `status ${response.status}`,
        (error: Error) => `transport ${error.message}`
      );
    const observed = {
      credentialIssuedAtIsWallClock: issuedAt > 1_600_000_000_000,
      issuedAt,
      controlAck: direct,
    };
    expect(observed).toEqual({
      credentialIssuedAtIsWallClock: true,
      issuedAt: expect.any(Number),
      controlAck: 'status 204',
    });
  });
});

describe('host credential forwarding', () => {
  it('never forwards device bearer tokens to Riverrun storage', async () => {
    const forwarded: string[] = [];
    const spy: LabFetch = async (input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth) forwarded.push(auth);
      return fetch(input, init);
    };
    const server = await host({ fetch: spy });
    const alice = await labClient({ host: server, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    expect(
      forwarded.filter((value) => value === `Bearer ${alice.credential!.token}`).length,
      'bearer token observed by storage'
    ).toBe(0);
  });
});

describe('host path and Org confusion', () => {
  it('SAFE: a member of Org B cannot reach Org A through encoded or dot-segment paths', async () => {
    const server = await host({});
    const alice = await labClient({ host: server, account: 'alice' });
    await alice.createSpace();
    const a = alice.genesisHex!;
    const bob = await labClient({ host: server, account: 'bob' });
    await bob.createSpace();
    const b = bob.genesisHex!;
    await bob.reauth();
    const probes = [
      `/ds/${a}/${CONTROL_STREAM}`,
      `/ds/${b}/../${a}/${CONTROL_STREAM}`,
      `/ds/${b}/%2e%2e/${a}/${CONTROL_STREAM}`,
      `/ds/${b}/${CONTROL_STREAM}%2F..%2F..%2F${a}%2F${CONTROL_STREAM}`,
      `/ds/${b}%2F..%2F${a}/${CONTROL_STREAM}`,
      `/ds/${b}/${CONTROL_STREAM}/snapshot/..%2F..%2F..%2F${a}%2F${CONTROL_STREAM}`,
      `/ds/${a.toUpperCase()}/${CONTROL_STREAM}`,
      `/v1/spaces/${a}/joins`,
      `/v1/spaces/${a}/notes`,
    ];
    const aBytes = new Uint8Array(
      await (await fetch(`${server.riverrunUrl}/ds/${a}/${CONTROL_STREAM}`)).arrayBuffer()
    );
    const leaks: string[] = [];
    for (const path of probes) {
      const response = await bob.fetch(path);
      const body = new Uint8Array(await response.arrayBuffer());
      if (
        response.ok &&
        body.length > 0 &&
        Buffer.from(body).includes(Buffer.from(aBytes.subarray(4, 40)))
      )
        leaks.push(`${response.status} ${path}`);
      else if (response.ok && path.includes(a) && !path.includes(b))
        leaks.push(`${response.status} ${path}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('host device credentials', () => {
  it('accepts a possession proof once, for an unexpired host challenge only', async () => {
    const server = await host({});
    const alice = await labClient({ host: server, account: 'alice' });
    await alice.createSpace();
    const deviceHex = toHex(alice.device.publicKey);
    const challenge = async () => {
      const response = await fetch(`${server.baseUrl}/v1/credentials/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: alice.account, deviceHex }),
      });
      return ((await response.json()) as { nonce: string }).nonce;
    };
    const redeem = async (nonce: string) =>
      (
        await fetch(`${server.baseUrl}/v1/credentials`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            account: alice.account,
            deviceHex,
            nonce,
            signature: toHex(await possessionProof(alice.account, alice.device, nonce)),
            genesisHex: alice.genesisHex,
          }),
        })
      ).status;
    const nonce = await challenge();
    expect(await redeem(nonce)).toBe(200);
    expect(await redeem(nonce), 'a captured proof cannot mint a second token').toBe(403);

    const stale = await challenge();
    server.setNow(alice.credential!.issuedAt + 24 * 60 * 60 * 1000);
    expect(await redeem(stale), 'an expired challenge is refused').toBe(403);
  });
});
