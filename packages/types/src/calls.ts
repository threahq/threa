import { z } from "zod"

export const CALL_MEDIA_TRANSPORTS = ["sfu", "p2p"] as const
export type CallMediaTransport = (typeof CALL_MEDIA_TRANSPORTS)[number]

export const CALL_TRANSPORT_CAPABILITIES = ["p2p-v1"] as const
export type CallTransportCapability = (typeof CALL_TRANSPORT_CAPABILITIES)[number]

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

export const p2pPublicationSchema = z.object({
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
  publications: z
    .array(
      z.object({
        kind: z.enum(["mic", "camera"]),
        publicationId: z.string().min(1).max(128),
      })
    )
    .max(2),
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
