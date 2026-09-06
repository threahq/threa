import { createHash } from "node:crypto"
import type { Pool } from "pg"
import type { AnalyticsReporter } from "@threahq/backend-common"
import { AuthorTypes } from "@threahq/types"
import {
  DebouncedOutboxHandler,
  type DebouncedOutboxHandlerConfig,
  type OutboxEvent,
  parseMessagePayload,
  type ReactionOutboxPayload,
  type StreamCreatedOutboxPayload,
  type StreamMemberJoinedOutboxPayload,
} from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"
import { UserPreferencesRepository } from "../user-preferences"

const ANALYTICS_CONSENT_KEY = "analyticsConsent"
const ANALYTICS_CONSENT_GRANTED = "granted"

interface Candidate {
  actorId: string
  workspaceId: string
  streamId: string
  event: string
  properties: Record<string, string>
}

interface Reportable extends Candidate {
  uuid: string
}

/** Random constant; only its fixedness matters (RFC 4122 §4.3). */
const EVENT_UUID_NAMESPACE = Buffer.from("6f1c4f2a9b6a4e1d8f3b2c7d5e0a1b4c", "hex")

/**
 * Outbox delivery is at-least-once, so a crash between capture and cursor
 * advance replays the batch. PostHog drops an event whose uuid it has already
 * ingested, so derive one from the row that produced it: same row, same uuid,
 * one event. Workspace-scoped because outbox ids are only unique per region.
 */
function eventUuid(workspaceId: string, outboxEventId: bigint): string {
  const hash = createHash("sha1").update(EVENT_UUID_NAMESPACE).update(`${workspaceId}:${outboxEventId}`).digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function toCandidate(event: OutboxEvent): Candidate | null {
  switch (event.eventType) {
    case "message:created": {
      const payload = parseMessagePayload(event.payload)
      if (!payload || payload.event.actorType !== AuthorTypes.USER || !payload.event.actorId) {
        return null
      }
      return {
        actorId: payload.event.actorId,
        workspaceId: payload.workspaceId,
        streamId: payload.streamId,
        event: "message_sent",
        properties: {
          workspaceId: payload.workspaceId,
          streamId: payload.streamId,
          messageId: payload.event.payload.messageId,
        },
      }
    }
    case "reaction:added": {
      const payload = event.payload as ReactionOutboxPayload
      if (payload.actorType && payload.actorType !== AuthorTypes.USER) {
        return null
      }
      if (!payload.userId || !payload.streamId || !payload.messageId) {
        return null
      }
      return {
        actorId: payload.userId,
        workspaceId: payload.workspaceId,
        streamId: payload.streamId,
        event: "reaction_added",
        properties: {
          workspaceId: payload.workspaceId,
          streamId: payload.streamId,
          messageId: payload.messageId,
        },
      }
    }
    case "stream:created": {
      // payload.streamId routes threads to the PARENT's room; the created stream is payload.stream.
      const payload = event.payload as StreamCreatedOutboxPayload
      if (!payload.stream?.createdBy) {
        return null
      }
      return {
        actorId: payload.stream.createdBy,
        workspaceId: payload.workspaceId,
        streamId: payload.stream.id,
        event: "stream_created",
        properties: {
          workspaceId: payload.workspaceId,
          streamId: payload.stream.id,
          streamType: payload.stream.type,
        },
      }
    }
    case "stream:member_joined": {
      const payload = event.payload as StreamMemberJoinedOutboxPayload
      if (!payload.event.actorId) {
        return null
      }
      return {
        actorId: payload.event.actorId,
        workspaceId: payload.workspaceId,
        streamId: payload.streamId,
        event: "stream_joined",
        properties: {
          workspaceId: payload.workspaceId,
          streamId: payload.streamId,
        },
      }
    }
    default:
      return null
  }
}

export class AnalyticsOutboxHandler extends DebouncedOutboxHandler {
  private readonly reporter: AnalyticsReporter

  constructor(db: Pool, reporter: AnalyticsReporter, config?: DebouncedOutboxHandlerConfig) {
    super(db, { listenerId: "posthog-events", ...config })
    this.reporter = reporter
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    await this.processBatch([event])
  }

  protected async processBatch(events: OutboxEvent[]): Promise<bigint[]> {
    const candidates = events.flatMap<Reportable>((event) => {
      const candidate = toCandidate(event)
      return candidate ? [{ ...candidate, uuid: eventUuid(candidate.workspaceId, event.id) }] : []
    })

    if (candidates.length > 0) {
      const nonE2eStreamIds = new Set(
        await E2eStreamsRepository.excludeE2eRootedStreamIds(
          this.db,
          candidates.map(({ workspaceId, streamId }) => ({ workspaceId, streamId }))
        )
      )
      const reportable = candidates.filter((candidate) => nonE2eStreamIds.has(candidate.streamId))
      const consentByActorId = await UserPreferencesRepository.findOverrideForUsers(
        this.db,
        Array.from(new Set(reportable.map((candidate) => candidate.actorId))),
        ANALYTICS_CONSENT_KEY
      )

      for (const candidate of reportable) {
        if (consentByActorId.get(candidate.actorId) !== ANALYTICS_CONSENT_GRANTED) continue
        this.reporter.captureEvent({
          uuid: candidate.uuid,
          distinctId: candidate.actorId,
          event: candidate.event,
          properties: candidate.properties,
          groups: { workspace: candidate.workspaceId },
        })
      }
    }

    return events.map((event) => event.id)
  }
}
