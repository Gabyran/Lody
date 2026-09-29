/**
 * What each model of an agent config supports, stored per model.
 *
 * An ACP `session/new` response's `configOptions` describe only the model that
 * is current at that moment: agents rebuild the reasoning-effort list and the
 * Fast toggle on every model switch. The Claude and Codex adapters additionally
 * publish every model's controls under `_meta.lody.modelCapabilities`. Lody keeps
 * that declaration in its own machine Flock row, so each model has its own entry
 * instead of the whole agent sharing one model's snapshot.
 */
export type AcpModelControls = {
  /** Reasoning-effort values the model accepts; absent when not declared. */
  effortValues?: string[];
  /** Whether the model has a Fast toggle; absent when not declared. */
  fastMode?: boolean;
};

export type AcpModelCapabilities = {
  version: 1;
  /** Source version of the launch inputs that produced the declaration. */
  sourceVersion: string;
  models: Record<string, AcpModelControls>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseModelControls = (value: unknown): AcpModelControls | undefined => {
  if (!isRecord(value)) return undefined;
  const controls: AcpModelControls = {};
  if (value.effortValues !== undefined) {
    if (
      !Array.isArray(value.effortValues) ||
      !value.effortValues.every((effort) => typeof effort === 'string')
    ) {
      return undefined;
    }
    controls.effortValues = [...value.effortValues];
  }
  if (value.fastMode !== undefined) {
    if (typeof value.fastMode !== 'boolean') return undefined;
    controls.fastMode = value.fastMode;
  }
  return controls;
};

const parseModels = (value: unknown): Record<string, AcpModelControls> | undefined => {
  if (!isRecord(value)) return undefined;
  const models: Record<string, AcpModelControls> = {};
  for (const [modelId, controls] of Object.entries(value)) {
    const parsed = parseModelControls(controls);
    if (!parsed) return undefined;
    models[modelId] = parsed;
  }
  return Object.keys(models).length > 0 ? models : undefined;
};

/**
 * Reads the adapter's `_meta.lody.modelCapabilities` v1 declaration from a
 * session response. Unknown versions and malformed declarations are ignored
 * whole: a partial read would present a model's missing entry as "unsupported".
 */
export const readAcpModelCapabilitiesMeta = (
  sessionResponse: unknown
): Record<string, AcpModelControls> | undefined => {
  if (!isRecord(sessionResponse) || !isRecord(sessionResponse._meta)) return undefined;
  const lody = sessionResponse._meta.lody;
  if (!isRecord(lody) || !isRecord(lody.modelCapabilities)) return undefined;
  const declaration = lody.modelCapabilities;
  return declaration.version === 1 ? parseModels(declaration.models) : undefined;
};

export const isAcpModelCapabilities = (value: unknown): value is AcpModelCapabilities =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.sourceVersion === 'string' &&
  parseModels(value.models) !== undefined;

/**
 * The declared controls of one model, or undefined when the declaration does
 * not cover it. An undeclared model is unknown, never "unsupported".
 */
export const getDeclaredModelControls = (
  entry: { declaredModelControls?: Record<string, AcpModelControls> } | undefined,
  modelId: string | null | undefined
): AcpModelControls | undefined => (modelId ? entry?.declaredModelControls?.[modelId] : undefined);

/**
 * How a built-in adapter exposes reasoning effort, for turning a model
 * declaration into the control the adapter really offers. Unknown agents have
 * no binding: Lody never guesses their option ids.
 *
 * - `configId`: the option id the adapter uses for effort.
 * - `providerDefaultValue`: a value the adapter offers on top of the model's
 *   levels. Claude publishes `default` (clear the effort pin and follow the
 *   provider's default) unless the client negotiates AIR `recommendedValue`,
 *   which Lody does not; its declaration lists only the model's levels.
 * - `omittedMeansUnsupported`: the adapter omits `effortValues` exactly when a
 *   model has no effort control, so a declared model without them is
 *   unsupported rather than unknown.
 */
type BuiltinEffortBinding = {
  configId: string;
  label: string;
  providerDefaultValue?: { value: string; name: string };
  omittedMeansUnsupported: boolean;
};

const BUILTIN_EFFORT_BINDINGS: Record<string, BuiltinEffortBinding> = {
  claude: {
    configId: 'effort',
    label: 'Effort',
    providerDefaultValue: { value: 'default', name: 'Default' },
    omittedMeansUnsupported: true,
  },
  codex: {
    configId: 'reasoning_effort',
    label: 'Reasoning effort',
    omittedMeansUnsupported: false,
  },
};

export const getBuiltinEffortBinding = (agent: {
  cliType?: string | null;
  agentType?: string | null;
}): BuiltinEffortBinding | undefined =>
  agent.cliType === 'builtin' && agent.agentType
    ? BUILTIN_EFFORT_BINDINGS[agent.agentType.toLowerCase()]
    : undefined;

export type DeclaredEffortSupport =
  | {
      state: 'supported';
      /** Every value the control accepts, including the provider default. */
      values: string[];
      /** Value to fall back to when the current one is not offered. */
      fallbackValue: string;
    }
  | { state: 'unsupported' }
  | { state: 'unknown' };

/**
 * The effort control the selected model really has, from its declaration.
 * A model the declaration does not cover is unknown, and so is an omitted
 * list for an adapter whose omission means nothing.
 */
export const resolveDeclaredEffortSupport = (
  entry: { declaredModelControls?: Record<string, AcpModelControls> } | undefined,
  modelId: string | null | undefined,
  agent: { cliType?: string | null; agentType?: string | null }
): DeclaredEffortSupport => {
  const controls = getDeclaredModelControls(entry, modelId);
  if (!controls) return { state: 'unknown' };
  const binding = getBuiltinEffortBinding(agent);
  const levels = controls.effortValues;
  if (levels === undefined) {
    return binding?.omittedMeansUnsupported ? { state: 'unsupported' } : { state: 'unknown' };
  }
  if (levels.length === 0) return { state: 'unsupported' };
  const providerDefault = binding?.providerDefaultValue?.value;
  return {
    state: 'supported',
    values: providerDefault ? [providerDefault, ...levels] : [...levels],
    fallbackValue: providerDefault ?? (levels.includes('medium') ? 'medium' : levels[0]!),
  };
};

/**
 * Reasoning-effort values a model accepts for validation: the declared control
 * (including a provider default) first, then the legacy per-model map.
 * Undefined means unknown; an empty list means the model has no effort control.
 */
export const getModelEffortChoices = (
  entry:
    | {
        declaredModelControls?: Record<string, AcpModelControls>;
        modelReasoningEfforts?: Record<string, string[]>;
      }
    | undefined,
  modelId: string | null | undefined,
  agent: { cliType?: string | null; agentType?: string | null }
): string[] | undefined => {
  const declared = resolveDeclaredEffortSupport(entry, modelId, agent);
  if (declared.state === 'supported') return declared.values;
  if (declared.state === 'unsupported') return [];
  return modelId ? entry?.modelReasoningEfforts?.[modelId] : undefined;
};

/** Option ids that carry a per-model control (effort or Fast) for any agent Lody knows. */
export const isPerModelControlConfigId = (configId: string): boolean =>
  configId === 'reasoning_effort' ||
  configId === 'effort' ||
  configId === 'fast' ||
  configId === 'fast-mode';

const BUILTIN_FAST_MODE_CONFIG_IDS: Record<string, string> = {
  codex: 'fast-mode',
  claude: 'fast',
};

/** The Fast option id a built-in adapter uses; undefined for unknown agents. */
export const getBuiltinFastModeConfigId = (agent: {
  cliType?: string | null;
  agentType?: string | null;
}): string | undefined =>
  agent.cliType === 'builtin' && agent.agentType
    ? BUILTIN_FAST_MODE_CONFIG_IDS[agent.agentType.toLowerCase()]
    : undefined;
