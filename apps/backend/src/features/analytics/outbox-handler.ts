import type { Pool } from "pg"
import type { AnalyticsReporter } from "@threa/backend-common"
import { AuthorTypes } from "@threa/types"
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
    const candidates = events.map(toCandidate).filter((candidate) => candidate !== null)

    if (candidates.length > 0) {
      const reportableStreamIds = await this.findReportableStreamIds(candidates)
      const reportable = candidates.filter((candidate) => reportableStreamIds.has(candidate.streamId))
      const consentByActorId = await UserPreferencesRepository.findOverrideForUsers(
        this.db,
        Array.from(new Set(reportable.map((candidate) => candidate.actorId))),
        ANALYTICS_CONSENT_KEY
      )

      for (const candidate of reportable) {
        if (consentByActorId.get(candidate.actorId) !== ANALYTICS_CONSENT_GRANTED) continue
        this.reporter.captureEvent({
          distinctId: candidate.actorId,
          event: candidate.event,
          properties: candidate.properties,
          groups: { workspace: candidate.workspaceId },
        })
      }
    }

    return events.map((event) => event.id)
  }

  private async findReportableStreamIds(candidates: Candidate[]): Promise<Set<string>> {
    const streamIdsByWorkspace = new Map<string, Set<string>>()
    for (const candidate of candidates) {
      const streamIds = streamIdsByWorkspace.get(candidate.workspaceId) ?? new Set<string>()
      streamIds.add(candidate.streamId)
      streamIdsByWorkspace.set(candidate.workspaceId, streamIds)
    }

    const reportableStreamIds = new Set<string>()
    for (const [workspaceId, streamIds] of streamIdsByWorkspace) {
      const found = await E2eStreamsRepository.excludeE2eRootedStreamIds(this.db, workspaceId, Array.from(streamIds))
      for (const streamId of found) reportableStreamIds.add(streamId)
    }
    return reportableStreamIds
  }
}
