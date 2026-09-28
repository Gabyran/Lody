/**
 * Host gateway regressions (external attacker = own device keys, normal host API).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { generateDevice } from '../src/platform/device';
import { readLoro, writeLoro } from '../src/platform/content-session';
import { CONTROL_STREAM, KEYS_STREAM } from '../src/platform/protocol';
import { fromHex } from '../src/platform/bytes';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import type { HonestClient } from '../src/actors';

afterEach(() => cleanupLab());

/** A malicious-but-authenticated client: honest code, one extra HTTP header. */
function addHeaderToControlCas(client: HonestClient, name: string, value: string): void {
  const orig = client.fetch.bind(client);
  client.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST' && request.url.includes(`/${CONTROL_STREAM}/append-cas`)) {
      const headers = new Headers(request.headers);
      headers.set(name, value);
      return orig(new Request(request, { headers }));
    }
    return orig(input, init);
  };
}

async function orgWithGuest(existingHost?: { baseUrl: string }) {
  const host = existingHost ?? (await launchLab());
  const alice = await labClient({ host, account: 'alice' });
  const bob = await labClient({ host, account: 'bob' });
  await alice.createSpace();
  const join = await bob.requestJoin(alice.genesisHex!);
  const approved = await alice.approveJoin(join, 'guest');
  expect(approved.status).toBe('committed');
  await bob.readLedger();
  await alice.deliverEpochKey(bob.device, 0);
  const frames = await bob.readKeyFrames();
  await bob.receiveEpochKey(alice.device, 0, frames[0]!);
  return { host, alice, bob, bobMembership: approved.membershipId };
}

describe('host gateway control-cas', () => {
  it('does not forward Stream-Closed, so a Guest cannot make itself irrevocable', async () => {
    const { alice, bob, bobMembership } = await orgWithGuest();

    // Guest signs a record it is allowed to sign (admit another personal device of
    // its own) and adds one Riverrun header. The gateway verifies the record and
    // forwards every request header, including `Stream-Closed: true`.
    addHeaderToControlCas(bob, 'stream-closed', 'true');
    const extra = await generateDevice();
    const admitted = await bob.admitDevice(extra, 'personal');
    expect(admitted.status).toBe('committed');

    // Owner now removes the Guest and rotates the epoch.
    const removed = await alice.removeMember(bobMembership);
    let rotated: { status: string };
    try {
      rotated = await alice.publishEpoch();
    } catch (error) {
      rotated = { status: `failed:${(error as { _tag?: string })._tag ?? String(error)}` };
    }
    const ledger = await alice.readLedger();

    // Guest keeps gateway read access to content written after the attempted removal.
    await writeLoro(alice, 'after-guest-removal-secret');
    let guestRead = '';
    try {
      guestRead = await readLoro(bob);
    } catch (error) {
      guestRead = `read-failed:${String(error)}`;
    }

    // Secure behaviour: the Owner can revoke, and the removed Guest cannot read on.
    expect(
      {
        removed: removed.status,
        rotated: rotated.status,
        guestStillMember: ledger.state.members.has(Buffer.from(bobMembership).toString('hex')),
        guestReadsNewContent: guestRead.includes('after-guest-removal-secret'),
      },
      'Stream-Closed header forwarded to Riverrun closes the control stream forever'
    ).toEqual({
      removed: 'committed',
      rotated: 'committed',
      guestStillMember: false,
      guestReadsNewContent: false,
    });
  });
});

describe('host gateway control-cas controls', () => {
  it('control: without the extra header the Owner removes the Guest', async () => {
    const { alice, bob, bobMembership } = await orgWithGuest();
    const extra = await generateDevice();
    expect((await bob.admitDevice(extra, 'personal')).status).toBe('committed');
    expect((await alice.removeMember(bobMembership)).status).toBe('committed');
  });
});

describe('host gateway keys-cas (Guest is an allowed sender)', () => {
  async function guestAppendsKeys(bob: HonestClient, genesisHex: string, body: Uint8Array) {
    const head = await bob.fetch(`/ds/${genesisHex}/${KEYS_STREAM}`, { method: 'HEAD' });
    const tail = head.headers.get('stream-next-offset')!;
    return bob.fetch(`/ds/${genesisHex}/${KEYS_STREAM}/append-cas`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'stream-expected-offset': tail },
      body: Buffer.from(body),
    });
  }

  async function orgWithGuestAndNewMember() {
    const base = await orgWithGuest();
    const carol = await labClient({ host: base.host, account: 'carol' });
    const join = await carol.requestJoin(base.alice.genesisHex!);
    expect((await base.alice.approveJoin(join, 'member')).status).toBe('committed');
    await carol.readLedger();
    return { ...base, carol };
  }

  async function deliver(alice: HonestClient, carol: HonestClient): Promise<string> {
    try {
      await alice.deliverEpochKey(carol.device, 0);
      return 'delivered';
    } catch (error) {
      const e = error as { _tag?: string; code?: string };
      return `failed:${e._tag ?? ''}:${e.code ?? String(error)}`;
    }
  }

  it('rejects stray bytes, so a Guest cannot poison key delivery', async () => {
    const { alice, bob, carol } = await orgWithGuestAndNewMember();
    const poisoned = await guestAppendsKeys(bob, alice.genesisHex!, new Uint8Array([0x00]));
    expect(poisoned.status).toBe(400);
    expect(await deliver(alice, carol)).toBe('delivered');
  });

  it('rejects a frame naming another sender, so a Guest cannot squat a delivery slot', async () => {
    const { alice, bob, carol } = await orgWithGuestAndNewMember();
    // Unauthenticated routing AAD: [genesis, epoch 0, sender=Owner, recipient=Carol]
    // followed by 144 garbage bytes (enc, ct, sig). The Guest cannot sign as the Owner.
    const bstr32 = (bytes: Uint8Array) => [0x58, 0x20, ...bytes];
    const aad = [
      0x84,
      ...bstr32(fromHex(alice.genesisHex!)),
      0x00,
      ...bstr32(alice.device.publicKey),
      ...bstr32(carol.device.publicKey),
    ];
    const frame = new Uint8Array([...aad, ...new Uint8Array(144)]);
    const squatted = await guestAppendsKeys(bob, alice.genesisHex!, frame);
    expect(squatted.status).toBe(400);
    expect(await deliver(alice, carol)).toBe('delivered');
  });
});
