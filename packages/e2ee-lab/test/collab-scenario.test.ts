import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '../src/platform/bytes';
import { cleanupLab } from '../src/fixtures';
import {
  createCollabWorld,
  firstCollabDivergence,
  replayCollabScenario,
  runCollabScenario,
  type CollabAgent,
  type CollabMaterial,
} from '../src/scenario';
import type { AttackAction } from '../src/attack-lab';
import { fingerprintOf } from '../src/fingerprint';

afterEach(() => cleanupLab());

/**
 * Fixed boundary attacker: drops the first pending bob request during
 * 'bob-sync-loro', then reads and mutates the Riverrun backend at the
 * finish boundary. Every choice is recorded for model-free replay.
 */
function boundaryAgent(): { agent: CollabAgent; hits: { eventId?: string; needleHex?: string } } {
  const hits: { eventId?: string; needleHex?: string } = {};
  const agent: CollabAgent = {
    act: async (turn) => {
      if (turn.stepName === 'bob-sync-loro' && turn.turn <= 1) {
        const target = turn.view.events.find(
          (event) =>
            event.status === 'requested' &&
            event.actor === 'bob' &&
            event.phase === 'request-queued'
        );
        if (target) {
          hits.eventId = target.eventId;
          return { op: 'intercept', input: { eventId: target.eventId, kind: 'drop' } };
        }
        // Otherwise advance until a real request boundary is pending.
        if (turn.turn === 0)
          return {
            op: 'advanceUntil',
            input: { actor: 'bob', phase: 'request-queued', maxSteps: 8 },
          };
        return 'pass';
      }
      if (turn.stepName === 'finish-boundary' && turn.turn === 0) {
        const disk = await turn.readBackend({ target: 'riverrun', eventId: 'barrier' });
        hits.needleHex = toHex(disk.subarray(disk.byteLength - 32, disk.byteLength - 16));
        const actions: AttackAction[] = [
          {
            op: 'mutateBackend',
            input: { eventId: 'barrier', needleHex: hits.needleHex, xor: 0xff },
          },
          { op: 'submitClaim', input: { kind: 'plaintext', evidence: 'guess-wrong' } },
        ];
        return actions;
      }
      return 'pass';
    },
  };
  return { agent, hits };
}

describe('S1 ongoing-collaboration control', () => {
  it('runs the fixed multi-member script to convergence without an attacker', async () => {
    const world = await createCollabWorld({ mode: 'auto' });
    const run = await runCollabScenario({ world });
    const failed = run.outcomes.filter((outcome) => outcome.error);
    expect(failed).toEqual([]);
    expect(run.outcomes.length).toBeGreaterThan(35);
    expect(run.report.confidentiality).toBe('pass');
    expect(run.report.integrity).toBe('pass');
    expect(run.report.durability).toBe('pass');
    // Every property is measured in the control run; none is silently uncovered.
    expect(run.report.properties?.map((row) => [row.id, row.verdict])).toEqual([
      ['confidentiality.backend-plaintext', 'pass'],
      ['confidentiality.insider-post-exclusion', 'pass'],
      ['integrity.ledger-verified', 'pass'],
      ['integrity.content-authorized', 'pass'],
      ['integrity.context-bound', 'pass'],
      ['integrity.forged-claims', 'unavailable'],
      ['durability.cursor-within-document', 'pass'],
      ['durability.no-loss', 'pass'],
    ]);
  }, 180_000);
});

/** Hide Eve's removal from Bob only, then use Eve's retained keys at the end. */
function splitViewAgent(): { agent: CollabAgent; seen: { insiderText?: string } } {
  const seen: { insiderText?: string } = {};
  const agent: CollabAgent = {
    act: async (turn) => {
      if (turn.stepName === 'alice-remove-eve' && turn.turn === 0) {
        return { op: 'forkView', input: { eventId: 'barrier', actor: 'bob', stream: 'control' } };
      }
      if (turn.stepName === 'finish-boundary' && turn.turn === 0) {
        expect(turn.view.insiders).toEqual(['eve']);
        const frames = await turn.insiderRead({ insider: 'eve' });
        seen.insiderText = frames.map((frame) => frame.text).join('\n');
        return 'pass';
      }
      return 'pass';
    },
  };
  return { agent, seen };
}

describe('S4 excluded insider with a per-client split view', () => {
  it('judges post-removal content against the insider and replays the fork', async () => {
    const world = await createCollabWorld({ mode: 'manual' });
    const { agent, seen } = splitViewAgent();
    const run = await runCollabScenario({ world, agent });
    const insider = run.report.properties?.find(
      (row) => row.id === 'confidentiality.insider-post-exclusion'
    )?.verdict;
    // Positive control: Eve's retained epoch-1 key opens her own pre-removal edit.
    expect(seen.insiderText).toContain('eve-edit');
    // Bob never saw the removal, so he could not receive epoch 2 and sealed his
    // "post-removal" edit under epoch 1, which Eve still holds. The leak is real but
    // rests on withheld control records: the stated freshness limit, not a silent pass.
    expect(run.outcomes.find((row) => row.name === 'bob-receive-epoch2')?.error).toBeDefined();
    expect(insider).toBe('outside-model');
    expect(run.report.confidentiality).toBe('outside-model');
    expect(fingerprintOf(run.report).rules).toContain('model.stale-control-view');
    const replay = await replayCollabScenario(run.material);
    expect(replay.divergence).toBeNull();
  }, 300_000);
});

describe('S2 fixed boundary attacks during collaboration', () => {
  it('drops a pending bob response mid-collaboration with recorded hit evidence', async () => {
    const world = await createCollabWorld({ mode: 'manual' });
    const { agent, hits } = boundaryAgent();
    const run = await runCollabScenario({ world, agent });
    // The attack hit a real pending event: its protocol frame records the
    // dropped response (status 0) and the honest client step reports failure.
    expect(hits.eventId).toBeDefined();
    const frame = run.material.frames.find((row) => row.eventId === hits.eventId);
    expect(frame).toBeDefined();
    expect(frame!.responseStatus).toBe(0);
    expect(frame!.responseHex).toBe('');
    const bobSync = run.outcomes.find((outcome) => outcome.name === 'bob-sync-loro');
    expect(bobSync?.error).toBeDefined();
    // Collaboration still converges on the remaining path.
    expect(
      run.outcomes.find((outcome) => outcome.name === 'final-converge')?.error
    ).toBeUndefined();
    // The finish-boundary mutation hit real backend bytes.
    const mutation = run.material.actions.find((action) => action.op === 'mutateBackend');
    expect(mutation?.input?.receipt).toBe(true);
    expect(run.material.actions.some((action) => action.op === 'readBackend')).toBe(true);
    expect(run.material.actions.some((action) => action.op === 'submitClaim')).toBe(true);
    // No private material leaks into the public action log or report.
    const publicLog = JSON.stringify(run.lab.actions());
    expect(publicLog).not.toContain(world.secret);
    expect(publicLog).not.toContain('guess-wrong');
  }, 240_000);
});

describe('S3 model-free replay in fresh directories', () => {
  it('replays the same attack record in three fresh directory sets', async () => {
    const world = await createCollabWorld({ mode: 'manual' });
    const { agent } = boundaryAgent();
    const run = await runCollabScenario({ world, agent });
    for (let index = 0; index < 3; index++) {
      const replay = await replayCollabScenario(run.material);
      expect(replay.divergence).toBeNull();
      const unexpected = replay.outcomes.filter(
        (outcome) => outcome.error && outcome.name !== 'bob-sync-loro'
      );
      expect(unexpected).toEqual([]);
    }
  }, 300_000);

  it('reports the first divergence field instead of only comparing verdicts', async () => {
    const world = await createCollabWorld({ mode: 'manual' });
    const { agent } = boundaryAgent();
    const run = await runCollabScenario({ world, agent });
    const tamperedEvent: CollabMaterial = {
      ...run.material,
      events: run.material.events.map((event, index) =>
        index === 2 ? { ...event, time: event.time + 7 } : event
      ),
    };
    const eventReplay = await replayCollabScenario(tamperedEvent);
    expect(eventReplay.divergence?.field).toBe('time');
    const tamperedClient: CollabMaterial = {
      ...run.material,
      clients: run.material.clients.map((client, index) =>
        index === 0 ? { ...client, ledgerRecords: (client.ledgerRecords ?? 0) + 1 } : client
      ),
    };
    const clientReplay = await replayCollabScenario(tamperedClient);
    expect(clientReplay.divergence?.field).toBe('client.ledgerRecords');
    const tamperedVerdict: CollabMaterial = {
      ...run.material,
      report: { ...run.material.report, integrity: 'violation' },
    };
    expect(
      firstCollabDivergence(tamperedVerdict, {
        events: run.material.events,
        frames: run.material.frames,
        clients: run.material.clients,
        report: run.material.report,
      })?.field
    ).toBe('verdict.integrity');
  }, 300_000);
});
