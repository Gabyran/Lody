import { z } from 'zod';
import { RpcSecretEnvelopeSchema } from './rpc-secret';

const id = z.string().min(1).max(200);
export const IosSimulatorUdidSchema = z.string().uuid();
/** Lifecycle commands are separate from media/input. No caller-supplied ports or commands. */
export const IosSimulatorCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('start'), udid: IosSimulatorUdidSchema }).strict(),
  z.object({ action: z.literal('status'), operationId: id.optional() }).strict(),
  z.object({ action: z.literal('stop'), operationId: id }).strict(),
]);
export const IosSimulatorRequestSchema = z
  .object({
    sessionId: id,
    requestedByUserId: id,
    command: IosSimulatorCommandSchema,
  })
  .strict();
export const IosSimulatorDeviceSchema = z
  .object({
    udid: IosSimulatorUdidSchema,
    name: z.string(),
    runtime: z.string(),
    deviceType: z.string(),
    state: z.string(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
    occupancy: z.enum(['available', 'this-session', 'other-session']),
  })
  .strict();
export const IosSimulatorPreviewSchema = z
  .object({
    operationId: id,
    udid: IosSimulatorUdidSchema,
    phase: z.enum(['preparing', 'booting', 'connecting', 'ready', 'closed', 'failed']),
    transport: z.enum(['local', 'remote']),
    viewerUrl: z.string().url().optional(),
    message: z.string().optional(),
  })
  .strict();
export const IosSimulatorResponseSchema = z
  .object({
    type: z.literal('ios-simulator/control_response'),
    sessionId: id,
    success: z.boolean(),
    devices: z.array(IosSimulatorDeviceSchema).optional(),
    preview: IosSimulatorPreviewSchema.optional(),
    error: z
      .enum(['unsupported', 'environment', 'occupied', 'unavailable', 'denied', 'failed'])
      .optional(),
    message: z.string().optional(),
  })
  .strict();
export type IosSimulatorCommand = z.infer<typeof IosSimulatorCommandSchema>;
export type IosSimulatorRequest = z.infer<typeof IosSimulatorRequestSchema>;
export type IosSimulatorDevice = z.infer<typeof IosSimulatorDeviceSchema>;
export type IosSimulatorPreview = z.infer<typeof IosSimulatorPreviewSchema>;
export type IosSimulatorResponse = z.infer<typeof IosSimulatorResponseSchema>;

/** Workspace streams are shared: never put a bearer viewer URL in a remote result. */
export const IosSimulatorRemoteResponseSchema = IosSimulatorResponseSchema.extend({
  preview: IosSimulatorPreviewSchema.omit({ viewerUrl: true })
    .extend({
      viewerUrlEnvelope: RpcSecretEnvelopeSchema.optional(),
    })
    .strict()
    .refine((p) => p.phase !== 'ready' || p.viewerUrlEnvelope !== undefined)
    .optional(),
}).strict();
export type IosSimulatorRemoteResponse = z.infer<typeof IosSimulatorRemoteResponseSchema>;
