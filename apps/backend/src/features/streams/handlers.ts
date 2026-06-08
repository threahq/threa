import { z } from "zod"
import type { Request, Response } from "express"
import type { StreamService } from "./service"
import type { EventService } from "../messaging"
import { collectSharedMessageIds, hydrateSharedMessageIds, type HydratedSharedMessage } from "../messaging"
import type { ActivityService } from "../activity"
import type { LinkPreviewService } from "../link-previews"
import type { BotRuntimeService } from "../bot-runtimes"
import type { CommandAvailabilityService } from "../commands"
import type { StreamEvent } from "./event-repository"
import type { EventType, JSONContent, LinkPreviewSummary, StreamType, E2eKeyWrapsResponse } from "@threa/types"
import {
  ARIADNE_PERSONA_SLUG,
  StreamTypes,
  SLUG_PATTERN,
  CompanionModes,
  E2E_ACTOR_KINDS,
  E2E_KEY_WRAP_RECIPIENT_KINDS,
} from "@threa/types"
import type { Pool } from "pg"
import { PersonaRepository, getResolver, fetchStreamBag, contextBagSchema } from "../agents"
import { UserE2eKeysRepository } from "../user-e2e-keys"
import { serializeBigInt } from "@threa/backend-common"
import { HttpError } from "../../lib/errors"
import { streamTypeSchema, visibilitySchema, companionModeSchema, notificationLevelSchema } from "../../lib/schemas"

const createStreamSchema = z
  .object({
    type: streamTypeSchema.extract(["scratchpad", "channel", "thread"]),
    slug: z
      .string()
      .regex(SLUG_PATTERN, {
        message: "Slug must start with a letter and contain only lowercase letters, numbers, hyphens, or underscores",
      })
      .optional(),
    displayName: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    visibility: visibilitySchema.optional(),
    companionMode: companionModeSchema.optional(),
    companionPersonaId: z.string().optional(),
    parentStreamId: z.string().optional(),
    parentMessageId: z.string().optional(),
    memberIds: z.array(z.string().min(1)).max(50).optional(),
    /**
     * Optional context-bag attached at creation time. Powers "Discuss with
     * Ariadne": when present on a scratchpad, the pre-compute handler warms
     * the shared summary cache so the first real user turn is fast.
     *
     * `z.lazy` defers dereferencing `contextBagSchema` until parse time. The
     * agents-barrel re-export lives behind a transitive cycle
     * (streams/handlers → messaging/sharing → agents → streams → handlers),
     * so without lazy evaluation the binding is in TDZ at module-eval and
     * the backend crashes on boot.
     */
    contextBag: z.lazy(() => contextBagSchema).optional(),
    /**
     * E2E activation at stream-creation time. When `e2eEnabled` is true,
     * `ownerKeyId` must reference the caller's active key in
     * `user_e2e_keys`; the handler verifies ownership and the service marks
     * the stream in `e2e_streams` inside the same transaction as the
     * stream insert. Only scratchpads can be E2E in Phase 1.
     */
    e2eEnabled: z.literal(true).optional(),
    e2eOwnerKeyId: z.string().min(1).optional(),
  })
  .refine((data) => data.type !== "channel" || data.slug, {
    message: "Slug is required for channels",
    path: ["slug"],
  })
  .refine((data) => data.type !== "thread" || (data.parentStreamId && data.parentMessageId), {
    message: "parentStreamId and parentMessageId are required for threads",
    path: ["parentStreamId"],
  })
  .refine((data) => !data.contextBag || data.type === "scratchpad", {
    message: "contextBag is only supported on scratchpad creation",
    path: ["contextBag"],
  })
  .refine((data) => !data.e2eEnabled || data.type === "scratchpad", {
    message: "E2E encryption is only supported on scratchpad creation",
    path: ["e2eEnabled"],
  })
  .refine((data) => !data.e2eEnabled || !!data.e2eOwnerKeyId, {
    message: "e2eOwnerKeyId is required when e2eEnabled is true",
    path: ["e2eOwnerKeyId"],
  })
  .refine((data) => !data.e2eEnabled || !data.contextBag, {
    message: "contextBag and E2E are mutually exclusive in Phase 1",
    path: ["e2eEnabled"],
  })

// Canonical base64 (correct alphabet + padding/length). Rejects e.g. "!!!!" or
// "YWJj$" so a malformed sealed ciphertext can't be Buffer.from-decoded to junk.
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

// Sealed display name for an E2E stream: SSK-sealed ciphertext + its framing.
// The server stores these opaque (it can't read them); the envelope shape
// mirrors `StreamEnvelope` from @threa/crypto without importing it here.
const sealedNameEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.string().min(1),
  aad: z.string().min(1),
})

const updateStreamSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    slug: z
      .string()
      .regex(SLUG_PATTERN, {
        message: "Slug must start with a letter and contain only lowercase letters, numbers, hyphens, or underscores",
      })
      .optional(),
    description: z.string().max(500).optional(),
    visibility: visibilitySchema.optional(),
    // Optional encrypted name. Strict base64 so a malformed ciphertext can't be
    // decoded to garbage by the permissive Buffer.from. `null` on both clears the
    // sealed name (rename without a fresh seal); a ciphertext without its
    // envelope (or vice versa) is unopenable.
    sealedNameCiphertext: z.string().min(1).regex(BASE64_PATTERN, "must be base64").nullable().optional(),
    sealedNameEnvelope: sealedNameEnvelopeSchema.nullable().optional(),
  })
  .refine(
    (v) => {
      const c = v.sealedNameCiphertext
      const e = v.sealedNameEnvelope
      if (c === undefined && e === undefined) return true // omitted: leave untouched
      if (c === null && e === null) return true // cleared together
      return typeof c === "string" && e != null // set together
    },
    {
      message: "sealedNameCiphertext and sealedNameEnvelope must be set together, cleared together, or omitted",
      path: ["sealedNameCiphertext"],
    }
  )

const updateCompanionModeSchema = z.object({
  companionMode: companionModeSchema,
  companionPersonaId: z.string().nullable().optional(),
})

const setNotificationLevelSchema = z.object({
  notificationLevel: notificationLevelSchema.nullable(),
})

const markAsReadSchema = z.object({
  lastEventId: z.string(),
})

const checkSlugAvailableSchema = z.object({
  slug: z.string().min(1, "slug query parameter is required"),
  exclude: z.string().optional(),
})

const addMemberSchema = z.object({
  memberId: z.string().min(1, "memberId is required"),
})

const inviteActorSchema = z
  .object({
    kind: z.enum(E2E_ACTOR_KINDS),
    // The pinned principal. Required for a bot (its bot_id); ignored for the
    // enclave, which always uses its singleton sentinel id server-side.
    actorId: z.string().min(1).max(128).optional(),
  })
  .refine((d) => d.kind !== "bot" || !!d.actorId, {
    message: "actorId is required when inviting a bot",
    path: ["actorId"],
  })

/**
 * Owner SSK wrap body. The wraps are tiny (X25519 enc + AES-wrapped 32-byte
 * key, base64), so a kilobyte cap is generous while bounding a malformed
 * client. The slot is derived server-side from the stream's owner key — the
 * client only supplies the opaque HPKE bytes.
 */
const storeKeyWrapSchema = z.object({
  wrapEnc: z.string().min(1).max(1024),
  wrapCt: z.string().min(1).max(1024),
})

/**
 * Generation-roll body: a fresh SSK wrapped to every recipient at the new
 * generation. Same per-wrap byte caps as `storeKeyWrapSchema`. The recipient
 * list is bounded so a malformed client can't ask us to insert an unbounded
 * batch — a scratchpad's recipient set (owner + a bot's instances + live
 * enclaves) is small.
 */
const rollKeySchema = z.object({
  keyGeneration: z.number().int().min(1),
  wraps: z
    .array(
      z.object({
        recipientKeyId: z.string().min(1).max(128),
        recipientKind: z.enum(E2E_KEY_WRAP_RECIPIENT_KINDS),
        wrapEnc: z.string().min(1).max(1024),
        wrapCt: z.string().min(1).max(1024),
      })
    )
    .min(1)
    .max(64),
})

/**
 * Actor-wrap revive body: re-wraps of the *current* SSK (generation 0 is
 * valid — an owner-only stream that never rolled) to invited actors' live
 * keys. Same per-wrap caps as `rollKeySchema`; the service rejects `user`
 * recipients and keys that aren't live actor keys.
 */
const actorRewrapSchema = z.object({
  keyGeneration: z.number().int().min(0),
  wraps: z
    .array(
      z.object({
        recipientKeyId: z.string().min(1).max(128),
        recipientKind: z.enum(E2E_KEY_WRAP_RECIPIENT_KINDS),
        wrapEnc: z.string().min(1).max(1024),
        wrapCt: z.string().min(1).max(1024),
      })
    )
    .min(1)
    .max(64),
})

/** Default number of events returned in bootstrap and event list queries. */
const EVENTS_DEFAULT_LIMIT = 50

const numericString = z.string().regex(/^\d+$/, "must be a numeric string")

const listEventsQuerySchema = z
  .object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    after: numericString.optional(),
    before: numericString.optional(),
  })
  .refine((d) => !(d.after && d.before), {
    message: "after and before are mutually exclusive",
    path: ["after"],
  })

const listEventsAroundQuerySchema = z
  .object({
    eventId: z.string().optional(),
    messageId: z.string().optional(),
    limit: z.coerce.number().int().min(2).max(100).optional(),
  })
  .refine((d) => d.eventId ?? d.messageId, {
    message: "eventId or messageId is required",
    path: ["eventId"],
  })
  .refine((d) => !(d.eventId && d.messageId), {
    message: "provide eventId or messageId, not both",
    path: ["eventId"],
  })

const streamBootstrapQuerySchema = z.object({
  after: numericString.optional(),
})

// Exhaustive: adding a StreamType forces a decision here
const addMemberAllowed: Record<StreamType, boolean> = {
  [StreamTypes.CHANNEL]: true,
  [StreamTypes.THREAD]: true,
  [StreamTypes.SCRATCHPAD]: false,
  [StreamTypes.DM]: false,
  [StreamTypes.SYSTEM]: false,
}

const disallowedUpdateFields: Record<StreamType, Record<string, string> | null> = {
  [StreamTypes.CHANNEL]: { displayName: "Channels cannot set displayName — use slug" },
  [StreamTypes.SCRATCHPAD]: { slug: "Scratchpads do not have slugs", visibility: "Scratchpads are always private" },
  [StreamTypes.THREAD]: {
    slug: "Threads inherit slug and visibility from parent",
    visibility: "Threads inherit slug and visibility from parent",
  },
  [StreamTypes.DM]: null,
  [StreamTypes.SYSTEM]: null,
}

function updateSchemaForType(streamType: StreamType) {
  const disallowed = disallowedUpdateFields[streamType]
  if (disallowed === null) return null

  return updateStreamSchema.superRefine((data, ctx) => {
    for (const [field, message] of Object.entries(disallowed)) {
      if (data[field as keyof typeof data] !== undefined) {
        ctx.addIssue({ code: "custom", path: [field], message })
      }
    }
  })
}

export {
  createStreamSchema,
  updateStreamSchema,
  updateCompanionModeSchema,
  setNotificationLevelSchema,
  markAsReadSchema,
}

interface Dependencies {
  pool: Pool
  streamService: StreamService
  eventService: EventService
  activityService?: ActivityService
  linkPreviewService: LinkPreviewService
  botRuntimeService: BotRuntimeService
  commandAvailabilityService: CommandAvailabilityService
}

/**
 * Scan event payloads for `sharedMessage` node references and fetch the
 * hydrated content + metadata for each source message. Returned as a
 * `sourceMessageId → payload` map that the frontend overlays onto pointer
 * node renders.
 */
async function hydrateSharedMessagesForEvents(
  pool: Pool,
  workspaceId: string,
  viewerId: string,
  events: StreamEvent[]
): Promise<Record<string, HydratedSharedMessage>> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.eventType === "message_created" || event.eventType === "message_edited") {
      const payload = event.payload as { contentJson?: JSONContent }
      if (payload.contentJson) collectSharedMessageIds(payload.contentJson, ids)
    }
  }
  if (ids.size === 0) return {}
  return hydrateSharedMessageIds(pool, workspaceId, viewerId, ids)
}

function serializeEvent(event: StreamEvent) {
  return serializeBigInt(event)
}

function areLinkPreviewArraysEqual(current: LinkPreviewSummary[] | undefined, next: LinkPreviewSummary[]): boolean {
  if (!current) return next.length === 0
  if (current.length !== next.length) return false

  return current.every((preview, index) => {
    const nextPreview = next[index]
    return (
      preview.id === nextPreview.id &&
      preview.url === nextPreview.url &&
      preview.title === nextPreview.title &&
      preview.description === nextPreview.description &&
      preview.imageUrl === nextPreview.imageUrl &&
      preview.faviconUrl === nextPreview.faviconUrl &&
      preview.siteName === nextPreview.siteName &&
      preview.contentType === nextPreview.contentType &&
      preview.position === nextPreview.position
    )
  })
}

export function applyLinkPreviewStateToEvents(
  events: StreamEvent[],
  previewMap: Map<string, LinkPreviewSummary[]>,
  dismissals: Set<string>
): StreamEvent[] {
  if (previewMap.size === 0 && dismissals.size === 0) return events

  let changed = false
  const nextEvents = events.map((event) => {
    if (event.eventType !== "message_created") return event

    const payload = event.payload as { messageId?: string; linkPreviews?: LinkPreviewSummary[] }
    if (!payload.messageId) return event

    const previews = previewMap.get(payload.messageId) ?? payload.linkPreviews
    if (!previews) return event

    const visiblePreviews = previews.filter((preview) => !dismissals.has(`${payload.messageId}:${preview.id}`))
    if (areLinkPreviewArraysEqual(payload.linkPreviews, visiblePreviews)) {
      return event
    }

    changed = true
    return {
      ...event,
      payload: {
        ...payload,
        linkPreviews: visiblePreviews,
      },
    }
  })

  return changed ? nextEvents : events
}

async function enrichEventsWithLinkPreviews(
  linkPreviewService: LinkPreviewService,
  workspaceId: string,
  userId: string,
  events: StreamEvent[]
): Promise<StreamEvent[]> {
  const messageIds = events
    .filter((event) => event.eventType === "message_created")
    .map((event) => (event.payload as { messageId?: string }).messageId)
    .filter((messageId): messageId is string => !!messageId)

  if (messageIds.length === 0) return events

  const [previewMap, dismissals] = await Promise.all([
    linkPreviewService.getPreviewsForMessages(workspaceId, messageIds),
    linkPreviewService.getDismissals(workspaceId, userId, messageIds),
  ])

  return applyLinkPreviewStateToEvents(events, previewMap, dismissals)
}

function serializeBotRuntimePresence(presence: Awaited<ReturnType<BotRuntimeService["findLatestPresence"]>>) {
  return presence
    ? {
        botId: presence.botId,
        runtimeKind: presence.runtimeKind,
        instanceId: presence.instanceId,
        displayName: presence.displayName,
        status: presence.status,
        acceptingInvocations: presence.acceptingInvocations,
        statusText: presence.statusText,
        lastSeenAt: presence.lastSeenAt.toISOString(),
      }
    : null
}

function presenceMatchesRuntimeSessionLink(
  presence: Awaited<ReturnType<BotRuntimeService["findLatestPresence"]>>,
  link: { instanceId: string; runtimeSessionId: string } | null | undefined
): boolean {
  if (!link) return true
  if (!presence || presence.instanceId !== link.instanceId) return false
  return presence.capabilities.runtimeSessionId === link.runtimeSessionId
}

export function createStreamHandlers({
  pool,
  streamService,
  eventService,
  activityService,
  linkPreviewService,
  botRuntimeService,
  commandAvailabilityService,
}: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { stream_type, status } = req.query

      const types = stream_type
        ? ((Array.isArray(stream_type) ? stream_type : [stream_type]) as ("scratchpad" | "channel")[])
        : undefined

      const archiveStatus = status
        ? ((Array.isArray(status) ? status : [status]) as ("active" | "archived")[])
        : undefined

      const streams = await streamService.list(workspaceId, userId, { types, archiveStatus })
      res.json({ streams })
    },

    async create(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = createStreamSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const {
        type,
        slug,
        displayName,
        description,
        visibility,
        companionMode,
        companionPersonaId,
        parentStreamId,
        parentMessageId,
        memberIds,
        contextBag,
        e2eEnabled,
        e2eOwnerKeyId,
      } = result.data

      // Verify the caller owns the referenced E2E key BEFORE we hand off to
      // the service. Phase 1 invariant: the stream's `owner_user_key_id`
      // must always be an active key the caller actually controls — anything
      // else would let an attacker bind a scratchpad to someone else's
      // pubkey and lock the real owner out.
      let resolvedE2eOwnerKeyId: string | undefined
      if (e2eEnabled) {
        const key = await UserE2eKeysRepository.getByKeyId(pool, workspaceId, e2eOwnerKeyId!)
        if (!key || key.userId !== userId || key.revokedAt !== null) {
          throw new HttpError("E2E key not found, revoked, or not owned by caller", {
            status: 400,
            code: "E2E_KEY_INVALID",
          })
        }
        resolvedE2eOwnerKeyId = key.keyId
      }

      // When a contextBag is attached, the stream must be a companion-mode
      // scratchpad with Ariadne as the persona — otherwise subsequent user
      // turns against the bag have no persona to respond as. The client never
      // sends Ariadne's id directly; we resolve it server-side so the persona
      // id stays an implementation detail. INV-33: persona slug is the source
      // of truth.
      let resolvedCompanionMode = companionMode
      let resolvedPersonaId = companionPersonaId
      if (e2eEnabled) {
        // Encrypted scratchpads run Ariadne in the *enclave* (sealed), never the
        // plaintext companion path — CompanionHandler skips E2E, so companion
        // mode here can't leak plaintext. It's a real setting: it gates the
        // enclave auto-reply (EnclaveDispatchHandler). Default ON so encrypted
        // Ariadne works out of the box; an explicit "off" means a silent
        // encrypted dump. Persona stays unset — the enclave always runs the
        // built-in Ariadne regardless of `companionPersonaId`.
        resolvedCompanionMode = companionMode ?? CompanionModes.ON
        resolvedPersonaId = undefined
      }
      if (contextBag) {
        // Verify the caller can read every referenced ref BEFORE we persist
        // the bag. INV-8 workspace scoping plus per-kind access checks
        // (membership / visibility) — bag creators can only point at streams
        // they could already see. Bag resolution at render time re-enforces
        // the check, but rejecting at create time gives the user a crisp
        // error instead of a silent empty-context scratchpad.
        for (const ref of contextBag.refs) {
          const resolver = getResolver(ref.kind)
          await resolver.assertAccess(pool, ref, userId, workspaceId)
        }

        const ariadne = await PersonaRepository.findBySlug(pool, ARIADNE_PERSONA_SLUG, workspaceId)
        if (!ariadne) {
          // Workspace-config state, not an internal error: 503 + a domain
          // code so dashboards can filter without flagging this as a server
          // fault. Surfaces clearly to the client during onboarding races
          // (workspace created but Ariadne seed not yet run).
          return res.status(503).json({
            error: {
              code: "ARIADNE_PERSONA_MISSING",
              message: "Ariadne persona not yet provisioned in this workspace",
            },
          })
        }
        resolvedCompanionMode = CompanionModes.ON
        resolvedPersonaId = ariadne.id
      }

      const stream = await streamService.create({
        workspaceId,
        type,
        slug,
        displayName,
        description,
        visibility,
        companionMode: resolvedCompanionMode,
        companionPersonaId: resolvedPersonaId,
        parentStreamId,
        parentMessageId,
        memberIds,
        createdBy: userId,
        contextBag,
        e2e: resolvedE2eOwnerKeyId ? { ownerKeyId: resolvedE2eOwnerKeyId } : undefined,
      })

      res.status(201).json({ stream })
    },

    async get(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const stream = await streamService.validateStreamAccess(streamId, workspaceId, userId)
      res.json({ stream })
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const stream = await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const schema = updateSchemaForType(stream.type)
      if (!schema) {
        throw new HttpError("Cannot update this stream type", { status: 403, code: "STREAM_IMMUTABLE" })
      }

      const result = schema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { displayName, slug, description, visibility, sealedNameCiphertext, sealedNameEnvelope } = result.data

      // Schema guarantees one of: both set, both null (clear), or both omitted.
      let sealedName: { ciphertext: string; envelope: unknown } | null | undefined
      if (sealedNameCiphertext != null && sealedNameEnvelope != null) {
        sealedName = { ciphertext: sealedNameCiphertext, envelope: sealedNameEnvelope }
      } else if (sealedNameCiphertext === null || sealedNameEnvelope === null) {
        sealedName = null
      }

      const updated = await streamService.updateStream(streamId, {
        displayName,
        slug,
        description,
        visibility,
        sealedName,
      })
      res.json({ stream: updated })
    },

    async listEvents(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const result = listEventsQuerySchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }
      const { type, limit, after, before } = result.data

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const types = type ? ((Array.isArray(type) ? type : [type]) as EventType[]) : undefined

      const events = await eventService.listEvents(streamId, {
        types,
        limit,
        afterSequence: after ? BigInt(after) : undefined,
        beforeSequence: before ? BigInt(before) : undefined,
        viewerId: userId,
      })

      const eventsWithLinkPreviews = await enrichEventsWithLinkPreviews(linkPreviewService, workspaceId, userId, events)
      const sharedMessages = await hydrateSharedMessagesForEvents(pool, workspaceId, userId, eventsWithLinkPreviews)

      res.json({ events: eventsWithLinkPreviews.map(serializeEvent), sharedMessages })
    },

    async listEventsAround(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const parsed = listEventsAroundQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(parsed.error).fieldErrors,
        })
      }
      const { eventId, messageId, limit } = parsed.data
      const targetId = (eventId ?? messageId)!

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const result = await eventService.listEventsAround(streamId, targetId, {
        idType: eventId ? "event" : "message",
        limit,
        viewerId: userId,
      })

      const enrichedEvents = await eventService.enrichBootstrapEvents(result.events, new Map())
      const eventsWithLinkPreviews = await enrichEventsWithLinkPreviews(
        linkPreviewService,
        workspaceId,
        userId,
        enrichedEvents
      )
      const sharedMessages = await hydrateSharedMessagesForEvents(pool, workspaceId, userId, eventsWithLinkPreviews)

      res.json({
        events: eventsWithLinkPreviews.map(serializeEvent),
        sharedMessages,
        hasOlder: result.hasOlder,
        hasNewer: result.hasNewer,
      })
    },

    async updateCompanionMode(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const result = updateCompanionModeSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { companionMode, companionPersonaId } = result.data

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const isMember = await streamService.isMember(streamId, userId)
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this stream" })
      }

      const updated = await streamService.updateCompanionMode(streamId, companionMode, companionPersonaId)

      res.json({ stream: updated })
    },

    async setNotificationLevel(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const result = setNotificationLevelSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const membership = await streamService.setNotificationLevel(streamId, userId, result.data.notificationLevel)
      if (!membership) {
        return res.status(404).json({ error: "Not a member of this stream" })
      }

      res.json({ membership })
    },

    async markAsRead(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const result = markAsReadSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const membership = await streamService.markAsRead(workspaceId, streamId, userId, result.data.lastEventId)
      if (!membership) {
        return res.status(404).json({ error: "Not a member of this stream" })
      }

      // Clear mention badges for this stream
      await activityService?.markStreamActivityAsRead(userId, streamId)

      res.json({ membership })
    },

    async archive(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const stream = await streamService.validateStreamAccess(streamId, workspaceId, userId)

      if (stream.createdBy !== userId) {
        return res.status(403).json({ error: "Only the creator can archive this stream" })
      }

      const archived = await streamService.archiveStream(streamId, userId)
      res.json({ stream: archived })
    },

    async unarchive(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const stream = await streamService.validateStreamAccess(streamId, workspaceId, userId)

      if (stream.createdBy !== userId) {
        return res.status(403).json({ error: "Only the creator can unarchive this stream" })
      }

      const unarchived = await streamService.unarchiveStream(streamId, userId)
      res.json({ stream: unarchived })
    },

    async join(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const membership = await streamService.joinPublicChannel(streamId, workspaceId, userId)
      res.json({ data: { membership } })
    },

    async bootstrap(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params
      const parsed = streamBootstrapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(parsed.error).fieldErrors,
        })
      }
      const afterSequence = parsed.data.after ? BigInt(parsed.data.after) : undefined

      const stream = await streamService.validateStreamAccess(streamId, workspaceId, userId)

      // Captured BEFORE the parallel queries fire. Shipped on the wire as the
      // bootstrap's freshness watermark. The frontend stamps `_patchedAt` on
      // any IDB row mutated by a socket handler, and at apply time skips
      // bootstrap merge for rows whose `_patchedAt` is newer than this — so a
      // stale enrichment subquery (e.g. `getThreadSummaries` reading just
      // before a reply commits) can't clobber a fresher socket-delivered
      // value. See `writeBootstrapEventsAndStream` in stream-sync.ts.
      const snapshotAt = new Date().toISOString()

      const [members, botMemberIds, membership, threadDataMap, threadSummaryMap, latestSequence, activityCounts] =
        await Promise.all([
          streamService.getMembers(streamId),
          streamService.getBotMemberIds(workspaceId, streamId),
          streamService.getMembership(streamId, userId),
          streamService.getThreadsWithReplyCounts(streamId),
          streamService.getThreadSummaries(streamId),
          eventService.getLatestSequence(streamId),
          activityService?.getUnreadCountsForStream(userId, workspaceId, streamId),
        ])
      const botRuntimePresences = await botRuntimeService.findLatestPresences({ workspaceId, botIds: botMemberIds })
      const commands = await commandAvailabilityService.listStreamCommands({ workspaceId, userId, streamId })
      const botRuntimeLinkByBotId =
        stream.type === StreamTypes.SCRATCHPAD
          ? await botRuntimeService.findActivePiRemoteSessionsForBotsInStream({
              workspaceId,
              botIds: botMemberIds,
              streamId: stream.id,
            })
          : new Map<string, { instanceId: string; runtimeSessionId: string }>()
      const botRuntimePresence = Object.fromEntries(
        botMemberIds.map((botId) => {
          const presence = botRuntimePresences.get(botId) ?? null
          const link = botRuntimeLinkByBotId.get(botId)
          return [
            botId,
            serializeBotRuntimePresence(presenceMatchesRuntimeSessionLink(presence, link) ? presence : null),
          ]
        })
      )

      const unreadCount = membership ? await streamService.getUnreadCount(streamId, membership.lastReadEventId) : 0

      let events = await eventService.listEvents(streamId, {
        limit: afterSequence !== undefined ? EVENTS_DEFAULT_LIMIT + 1 : EVENTS_DEFAULT_LIMIT,
        afterSequence,
        viewerId: userId,
      })
      let syncMode: "append" | "replace" = afterSequence !== undefined ? "append" : "replace"
      let hasOlderEvents = false

      if (afterSequence !== undefined && events.length > EVENTS_DEFAULT_LIMIT) {
        syncMode = "replace"
        events = await eventService.listEvents(streamId, { limit: EVENTS_DEFAULT_LIMIT, viewerId: userId })
        hasOlderEvents = true
      } else if (afterSequence === undefined) {
        hasOlderEvents = events.length === EVENTS_DEFAULT_LIMIT
      }

      const enrichedEvents = await eventService.enrichBootstrapEvents(events, threadDataMap, threadSummaryMap)
      const eventsWithLinkPreviews = await enrichEventsWithLinkPreviews(
        linkPreviewService,
        workspaceId,
        userId,
        enrichedEvents
      )
      const sharedMessages = await hydrateSharedMessagesForEvents(pool, workspaceId, userId, eventsWithLinkPreviews)

      // Fold the stream's persisted ContextBag into the bootstrap so the
      // timeline message-context badge renders synchronously from cached
      // data (no second fetch, no layout shift on first render). Access
      // check is skipped because `validateStreamAccess` above already
      // verified it. INV-8: per-ref read access is still re-verified inside
      // `fetchStreamBag` via the resolver.
      const contextBag = await fetchStreamBag(pool, { workspaceId, streamId, userId }, { skipAccessCheck: true })

      res.json({
        data: {
          stream,
          events: eventsWithLinkPreviews.map(serializeEvent),
          sharedMessages,
          members,
          botMemberIds,
          botRuntimePresence,
          commands,
          membership,
          latestSequence: (latestSequence ?? 0n).toString(),
          snapshotAt,
          hasOlderEvents,
          syncMode,
          unreadCount,
          mentionCount: activityCounts?.mentionCount ?? 0,
          activityCount: activityCounts?.totalCount ?? 0,
          contextBag,
        },
      })
    },

    async checkSlugAvailable(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = checkSlugAvailableSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const available = await streamService.checkSlugAvailable(workspaceId, result.data.slug, result.data.exclude)
      res.json({ available })
    },

    async addMember(req: Request, res: Response) {
      const actorId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const result = addMemberSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const stream = await streamService.validateStreamAccess(streamId, workspaceId, actorId)

      if (!addMemberAllowed[stream.type]) {
        throw new HttpError("Cannot add members to this stream type", { status: 400, code: "ADD_MEMBER_NOT_ALLOWED" })
      }

      const membership = await streamService.addMember(streamId, result.data.memberId, workspaceId, actorId)
      res.status(201).json({ membership })
    },

    async removeMember(req: Request, res: Response) {
      const actor = req.user!
      const workspaceId = req.workspaceId!
      const { streamId, memberId } = req.params

      await streamService.validateStreamAccess(streamId, workspaceId, actor.id)
      await streamService.removeMember(streamId, memberId)
      res.status(204).send()
    },

    async inviteActor(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params
      const { kind, actorId } = inviteActorSchema.parse(req.body)

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      // `stream` carries Date fields (Express serializes them to ISO on the
      // wire); `keyRoll` is already the wire shape. Mirrors how the other
      // stream handlers return `{ stream }` without a wire-type annotation.
      const { stream, keyRoll } = await streamService.inviteActor(workspaceId, streamId, userId, kind, actorId)
      res.json({ stream, keyRoll })
    },

    async rollE2eKey(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params
      const input = rollKeySchema.parse(req.body)

      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await streamService.rollStreamKey(workspaceId, streamId, userId, input)
      res.status(204).send()
    },

    async getE2eKeyWraps(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const { currentKeyGeneration, wraps, ownerUserId, liveActorRecipients } = await streamService.listE2eKeyWraps(
        workspaceId,
        streamId
      )
      const body: E2eKeyWrapsResponse = { currentKeyGeneration, wraps, ownerUserId, liveActorRecipients }
      res.json(body)
    },

    async reviveE2eActorKeyWraps(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params
      const input = actorRewrapSchema.parse(req.body)

      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await streamService.reviveActorKeyWraps(workspaceId, streamId, userId, input)
      res.status(204).send()
    },

    async storeE2eKeyWrap(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params
      const wrap = storeKeyWrapSchema.parse(req.body)

      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await streamService.storeOwnerKeyWrap(workspaceId, streamId, userId, wrap)
      res.status(204).send()
    },
  }
}
