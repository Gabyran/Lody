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
 * Reasoning-effort values a model accepts: the adapter's declaration first,
 * then the legacy per-model map. Undefined means unknown for that model.
 */
export const getModelReasoningEffortValues = (
  entry:
    | {
        declaredModelControls?: Record<string, AcpModelControls>;
        modelReasoningEfforts?: Record<string, string[]>;
      }
    | undefined,
  modelId: string | null | undefined
): string[] | undefined =>
  modelId
    ? (entry?.declaredModelControls?.[modelId]?.effortValues ??
      entry?.modelReasoningEfforts?.[modelId])
    : undefined;
