import { z } from "zod"
import {
  ContextIntents,
  ContextRefKinds,
  VIEWPORT_MAX_VISIBLE_IDS,
  type ContextIntent,
  type ContextRefKind,
} from "@threahq/types"

/**
 * Shared Zod schemas for the ContextBag wire format.
 *
 * One source of truth used by both:
 * - `POST /api/workspaces/:ws/context-bag/precompute` (handlers.ts)
 * - `POST /api/workspaces/:ws/streams` `contextBag` field (streams/handlers.ts)
 *
 * Two divergent local copies used to drift; centralizing here means a new
 * field (e.g. `originMessageId`, `kind: MEMO`) lands on every accepting
 * surface in one edit (INV-31, INV-33).
 */

// Typed narrowings for the Zod enums: keep the parsed value as the concrete
// union (`ContextIntent` / `ContextRefKind`) instead of bare `string`.
export const contextIntentSchema = z.enum(Object.values(ContextIntents) as [ContextIntent, ...ContextIntent[]])
export const contextRefKindSchema = z.enum(Object.values(ContextRefKinds) as [ContextRefKind, ...ContextRefKind[]])

const threadRefSchema = z.object({
  kind: z.literal(ContextRefKinds.THREAD),
  streamId: z.string().min(1),
  fromMessageId: z.string().min(1).optional(),
  toMessageId: z.string().min(1).optional(),
  /** Cosmetic deep-link anchor; resolver ignores it. */
  originMessageId: z.string().min(1).optional(),
})

const conversationRefSchema = z.object({
  kind: z.literal(ContextRefKinds.CONVERSATION),
  conversationId: z.string().min(1),
  /** The conversation's root stream — the resolver re-derives the authoritative root. */
  streamId: z.string().min(1),
  /** Cosmetic deep-link anchor + focal message; resolver only marks the focal. */
  originMessageId: z.string().min(1).optional(),
})

const viewportRefSchema = z.object({
  kind: z.literal(ContextRefKinds.VIEWPORT),
  streamId: z.string().min(1),
  visibleMessageIds: z.array(z.string().min(1)).min(1).max(VIEWPORT_MAX_VISIBLE_IDS),
  capturedAt: z.string().datetime(),
})

/**
 * Discriminated on `kind` so that future ref kinds (memo, search, etc.) get
 * their own field shape without contaminating another kind's fields.
 */
export const contextRefSchema = z.discriminatedUnion("kind", [
  threadRefSchema,
  conversationRefSchema,
  viewportRefSchema,
])

export const contextBagSchema = z.object({
  intent: contextIntentSchema,
  refs: z.array(contextRefSchema).min(1).max(10),
})

export type ContextRefInput = z.infer<typeof contextRefSchema>
export type ContextBagInput = z.infer<typeof contextBagSchema>
