import { z } from "zod"

export const CALL_MEDIA_TRANSPORTS = ["sfu", "p2p"] as const
export type CallMediaTransport = (typeof CALL_MEDIA_TRANSPORTS)[number]

export const CALL_TRANSPORT_CAPABILITIES = ["p2p-v1"] as const
export type CallTransportCapability = (typeof CALL_TRANSPORT_CAPABILITIES)[number]

export const CALL_TRANSFER_CAPABILITIES = ["transport-transfer-v1"] as const
export type CallTransferCapability = (typeof CALL_TRANSFER_CAPABILITIES)[number]

export const CALL_TRANSFER_PHASES = ["preparing", "committing", "draining", "aborting", "failed", "completed"] as const
export type CallTransferPhase = (typeof CALL_TRANSFER_PHASES)[number]

export const CALL_TRANSFER_CAUSES = ["explicit"] as const
export type CallTransferCause = (typeof CALL_TRANSFER_CAUSES)[number]

export const callTransportGenerationSchema = z.object({
  generation: z.number().int().positive(),
  transport: z.enum(CALL_MEDIA_TRANSPORTS),
})

export const callExpectedPublicationSchema = z.object({
  endpointId: z.string().min(1),
  endpointEpoch: z.number().int().nonnegative(),
  mediaIncarnation: z.string().min(1).max(128),
  kind: z.enum(["mic", "camera"]),
  publicationId: z.string().min(1).max(128),
  publicationRevision: z.number().int().nonnegative(),
  muted: z.boolean().optional(),
})
export type CallExpectedPublication = z.infer<typeof callExpectedPublicationSchema>

export const callTransportSessionSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  endpointEpoch: z.number().int().nonnegative(),
  mediaIncarnation: z.string().min(1).max(128),
  generation: z.number().int().positive(),
  transport: z.enum(CALL_MEDIA_TRANSPORTS),
  status: z.enum(["preparing", "ready", "active", "draining", "closed", "failed"]),
  providerSessionId: z.string().nullable(),
  publicationRevision: z.number().int().nonnegative(),
  publishedTracks: z.array(
    z.object({
      kind: z.enum(["mic", "camera", "share_video", "share_audio"]),
      trackName: z.string(),
      publicationId: z.string().optional(),
      transportGeneration: z.number().int().positive().optional(),
    })
  ),
})
export type CallTransportSession = z.infer<typeof callTransportSessionSchema>

export const callTransferObligationSchema = z.object({
  endpointId: z.string().min(1),
  endpointEpoch: z.number().int().nonnegative(),
  mediaIncarnation: z.string().min(1).max(128),
  membershipRevision: z.number().int().nonnegative(),
  trackRevision: z.number().int().nonnegative(),
  expectedPublications: z.array(callExpectedPublicationSchema),
  readyPublications: z.array(callExpectedPublicationSchema),
  ownPublicationsReady: z.boolean(),
  switched: z.boolean(),
  sourceReleased: z.boolean(),
  restoredToSource: z.boolean(),
})
export type CallTransferObligation = z.infer<typeof callTransferObligationSchema>

export const callTransportTransferSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  source: callTransportGenerationSchema,
  target: callTransportGenerationSchema,
  membershipRevision: z.number().int().nonnegative(),
  phase: z.enum(CALL_TRANSFER_PHASES),
  cause: z.enum(CALL_TRANSFER_CAUSES),
  failureCode: z.string().max(128).nullable(),
  recoveryCode: z.string().max(128).nullable(),
  sessions: z.array(callTransportSessionSchema),
  obligations: z.array(callTransferObligationSchema),
})
export type CallTransportTransfer = z.infer<typeof callTransportTransferSchema>

export const requestCallTransportTransferSchema = z.object({
  target: z.enum(CALL_MEDIA_TRANSPORTS),
  idempotencyKey: z.string().min(1).max(128),
})
export type RequestCallTransportTransfer = z.infer<typeof requestCallTransportTransferSchema>

const transferAckIdentitySchema = z.object({
  transferId: z.string().min(1),
  generation: z.number().int().positive(),
  endpointId: z.string().min(1),
  endpointEpoch: z.number().int().nonnegative(),
  mediaIncarnation: z.string().min(1).max(128),
  membershipRevision: z.number().int().nonnegative(),
  trackRevision: z.number().int().nonnegative(),
})

export const callTransferReadyAckSchema = transferAckIdentitySchema.extend({
  ownPublicationsReady: z.literal(true),
  readyPublications: z.array(callExpectedPublicationSchema),
})
export const callTransferSwitchedAckSchema = transferAckIdentitySchema
export const callTransferRestoredAckSchema = transferAckIdentitySchema
export type CallTransferReadyAck = z.infer<typeof callTransferReadyAckSchema>
export type CallTransferSwitchedAck = z.infer<typeof callTransferSwitchedAckSchema>
export type CallTransferRestoredAck = z.infer<typeof callTransferRestoredAckSchema>

export const P2P_SIGNAL_KINDS = ["description", "candidate", "end-of-candidates"] as const
export type P2pSignalKind = (typeof P2P_SIGNAL_KINDS)[number]

export const p2pSignalSchema = z
  .object({
    callId: z.string().min(1),
    recipientEndpointId: z.string().min(1),
    recipientEpoch: z.number().int().nonnegative(),
    recipientMediaIncarnation: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    negotiationId: z.string().min(1).max(128),
    kind: z.enum(P2P_SIGNAL_KINDS),
    description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().min(1).max(200_000) }).optional(),
    candidate: z
      .object({
        candidate: z.string().max(4096),
        sdpMid: z.string().max(128).nullable().optional(),
        sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .optional(),
  })
  .superRefine((signal, ctx) => {
    if (signal.kind === "description" && !signal.description) {
      ctx.addIssue({ code: "custom", message: "description is required", path: ["description"] })
    }
    if (signal.kind === "candidate" && !signal.candidate) {
      ctx.addIssue({ code: "custom", message: "candidate is required", path: ["candidate"] })
    }
    if (signal.kind !== "description" && signal.description) {
      ctx.addIssue({ code: "custom", message: "description is not allowed", path: ["description"] })
    }
    if (signal.kind !== "candidate" && signal.candidate) {
      ctx.addIssue({ code: "custom", message: "candidate is not allowed", path: ["candidate"] })
    }
  })

export const p2pPublicationSchema = z
  .object({
    generation: z.number().int().positive(),
    revision: z.number().int().positive().max(2_147_483_647),
    publications: z
      .array(
        z.object({
          kind: z.enum(["mic", "camera"]),
          publicationId: z.string().min(1).max(128),
        })
      )
      .max(2),
  })
  .refine((body) => new Set(body.publications.map(({ kind }) => kind)).size === body.publications.length, {
    message: "publications must be unique per kind",
    path: ["publications"],
  })

export type P2pSignal = z.infer<typeof p2pSignalSchema>

export interface P2pSignalEnvelope extends P2pSignal {
  senderEndpointId: string
  senderEpoch: number
  senderMediaIncarnation: string
}

export const turnCredentialsResponseSchema = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional(),
    })
  ),
  expiresAt: z.string().datetime(),
})
export type TurnCredentialsResponse = z.infer<typeof turnCredentialsResponseSchema>
