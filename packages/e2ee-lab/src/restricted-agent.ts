import type { AttackAction, AttackLab, PublicReport, PublicView } from './attack-lab';
import { VIEW_STREAMS } from './attack-lab';
import type { AgentTurn, CollabAgent } from './scenario';
import { toHex } from './platform/bytes';
import type { LabFetch } from './services/http';

export type AgentStep = {
  op: 'observe' | 'readBackend' | 'mutateBackend' | 'submitClaim' | 'intercept' | 'finish';
  needleHex?: string;
  xor?: number;
  kind?: 'plaintext' | 'forged-accepted' | 'cursor-overrun' | string;
  evidence?: string;
  eventId?: string;
  status?: number;
  bodyHex?: string;
};

export type AgentEndpoint = {
  url: string;
  key: string;
  model: string;
};

/**
 * Keys in precedence order. `E2EE_AGENT_URL`/`E2EE_AGENT_KEY` adds a custom
 * OpenAI-compatible endpoint first; `E2EE_AGENT_MODEL` overrides every model.
 */
export function listAgentEndpoints(env: NodeJS.ProcessEnv = process.env): AgentEndpoint[] {
  const endpoints: AgentEndpoint[] = [];
  if (env.E2EE_AGENT_URL && env.E2EE_AGENT_KEY) {
    endpoints.push({
      url: env.E2EE_AGENT_URL,
      key: env.E2EE_AGENT_KEY,
      model: env.E2EE_AGENT_MODEL ?? 'gpt-4o-mini',
    });
  }
  if (env.XAI_API_KEY) {
    endpoints.push({
      url: 'https://api.x.ai/v1/chat/completions',
      key: env.XAI_API_KEY,
      model: 'grok-4',
    });
  }
  if (env.GROK_API_KEY) {
    endpoints.push({
      url: 'https://api.x.ai/v1/chat/completions',
      key: env.GROK_API_KEY,
      model: 'grok-4',
    });
  }
  if (env.OPENROUTER_KEY) {
    endpoints.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: env.OPENROUTER_KEY,
      model: 'openai/gpt-4o-mini',
    });
  }
  if (env.GROQ_KEY) {
    endpoints.push({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: env.GROQ_KEY,
      model: 'llama-3.1-8b-instant',
    });
  }
  if (env.DEEPSEEK_API_KEY) {
    endpoints.push({
      url: 'https://api.deepseek.com/chat/completions',
      key: env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
    });
  }
  if (env.OPENAI_API_KEY) {
    endpoints.push({
      url: 'https://api.openai.com/v1/chat/completions',
      key: env.OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });
  }
  const model = env.E2EE_AGENT_MODEL;
  return model ? endpoints.map((endpoint) => ({ ...endpoint, model })) : endpoints;
}

export function resolveAgentEndpoint(
  env: NodeJS.ProcessEnv = process.env
): AgentEndpoint | undefined {
  return listAgentEndpoints(env)[0];
}

const SYSTEM_ATTACK = [
  'You attack an E2EE lab through AttackLab only.',
  'Return JSON {op,needleHex?,xor?,kind?,evidence?,eventId?,status?,bodyHex?}.',
  'op is observe|readBackend|mutateBackend|submitClaim|intercept|finish.',
  'Prefer a multi-step hunt: observe → readBackend → mutateBackend (needle from diskPrefix) or intercept a pending eventId.',
  'observe, readBackend, submitClaim, and finish are not destructive hits.',
  'Do not guess plaintext. Prefer finish when no leak or hit evidence exists.',
  'Budget exhaustion is not a finding. Never invent success.',
].join(' ');

async function completeJson(
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch,
  messages: readonly { role: 'system' | 'user'; content: string }[],
  sampling: { temperature: number; seed?: number }
): Promise<unknown> {
  const response = await fetchImpl(endpoint.url, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: sampling.temperature,
      ...(sampling.seed === undefined ? {} : { seed: sampling.seed }),
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!response.ok) {
    throw new Error(`agent-llm-${response.status}:${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('agent-llm-empty');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function chooseStep(
  view: PublicView,
  diskHexPrefix: string,
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch,
  prior: readonly AgentStep[]
): Promise<AgentStep> {
  const parsed = (await completeJson(
    endpoint,
    fetchImpl,
    [
      { role: 'system', content: SYSTEM_ATTACK },
      {
        role: 'user',
        content: JSON.stringify({
          events: view.events,
          genesisHex: view.genesisHex,
          backendBytes: view.backendBytes,
          errors: view.errors,
          diskPrefix: diskHexPrefix.slice(0, 128),
          priorOps: prior.map((step) => step.op),
          remainingSteps: Math.max(0, 6 - prior.length),
        }),
      },
    ],
    { temperature: 0 }
  )) as AgentStep;
  const allowed = new Set([
    'observe',
    'readBackend',
    'mutateBackend',
    'submitClaim',
    'intercept',
    'finish',
  ]);
  if (!allowed.has(parsed.op)) return { op: 'finish' };
  return parsed;
}

export async function runRestrictedAgentWithFallback(
  lab: AttackLab,
  endpoints: readonly AgentEndpoint[] = listAgentEndpoints(),
  fetchImpl: LabFetch = globalThis.fetch.bind(globalThis)
): Promise<{ report: PublicReport; endpoint: AgentEndpoint }> {
  if (endpoints.length === 0) throw new Error('no model key; P4 Agent run blocked');
  let last: unknown;
  for (const endpoint of endpoints) {
    try {
      return { report: await runRestrictedAgent(lab, endpoint, fetchImpl), endpoint };
    } catch (error) {
      last = error;
      const text = String(error);
      if (!/agent-llm-(401|403|404|429)|insufficient_quota|credit_balance_exhausted/.test(text)) {
        throw error;
      }
    }
  }
  throw last instanceof Error ? last : new Error('agent-llm-unavailable');
}

/** LLM-chosen AttackLab steps. Multi-step; hits require mutation/intercept receipts. */
export async function runRestrictedAgent(
  lab: AttackLab,
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch = globalThis.fetch.bind(globalThis)
): Promise<PublicReport> {
  let view = await lab.observe();
  let disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
  const prior: AgentStep[] = [];
  let hitEvidence = false;
  for (let step = 0; step < 6; step++) {
    const choice = await chooseStep(view, toHex(disk.subarray(0, 64)), endpoint, fetchImpl, prior);
    prior.push(choice);
    if (choice.op === 'finish') break;
    if (choice.op === 'observe') {
      view = await lab.observe();
      continue;
    }
    if (choice.op === 'readBackend') {
      disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
      continue;
    }
    if (choice.op === 'mutateBackend' && choice.needleHex) {
      const receipt = await lab.mutateBackend({
        eventId: 'barrier',
        kind: 'xor',
        needleHex: choice.needleHex,
        xor: choice.xor ?? 0xff,
      });
      if (receipt.ok) hitEvidence = true;
      view = await lab.observe();
      continue;
    }
    if (choice.op === 'intercept' && choice.eventId && choice.kind) {
      await lab.intercept({
        eventId: choice.eventId,
        kind: choice.kind as 'drop' | 'replace' | 'delay' | 'duplicate' | 'truncate',
        status: choice.status,
        bodyHex: choice.bodyHex,
      });
      hitEvidence = true;
      view = await lab.observe();
      continue;
    }
    if (choice.op === 'submitClaim') {
      // Claims without hit evidence are recorded but do not invent success.
      if (!hitEvidence && choice.kind !== 'plaintext') {
        continue;
      }
      await lab.submitClaim({
        kind: (choice.kind as 'plaintext' | 'forged-accepted' | 'cursor-overrun') ?? 'plaintext',
        evidence: choice.evidence,
      });
    }
  }
  return lab.finish();
}

export type AttackGoal = 'insider-read' | 'forge-content' | 'ledger-fork' | 'any';

const GOALS: Record<AttackGoal, string> = {
  'insider-read':
    'Goal: read content written after a member was removed. When a member is removed ' +
    'its retained keys become yours (view.insiders). Honest writers rotate the epoch ' +
    'after removal; try to keep some honest member unaware of the removal or rotation ' +
    '(forkView on its control or keys stream) so it seals with a key the insider holds, ' +
    'then insiderRead and submitClaim the recovered post-removal text.',
  'forge-content':
    'Goal: make an honest member accept ledger records or content that nobody ' +
    'authorised (mutateBackend on backend bytes, intercept replace of a pending read), ' +
    'then submitClaim kind forged-accepted.',
  'ledger-fork':
    'Goal: show different ledger tails to different members (forkView control for one ' +
    'member while others continue) and get the stale member to act on the old state.',
  any: 'Goal: break confidentiality, integrity or durability by any AttackLab action.',
};

export interface CollabAgentOptions {
  readonly goal?: AttackGoal;
  /** Sampling temperature; non-zero by default so repeated runs explore. */
  readonly temperature?: number;
  /** Provider sampling seed when supported; recorded with the evidence. */
  readonly seed?: number;
  /** Model calls for the whole run. */
  readonly maxDecisions?: number;
  readonly fetch?: LabFetch;
}

export function collabAgentOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CollabAgentOptions {
  const goal = env.E2EE_AGENT_GOAL as AttackGoal | undefined;
  const number = (value: string | undefined) =>
    value === undefined || value === '' || Number.isNaN(Number(value)) ? undefined : Number(value);
  return {
    goal: goal && goal in GOALS ? goal : undefined,
    temperature: number(env.E2EE_AGENT_TEMPERATURE),
    seed: number(env.E2EE_AGENT_SEED),
    maxDecisions: number(env.E2EE_AGENT_MAX_DECISIONS),
  };
}

type Decision = {
  op?: string;
  until?: string;
  actor?: string;
  stream?: string;
  insider?: string;
  kind?: string;
  status?: number;
  bodyHex?: string;
  needleHex?: string;
  xor?: number;
  evidence?: string;
  why?: string;
};

type HistoryRow = { readonly step: string; readonly decision: Decision; readonly result: string };

const INTERCEPT_KINDS = new Set(['drop', 'replace', 'delay', 'duplicate', 'truncate']);
const CLAIM_KINDS = new Set(['plaintext', 'forged-accepted', 'cursor-overrun']);

function collabSystemPrompt(goal: AttackGoal): string {
  return [
    'You attack an E2EE collaboration while honest members keep working; the step list is',
    'the honest script. You act only at step boundaries through AttackLab and never see',
    'honest keys. Reply with ONE JSON decision:',
    '{"op":"wait","until":"<remaining step>"}',
    '| {"op":"forkView","actor":"<member>","stream":"control|keys|loro|flock"}',
    '| {"op":"releaseView","actor":"<member>","stream":"..."}',
    '| {"op":"insiderRead","insider":"<name from insiders>"}',
    '| {"op":"intercept","kind":"drop|replace|delay|duplicate|truncate","actor":"<member>?","status":502?,"bodyHex":"..."?}',
    '| {"op":"mutateBackend","needleHex":"...","xor":255}',
    '| {"op":"submitClaim","kind":"plaintext|forged-accepted|cursor-overrun","evidence":"..."}',
    '| {"op":"stop"}.',
    'Add "why" (one sentence). insiderRead returns decrypted text immediately and you may',
    'decide again. feedback lists errors from your previous actions; adapt instead of',
    'repeating them. Never guess plaintext or keys; claims must quote text you recovered.',
    'Budget exhaustion is not a finding.',
    GOALS[goal],
  ].join(' ');
}

function summarizeFrames(
  frames: readonly { stream: string; epoch: number; decrypted: boolean; text: string }[]
): string {
  const opened = frames.filter((frame) => frame.decrypted);
  const printable = opened
    .map((frame) => frame.text.replace(/[^\x20-\x7e]+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .map((text) => text.slice(0, 160));
  return JSON.stringify({
    frames: frames.length,
    decrypted: opened.length,
    epochs: [...new Set(frames.map((frame) => `${frame.stream}@${frame.epoch}`))],
    text: printable.slice(-12),
  });
}

/**
 * Real-model attacker for the ongoing-collaboration scenario: a budgeted
 * observe/decide/act loop over the whole script. The model may wait for a
 * named step, act, see its errors and insider reads, and act again. Every
 * applied action is recorded by AttackLab, so replay needs no model.
 */
export function collabModelAgent(
  endpoint: AgentEndpoint,
  options: CollabAgentOptions = {}
): CollabAgent & {
  probe(): Promise<void>;
  readonly history: readonly HistoryRow[];
  readonly sampling: { temperature: number; seed: number; goal: AttackGoal };
} {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const goal = options.goal ?? 'insider-read';
  const sampling = {
    temperature: options.temperature ?? 0.7,
    seed: options.seed ?? Math.floor(Math.random() * 2 ** 31),
  };
  const maxDecisions = options.maxDecisions ?? 12;
  const history: HistoryRow[] = [];
  let decisions = 0;
  let waitUntil: string | undefined;
  let stopped = false;

  const decide = async (turn: AgentTurn): Promise<Decision> => {
    decisions += 1;
    const parsed = await completeJson(
      endpoint,
      fetchImpl,
      [
        { role: 'system', content: collabSystemPrompt(goal) },
        {
          role: 'user',
          content: JSON.stringify({
            step: turn.stepName,
            remainingSteps: turn.remainingSteps,
            requested: turn.view.events.filter((event) => event.status === 'requested').slice(-8),
            insiders: turn.view.insiders,
            views: turn.view.views,
            errors: turn.view.errors,
            feedback: turn.feedback,
            history: history.slice(-10),
            budget: maxDecisions - decisions,
          }),
        },
      ],
      sampling
    );
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Decision;
  };

  const toAction = (turn: AgentTurn, decision: Decision): AttackAction | string => {
    switch (decision.op) {
      case 'forkView':
      case 'releaseView': {
        if (!(VIEW_STREAMS as readonly string[]).includes(decision.stream ?? '')) {
          return 'invalid stream';
        }
        const input = { actor: String(decision.actor ?? ''), stream: decision.stream };
        return decision.op === 'forkView'
          ? { op: 'forkView', input: { ...input, eventId: 'barrier' } }
          : { op: 'releaseView', input };
      }
      case 'intercept': {
        if (!INTERCEPT_KINDS.has(decision.kind ?? '')) return 'invalid intercept kind';
        const pending = turn.view.events.find(
          (event) =>
            event.status === 'requested' &&
            event.phase === 'request-queued' &&
            (decision.actor === undefined || event.actor === decision.actor)
        );
        if (!pending) return 'no pending request for that actor at this step';
        return {
          op: 'intercept',
          input: {
            eventId: pending.eventId,
            kind: decision.kind,
            status: decision.status,
            bodyHex: decision.bodyHex,
          },
        };
      }
      case 'mutateBackend':
        if (!decision.needleHex) return 'missing needleHex';
        return {
          op: 'mutateBackend',
          input: { eventId: 'barrier', needleHex: decision.needleHex, xor: decision.xor ?? 0xff },
        };
      case 'submitClaim':
        if (!CLAIM_KINDS.has(decision.kind ?? '')) return 'invalid claim kind';
        return { op: 'submitClaim', input: { kind: decision.kind, evidence: decision.evidence } };
      default:
        return `unsupported op ${String(decision.op)}`;
    }
  };

  return {
    history,
    sampling: { ...sampling, goal },
    async probe() {
      await completeJson(
        endpoint,
        fetchImpl,
        [{ role: 'user', content: 'Reply with the JSON object {"op":"stop"}.' }],
        sampling
      );
    },
    act: async (turn) => {
      if (waitUntil !== undefined) {
        if (!turn.remainingSteps.includes(waitUntil)) waitUntil = undefined;
        else if (turn.stepName !== waitUntil) return 'pass';
        else waitUntil = undefined;
      }
      // Information ops answer inside the same boundary; the loop ends on a real action.
      for (let inner = 0; inner < 3; inner++) {
        if (stopped || decisions >= maxDecisions) return 'pass';
        const decision = await decide(turn);
        if (decision.op === 'stop') {
          stopped = true;
          history.push({ step: turn.stepName, decision, result: 'stopped' });
          return 'pass';
        }
        if (decision.op === 'wait') {
          const until = decision.until;
          const valid = until !== undefined && turn.remainingSteps.slice(1).includes(until);
          if (valid) waitUntil = until;
          history.push({
            step: turn.stepName,
            decision,
            result: valid ? 'waiting' : 'invalid step',
          });
          return 'pass';
        }
        if (decision.op === 'insiderRead') {
          const result = await turn
            .insiderRead({ insider: String(decision.insider ?? '') })
            .then(summarizeFrames, (error: unknown) => `error: ${String(error)}`);
          history.push({ step: turn.stepName, decision, result });
          continue;
        }
        const action = toAction(turn, decision);
        if (typeof action === 'string') {
          history.push({ step: turn.stepName, decision, result: `rejected: ${action}` });
          continue;
        }
        history.push({ step: turn.stepName, decision, result: 'applied' });
        return action;
      }
      return 'pass';
    },
  };
}

/**
 * Scripted deep probe: drop a pending response, xor backend bytes, then finish.
 * Used when no model key is available; still exercises multi-step AttackLab use.
 */
export function collabDeepScriptAgent(needleHex?: string): CollabAgent {
  let phase: 'intercept' | 'mutate' | 'done' = 'intercept';
  return {
    act: async (turn) => {
      if (phase === 'done') return 'pass';
      if (phase === 'intercept') {
        const pending = turn.view.events.find((event) => event.status === 'requested');
        if (!pending) return 'pass';
        phase = needleHex ? 'mutate' : 'done';
        return {
          op: 'intercept',
          input: { eventId: pending.eventId, kind: 'drop', status: 502 },
        };
      }
      phase = 'done';
      if (!needleHex) return 'pass';
      return {
        op: 'mutateBackend',
        input: { eventId: 'barrier', needleHex, xor: 0xff },
      };
    },
  };
}
