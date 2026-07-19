import { isIP } from "net"
import type { Pool } from "pg"
import type { Querier } from "../../db"
import { logger } from "../../lib/logger"
import { accessLogId } from "../../lib/id"
import {
  AccessLogRepository,
  type AccessLogRow,
  type DeliveredEvent,
  type ListByActorParams,
  type ListBySubjectParams,
  type ReconstructDeliveredParams,
} from "./repository"
import { capSubjects, type AuditSubjectRef } from "./subjects"
import type { AccessKind, AccessLogOperation, AccessOutcome, ActorType } from "./operations"

// UUIDs, ULIDs, and typical trace ids; an inbound x-request-id carrying free
// text (or kilobytes) is dropped rather than persisted.
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/

/** A caller-supplied audit event; the service mints the id and caps subjects. */
export interface AccessLogEntry {
  workspaceId: string | null
  occurredAt?: Date
  actorType: ActorType
  actorId: string
  onBehalfOfUserId?: string | null
  authRef?: string | null
  operation: AccessLogOperation
  accessKind: AccessKind
  outcome: AccessOutcome
  subjects?: AuditSubjectRef[] | null
  detail?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

/**
 * Writes access-log rows and answers the two breach-scoping questions. Reads,
 * subscribes and discloses go through `record()` best-effort — an audit insert
 * must never block or fail the request it describes (design §5). Mutations that
 * want exactness use `recordSync()` inside their own transaction.
 */
export class AccessLogService {
  private readonly pool: Pool
  private readonly inFlight = new Set<Promise<void>>()

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
  }

  /** Fire-and-forget insert. Swallows and loudly logs any failure. */
  record(entry: AccessLogEntry): void {
    const p = this.insert(this.pool, entry)
      .catch((err) => {
        logger.error({ err, operation: entry.operation }, "access-log insert failed")
      })
      .finally(() => {
        this.inFlight.delete(p)
      })
    this.inFlight.add(p)
  }

  /**
   * Await in-flight fire-and-forget inserts, bounded. Called during graceful
   * shutdown BEFORE the pool ends — otherwise rows enqueued by the final
   * responses/disconnects lose the race against pool.end() and vanish.
   */
  async drain(timeoutMs = 2000): Promise<void> {
    if (this.inFlight.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    clearTimeout(timer)
  }

  /** Awaited insert, for callers inside a transaction that want exactness. */
  async recordSync(querier: Querier, entry: AccessLogEntry): Promise<void> {
    await this.insert(querier, entry)
  }

  private insert(querier: Querier, entry: AccessLogEntry): Promise<void> {
    return AccessLogRepository.insert(querier, {
      id: accessLogId(),
      ...entry,
      // Caller-controlled columns are sanitized as defense in depth: route
      // params, forwarded headers, and inbound x-request-id must stay id-shaped
      // — never a free-text channel into the content-free log (design §5), and
      // never a value that makes the INET cast reject the whole row (a garbage
      // X-Forwarded-For must not suppress the audit row it belongs to).
      workspaceId: entry.workspaceId != null ? entry.workspaceId.slice(0, 256) : entry.workspaceId,
      actorId: entry.actorId.slice(0, 256),
      authRef: entry.authRef != null ? entry.authRef.slice(0, 256) : entry.authRef,
      ip: entry.ip != null && isIP(entry.ip) !== 0 ? entry.ip : null,
      requestId: entry.requestId != null && REQUEST_ID_SHAPE.test(entry.requestId) ? entry.requestId : null,
      subjects: entry.subjects != null ? capSubjects(entry.subjects) : entry.subjects,
    })
  }

  listByActor(params: ListByActorParams): Promise<AccessLogRow[]> {
    return AccessLogRepository.listByActor(this.pool, params)
  }

  listBySubject(params: ListBySubjectParams): Promise<AccessLogRow[]> {
    return AccessLogRepository.listBySubject(this.pool, params)
  }

  reconstructDeliveredEvents(params: ReconstructDeliveredParams): Promise<DeliveredEvent[]> {
    return AccessLogRepository.reconstructDeliveredEvents(this.pool, params)
  }
}
