import type { Pool } from "pg"
import { logger, type WorkosEvent } from "@threahq/backend-common"
import {
  AUTH_LOG_CP_BACKOFFICE_REQUEST,
  AUTH_LOG_CP_CALLBACK_FAILED,
  AUTH_LOG_CP_MAGIC_AUTH_VERIFY_FAILED,
} from "./constants"
import { mapWorkosEventToAuthLogRow } from "./mapper"
import { AuthLogRepository } from "./repository"

interface Dependencies {
  pool: Pool
}

/** Client-supplied context for own-handler auth failure rows. */
export interface AuthLogRequestContext {
  email: string | null
  ip: string | null
  userAgent: string | null
}

/**
 * Owns writes to `auth_log`. The poller feeds {@link ingestEvent} the WorkOS
 * events it can see; the CP auth handlers feed the two failure recorders the
 * rows WorkOS structurally cannot (AuthKit hosts the login UI, so exchange /
 * verify failures never reach WorkOS as events).
 *
 * Own-handler recorders are best-effort: they never throw, so an audit-insert
 * failure can't mask the real 401 the handler is about to return.
 */
export class AuthLogService {
  private readonly pool: Pool

  constructor({ pool }: Dependencies) {
    this.pool = pool
  }

  /** Ingest one WorkOS event. Idempotent on `workos_event_id`. */
  async ingestEvent(event: WorkosEvent): Promise<void> {
    await AuthLogRepository.insert(this.pool, mapWorkosEventToAuthLogRow(event))
  }

  async recordCallbackFailure(ctx: AuthLogRequestContext): Promise<void> {
    await this.recordOwnFailure(AUTH_LOG_CP_CALLBACK_FAILED, ctx)
  }

  /**
   * One row per backoffice request — platform-admin access to customer data
   * (workspace lists, member emails, invitations) must be forensically
   * answerable, and WorkOS events only cover identity lifecycle, not what an
   * admin actually read or changed. Best-effort: never throws.
   */
  async recordBackofficeRequest(params: {
    workosUserId: string | null
    email: string | null
    ip: string | null
    userAgent: string | null
    outcome: "success" | "denied"
    detail: { method: string; path: string; status: number; aborted?: boolean }
  }): Promise<void> {
    try {
      await AuthLogRepository.insert(this.pool, {
        occurredAt: new Date(),
        workosEventId: null,
        eventType: AUTH_LOG_CP_BACKOFFICE_REQUEST,
        workosUserId: params.workosUserId,
        email: params.email,
        organizationId: null,
        impersonatorEmail: null,
        ip: params.ip,
        userAgent: params.userAgent,
        outcome: params.outcome,
        detail: params.detail,
      })
    } catch (err) {
      logger.error({ err, path: params.detail.path }, "auth_log backoffice insert failed")
    }
  }

  async recordMagicAuthVerifyFailure(ctx: AuthLogRequestContext): Promise<void> {
    await this.recordOwnFailure(AUTH_LOG_CP_MAGIC_AUTH_VERIFY_FAILED, ctx)
  }

  private async recordOwnFailure(eventType: string, ctx: AuthLogRequestContext): Promise<void> {
    try {
      await AuthLogRepository.insert(this.pool, {
        occurredAt: new Date(),
        workosEventId: null,
        eventType,
        workosUserId: null,
        email: ctx.email,
        organizationId: null,
        impersonatorEmail: null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        outcome: "denied",
        detail: null,
      })
    } catch (err) {
      logger.error({ err, eventType }, "auth_log own-handler insert failed")
    }
  }
}
