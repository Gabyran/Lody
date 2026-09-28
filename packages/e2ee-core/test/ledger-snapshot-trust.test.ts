// Signed snapshot join and endorsement (§6.1, §8.6).
import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '../src/ledger';
import { encodeSnapshotCbor, decodeSnapshotCbor } from '../src/ledger/cbor';
import { snapshotSigningBytes } from '../src/ledger/crypto';
import { encodeSignedSnapshot } from '../src/ledger/snapshot';
import type { Operation } from '../src/ledger/schema';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  commitEpochKey,
  ed25519,
  hex,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';

type L = Awaited<ReturnType<typeof Ledger.verify>>;

async function endorse(ledger: L, signer: DeviceKeys) {
  const proposal = ledger.prepareSnapshot(signer.publicKey);
  const snapshot = await Ledger.finalizeSnapshot(
    proposal,
    await signer.sign(proposal.signingBytes)
  );
  return {
    snapshot,
    trust: {
      genesis: proposal.genesis,
      endorser: signer.publicKey,
      head: proposal.head,
      headSignature: await signer.sign(proposal.headAttestationSigningBytes),
    },
  };
}

async function code(run: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof run === 'function' ? run() : run);
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function richHistory() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  let ledger = created.ledger;
  const records = [created.record];
  const push = async (signer: DeviceKeys, op: Operation) => {
    const next = await append(ledger, signer, op);
    ledger = next.ledger;
    records.push(next.record);
  };
  const epoch = async (signer: DeviceKeys) => {
    const n = ledger.state.epoch.number + 1;
    await push(signer, {
      type: 'publishEpoch',
      epoch: n,
      commitment: await commitEpochKey(created.anchor, n, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
  };
  const bob = await ed25519();
  const bobM = random(16);
  await push(owner, {
    type: 'admitMember',
    membershipId: bobM,
    request: await signJoin(created.anchor, bob),
  });
  await push(owner, { type: 'setRole', membershipId: bobM, role: 'admin' });
  const bobR = await ed25519();
  await push(bob, await admitDeviceOp(created.anchor, bobM, bobR, 'recovery'));
  const bobPhone = await ed25519();
  await push(bobR, await admitDeviceOp(created.anchor, bobM, bobPhone, 'personal'));
  const carol = await ed25519();
  const carolM = random(16);
  await push(bobPhone, {
    type: 'admitMember',
    membershipId: carolM,
    request: await signJoin(created.anchor, carol),
  });
  const carolMachine = await ed25519();
  await push(carol, await admitDeviceOp(created.anchor, carolM, carolMachine, 'machine'));
  await push(owner, { type: 'setRole', membershipId: carolM, role: 'guest' });
  await epoch(bobPhone);
  const dave = await ed25519();
  const daveM = random(16);
  await push(owner, {
    type: 'admitMember',
    membershipId: daveM,
    request: await signJoin(created.anchor, dave),
  });
  await push(owner, { type: 'removeMember', membershipId: daveM });
  await push(bob, { type: 'revokeDevice', target: bobR.publicKey });
  const mid = ledger;
  const midLength = records.length;
  // suffix after the snapshot point
  await push(owner, { type: 'transferOwner', successorMembershipId: bobM });
  await epoch(bob);
  await push(bobPhone, { type: 'setRole', membershipId: created.membershipId, role: 'member' });
  const eve = await ed25519();
  await push(bob, {
    type: 'admitMember',
    membershipId: random(16),
    request: await signJoin(created.anchor, eve),
  });
  return {
    owner,
    created,
    records,
    mid,
    midLength,
    final: ledger,
    bob,
    bobPhone,
    carol,
    carolMachine,
    bobR,
    dave,
  };
}

describe('snapshot join trust', () => {
  it('SAFE: snapshot + suffix produces the same state digest as full replay (after canManage removal)', async () => {
    const h = await richHistory();
    for (const endorser of [h.owner, h.bob, h.bobPhone]) {
      const { snapshot, trust } = await endorse(h.mid, endorser);
      const viaSnapshot = await Ledger.verifySnapshot({
        trust,
        snapshot,
        suffix: h.records.slice(h.midLength),
      });
      const full = await Ledger.verify({ anchor: h.created.anchor, records: h.records });
      expect(hex(viaSnapshot.comparisonNote(h.owner.publicKey).stateDigest)).toBe(
        hex(full.comparisonNote(h.owner.publicKey).stateDigest)
      );
      // Post-snapshot ledger enforces the same replay facts: removed Dave cannot come back with his key.
      const again = await signJoin(h.created.anchor, h.dave);
      const p = viaSnapshot.prepare(
        { type: 'admitMember', membershipId: random(16), request: again },
        h.bob.publicKey
      );
      const rec = await h.bob.sign(p.signingBytes);
      expect(await code(viaSnapshot.finalize(p, rec))).toBe('replay');
    }
  });

  it('SAFE: machine, recovery, guest, revoked devices cannot endorse a truthful snapshot', async () => {
    const h = await richHistory();
    for (const k of [h.carolMachine, h.carol, h.bobR, h.dave]) {
      expect(await code(() => h.mid.prepareSnapshot(k.publicKey))).toBe('unauthorized');
    }
    // A demoted ex-owner (now member at the final head) cannot endorse the final state.
    expect(await code(() => h.final.prepareSnapshot(h.owner.publicKey))).toBe('unauthorized');
    // A machine signing a truthful body is rejected at import.
    const honest = h.mid.prepareSnapshot(h.bob.publicKey);
    const body = decodeSnapshotCbor(honest.bodyBytes) as unknown[];
    body[4] = h.carolMachine.publicKey;
    const forgedBody = encodeSnapshotCbor(body as never);
    const snapshot = encodeSignedSnapshot(
      forgedBody,
      await h.carolMachine.sign(snapshotSigningBytes(forgedBody))
    );
    const trust = {
      genesis: honest.genesis,
      endorser: h.carolMachine.publicKey,
      head: honest.head,
      headSignature: await h.carolMachine.sign(honest.headAttestationSigningBytes),
    };
    expect(await code(Ledger.verifySnapshot({ trust, snapshot }))).toBe('unauthorized');
  });

  it('SAFE: head attestation / snapshot cannot be rebound to another head, Org or endorser', async () => {
    const h = await richHistory();
    const { snapshot, trust } = await endorse(h.mid, h.owner);
    expect(
      await code(Ledger.verifySnapshot({ trust: { ...trust, head: h.final.head }, snapshot }))
    ).toBe('bad-signature');
    const other = await signGenesis(h.owner);
    expect(
      await code(Ledger.verifySnapshot({ trust: { ...trust, genesis: other.anchor }, snapshot }))
    ).toBe('bad-signature');
    const later = await endorse(h.final, h.bob);
    // Bob's valid head attestation paired with owner's snapshot.
    expect(
      await code(
        Ledger.verifySnapshot({
          trust: { ...later.trust, head: trust.head, headSignature: trust.headSignature },
          snapshot,
        })
      )
    ).toBe('bad-signature');
    expect(await code(Ledger.verifySnapshot({ trust: later.trust, snapshot }))).toBe(
      'wrong-anchor'
    );
  });

  // Documented limit (§6.1 安全取舍 / "有效背书者可以签署结构合法的虚假状态"): eligibility is checked only
  // against the endorser's own claimed state. Shown here to make the precise extent visible: the key
  // need not be a current (or ever-valid) Owner/Admin personal device in the real ledger.
  it('DOCUMENTED LIMIT: a machine key the joiner is told to trust can self-assert Owner and be accepted', async () => {
    const h = await richHistory();
    const honest = h.mid.prepareSnapshot(h.owner.publicKey);
    const body = decodeSnapshotCbor(honest.bodyBytes) as unknown[];
    const auth = body[5] as unknown[];
    const devices = auth[2] as unknown[][];
    // Relabel Carol's machine as a personal device of the Owner membership.
    const machineHex = hex(h.carolMachine.publicKey);
    for (const row of devices) {
      if (hex(row[0] as Uint8Array) === machineHex) {
        row[1] = h.created.membershipId;
        row[2] = 0;
      }
    }
    body[4] = h.carolMachine.publicKey;
    const forgedBody = encodeSnapshotCbor(body as never);
    const snapshot = encodeSignedSnapshot(
      forgedBody,
      await h.carolMachine.sign(snapshotSigningBytes(forgedBody))
    );
    const trust = {
      genesis: honest.genesis,
      endorser: h.carolMachine.publicKey,
      head: honest.head,
      headSignature: await h.carolMachine.sign(honest.headAttestationSigningBytes),
    };
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const dev = joined.state.devices.get(machineHex)!;
    expect(dev.kind).toBe('personal');
    // The forged view disagrees with an honest replay at the same head — only compareNotes can detect it.
    const honestNote = h.mid.comparisonNote(h.owner.publicKey);
    const forgedNote = joined.comparisonNote(h.carolMachine.publicKey);
    expect(
      Ledger.compareNotes(forgedNote, honestNote, { originalEndorser: h.carolMachine.publicKey })
        .kind
    ).toBe('conflict');
  });
});
