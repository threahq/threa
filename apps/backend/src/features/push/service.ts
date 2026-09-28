import { createHash, randomBytes } from "node:crypto"
import type { Pool } from "pg"
import {
  PUSH_PROVIDER_OUTCOMES,
  PUSH_RECEIPT_STAGES,
  PUSH_RECEIPT_SW_VERSION,
  type PushReceiptStage,
  type PushReceiptSuppressionReason,
  type PushTestProgress,
  type PushTestResponse,
  type UserPreferences,
} from "@threahq/types"
import webpush from "web-push"
import { withTransaction, withClient, type Querier } from "../../db"
import { PushSubscriptionRepository, type PushSubscription, type InsertPushSubscriptionParams } from "./repository"
import {
  PushDeliveryRepository,
  PUSH_DELIVERY_STATUSES,
  type ClaimedPushDelivery,
  type DurablePushKind,
  type TerminalPushDeliveryStatus,
} from "./delivery-repository"
import {
  decideSettlement,
  PUSH_INFRASTRUCTURE_FAILURE,
  PUSH_MAX_ABANDONED_CLAIMS,
  type ProviderAttemptResult,
} from "./retry-policy"
import { UserSessionRepository, type UserSession } from "./session-repository"
import { PushReceiptRepository, PUSH_RECEIPT_SCOPES, type LivePushReceipt } from "./receipt-repository"
import {
  PrefNotificationLevels,
  ActivityTypes,
  StreamTypes,
  PRESENCE_INTERACTION_WINDOW_MS,
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  ENCRYPTED_MESSAGE_PREVIEW_LABEL,
  stripMarkdownToInline,
  type PrefNotificationLevel,
  type StreamType,
} from "@threahq/types"
import { toEmoji } from "../emoji"
import { logger } from "../../lib/logger"
import { HttpError, safeErrorCode } from "../../lib/errors"
import { pushDeliveryId } from "../../lib/id"
import {
  PUSH_SEND_KINDS,
  PUSH_SUPPRESSION_REASONS,
  INVALID_REGISTRATION_RESULT,
  classifyProviderResult,
  providerFamily,
  retryAfterMs,
  type ProviderResult,
  type PushSendKind,
  type PushSuppressionReason,
} from "./outcome"
import { PUSH_RECEIPT_RESULTS, type PushTelemetry } from "./telemetry"
import type {
  ActivityCreatedOutboxPayload,
  SavedReminderFiredOutboxPayload,
  E2eRewrapNudgeOutboxPayload,
  CallInvitationCreatedOutboxPayload,
  CallInvitationSettledOutboxPayload,
} from "../../lib/outbox"
import {
  JobQueues,
  QueueRepository,
  type InsertQueueMessageParams,
  type PushDeliverJobData,
  type PushSessionExpiredJobData,
} from "../../lib/queue"
import type { ActivityPushInvalidReason, ActivityPushResolution } from "../activity"
import type { FiredReminderSource } from "../saved-messages"
import { REWRAP_WEBPUSH_REEMIT_MS } from "../enclave-runtimes"

/** Maximum push subscriptions per user per workspace to bound parallel delivery calls */
const MAX_SUBSCRIPTIONS_PER_USER = 10

/** web-push has no default socket timeout; stalled single-attempt sends still hold the outbox cursor. */
const WEBPUSH_TIMEOUT_MS = 10_000

/**
 * web-push rejects keys it cannot encrypt to with the same status-less
 * rejection as a network failure. Encrypting first, locally and
 * deterministically, keeps a malformed stored registration from being counted
 * (and later retried) as an unreachable push service.
 */
async function sendToDevice(
  sub: Pick<PushSubscription, "endpoint" | "p256dh" | "auth">,
  payload: string,
  options: PushDeliveryOptions
): Promise<ProviderAttemptResult> {
  try {
    webpush.encrypt(sub.p256dh, sub.auth, payload, webpush.supportedContentEncodings.AES_128_GCM)
  } catch {
    return { ...INVALID_REGISTRATION_RESULT, retryAfterMs: null }
  }
  const [settled] = await Promise.allSettled([
    webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
      timeout: WEBPUSH_TIMEOUT_MS,
      TTL: options.ttlSeconds,
      urgency: options.urgency,
      ...(options.topic ? { topic: options.topic } : {}),
    }),
  ])
  return { ...classifyProviderResult(settled), retryAfterMs: retryAfterMs(settled, Date.now()) }
}

/**
 * How long the push service may queue a message push for an offline device.
 * Bounded so a device reconnecting after days doesn't replay a backlog of
 * stale alerts (the web-push default is 28 days).
 */
const MESSAGE_PUSH_TTL_SECONDS = 24 * 60 * 60

/** Session-expired is not time-critical but should eventually land. */
const SESSION_EXPIRED_TTL_SECONDS = 7 * 24 * 60 * 60

/** A test push is only meaningful while the user is watching for it. */
const TEST_PUSH_TTL_SECONDS = 60

/**
 * A ring is only worth delivering while it's still ringing. Bounded to the
 * invitation TTL so a device that reconnects after the ring lapsed never wakes
 * to a call that already went to the missed-call feed. The matching cancel push
 * rides the same topic to collapse an undelivered ring.
 */
const CALL_RING_TTL_SECONDS = 45

/**
 * Delivery class for a push send. `urgency: "high"` wakes a dozing Android
 * device — with the default "normal" FCM/autopush batch delivery until the
 * next Doze maintenance window and a real-time message lands minutes-to-hours
 * late. `topic` makes the push service collapse queued same-topic pushes to
 * the newest one, so an offline device gets one alert per stream on reconnect
 * instead of a buzz per message.
 */
interface PushDeliveryOptions {
  ttlSeconds: number
  urgency: "very-low" | "low" | "normal" | "high"
  /** Must be ≤32 base64url characters (push-service constraint) — see pushTopic. */
  topic?: string
}

/**
 * Collapse key for the push service, from a prefixed ULID. The Web Push Topic
 * header allows at most 32 base64url chars, so a 33-char id like
 * `stream_01ABC…` can't be used verbatim — the 26-char ULID plus a short kind
 * suffix (to keep e.g. mention pushes from collapsing into message pushes for
 * the same stream) stays within the limit.
 */
function pushTopic(prefixedId: string, kindSuffix = ""): string {
  return prefixedId.slice(prefixedId.indexOf("_") + 1) + kindSuffix
}

/** How recently a device must have sent a heartbeat to be considered "active" */
const ACTIVE_SESSION_WINDOW_MS = 60_000

/**
 * How recently `last_focused_at` must have been bumped for us to treat the
 * device as currently focused. Heartbeats fire every 30s while focused (and
 * immediately on focus change), so a 60s window catches the focused state with
 * at most one heartbeat of lag.
 */
const CURRENTLY_FOCUSED_WINDOW_MS = 60_000

/**
 * How recently the device must have seen a real user interaction
 * (pointerdown/keydown/touchstart) to count as "the device the user is on".
 * A focused-but-untouched window (e.g. PWA open in another desktop space)
 * shouldn't claim the user's attention indefinitely — without interaction we
 * fall through to fanout so the user gets notified on whichever device they
 * pick up next.
 */
// Shared with the frontend SW's push-suppression check so the two layers agree
// on what "present" means (@threahq/types).
const RECENT_INTERACTION_WINDOW_MS = PRESENCE_INTERACTION_WINDOW_MS

/**
 * Per-device session expiry window. If a specific device has not sent a heartbeat
 * within this window, its auth session has likely expired. We send a "session expired"
 * push to that device and clean up its subscription individually — other devices with
 * active sessions are unaffected. Matches the 30-day session cookie TTL and the
 * session GC window in session-cleanup.ts.
 */
const SESSION_EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000 // 30 days (matches cookie TTL)

/**
 * How long a claimed device delivery stays owned: revalidation reads plus the
 * send timeout, with room to spare. Ownership is re-asserted right before the
 * send, so a worker whose reads outlived its lease never sends.
 */
const PUSH_DELIVERY_LEASE_MS = 60_000

/** Ledger rows are kept this long past their expiry (first-party diagnostics), then deleted. */
const PUSH_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const RETENTION_BATCH_SIZE = 500
const RETENTION_MAX_BATCHES = 20

/** An automatic receipt can still land this long after its delivery's push TTL ran out. */
const DELIVERY_RECEIPT_GRACE_MS = 10 * 60 * 1_000

/** An explicit test's capability: long enough for a woken device to answer while the user watches. */
const TEST_RECEIPT_CAPABILITY_MS = 10 * 60 * 1_000

/** Test results are first-party diagnostics for the person who ran them; kept a day, not the ledger's week. */
const TEST_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000

/** Slack past the DB-computed claimable time: the queue compares `process_after` with app-server time. */
const WAKE_MARGIN_MS = 1_000

/**
 * Session-expired notice job ids carry this bucket: a dead-lettered notice
 * holds its id until DLQ retention, so a later event re-plans it in the next
 * bucket, at most one notice per registration generation per bucket.
 */
const SESSION_EXPIRED_NOTICE_BUCKET_MS = 24 * 60 * 60 * 1_000

/** The outbox event a push is planned from: its id dedupes replays, its time anchors expiry. */
export interface PushSourceEvent {
  id: bigint
  createdAt: Date
}

export type PushPreferences = Pick<
  UserPreferences,
  "notificationLevel" | "pushActions" | "pushReminderMinutes" | "pushQuickReaction"
>

/** Callbacks for resolving cross-feature data (INV-52: access via service layer, not repos) */
interface CrossFeatureLookups {
  /** Resolve the user's notification level and the push button preferences that ride the payload. */
  getUserPushPreferences: (workspaceId: string, userId: string) => Promise<PushPreferences>
  /**
   * Whether the user currently has notifications paused (do-not-disturb) — via
   * a do-not-disturb status or a manual pause. Evaluated at delivery time so an
   * expired pause stops suppressing even while the user is offline.
   */
  isNotificationPaused: (workspaceId: string, userId: string) => Promise<boolean>
  /** Resolve a stream's type by ID within a workspace. Returns null if not found. */
  getStreamType: (workspaceId: string, streamId: string) => Promise<StreamType | null>
  /**
   * Resolve the workspace-scoped user's global WorkOS user id. Stamped on the
   * push payload so the recipient device can flip to the right signed-in
   * account before opening the deep link. Returns null if the user is not found.
   */
  getWorkosUserId: (workspaceId: string, userId: string) => Promise<string | null>
  /** Revalidate an activity and rebuild its push content from current rows (INV-62 access, read, moved, deleted). */
  resolveActivityPush: (params: {
    workspaceId: string
    userId: string
    activityId: string
    plannedStreamId: string | null
  }) => Promise<ActivityPushResolution>
  /** The fired reminder at exactly this generation, with fresh content; null once cancelled, rescheduled or re-fired. */
  resolveFiredReminder: (params: {
    workspaceId: string
    userId: string
    savedId: string
    reminderGeneration: number
  }) => Promise<FiredReminderSource | null>
  /** Whether the owner's re-wrap of this root stream is still needed. */
  isRewrapOutstanding: (params: { workspaceId: string; rootStreamId: string; ownerUserId: string }) => Promise<boolean>
  /**
   * The user's current analytics consent grant (a generation that changes on
   * every withdrawal, reset or re-grant), or null when not granted. Inside a
   * transaction on `db`, a concurrent change cannot commit until it ends.
   */
  findAnalyticsConsentGrant: (db: Querier, userId: string) => Promise<string | null>
  /** The stream's root is end-to-end encrypted under the current policy (INV-62 root walk). */
  isE2eRootedStream: (db: Querier, workspaceId: string, streamId: string) => Promise<boolean>
}

interface PushServiceDeps {
  pool: Pool
  vapidConfig: {
    publicKey: string
    privateKey: string
    subject: string
  } | null
  lookups: CrossFeatureLookups
  telemetry: PushTelemetry
}

interface DeviceSendResult extends ProviderResult {
  subscription: PushSubscription
}

/**
 * Plain text for a push body. E2E messages store a zero-width placeholder on
 * the wire (the server holds no key), so surfacing it would produce a blank
 * notification — substitute a generic, leak-free label instead (E2EE-19).
 * The SW renders this verbatim, so markdown is stripped and `:shortcode:`
 * emoji resolved here (INV-60); custom workspace emoji have no character and
 * stay as their shortcode. Missing content → null.
 */
export function resolvePushPreview(contentMarkdown: string | null | undefined): string | null {
  if (contentMarkdown === E2E_PLACEHOLDER_CONTENT_MARKDOWN) return ENCRYPTED_MESSAGE_PREVIEW_LABEL
  if (contentMarkdown == null) return null
  return stripMarkdownToInline(contentMarkdown, toEmoji).slice(0, 200)
}

export class PushService {
  private readonly pool: Pool
  private readonly vapidPublicKey: string
  private readonly canSend: boolean
  private readonly lookups: CrossFeatureLookups
  private readonly telemetry: PushTelemetry

  constructor(deps: PushServiceDeps) {
    this.pool = deps.pool
    this.lookups = deps.lookups
    this.telemetry = deps.telemetry

    if (deps.vapidConfig) {
      // INV-9 approved exception: web-push requires module-level VAPID config
      // (external library bootstrap constraint). Only one PushService per process.
      webpush.setVapidDetails(deps.vapidConfig.subject, deps.vapidConfig.publicKey, deps.vapidConfig.privateKey)
      this.vapidPublicKey = deps.vapidConfig.publicKey
      this.canSend = true
    } else {
      this.vapidPublicKey = ""
      this.canSend = false
    }
  }

  isEnabled(): boolean {
    return this.canSend
  }

  getVapidPublicKey(): string {
    return this.vapidPublicKey
  }

  async subscribe(params: InsertPushSubscriptionParams): Promise<PushSubscription> {
    // Atomic cap enforcement (INV-20): count + evict + insert in one transaction.
    // The FOR UPDATE lock serializes concurrent subscribe calls for the same user.
    // Existence check runs after locking to prevent double-eviction races.
    return withTransaction(this.pool, async (client) => {
      const count = await PushSubscriptionRepository.countByUserForUpdate(client, params.workspaceId, params.userId)
      if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
        const isReRegister = await PushSubscriptionRepository.existsByEndpoint(
          client,
          params.workspaceId,
          params.userId,
          params.endpoint
        )
        if (!isReRegister) {
          await PushSubscriptionRepository.deleteOldestByUser(client, params.workspaceId, params.userId)
        }
      }
      return PushSubscriptionRepository.insert(client, params)
    })
  }

  async unsubscribe(workspaceId: string, userId: string, endpoint: string): Promise<boolean> {
    return PushSubscriptionRepository.deleteByEndpoint(this.pool, workspaceId, userId, endpoint)
  }

  /** Remove all push subscriptions for a browser endpoint across all workspaces (used on logout). */
  async unsubscribeAllWorkspaces(endpoint: string, workosUserId: string): Promise<number> {
    return PushSubscriptionRepository.deleteByEndpointForUser(this.pool, endpoint, workosUserId)
  }

  /**
   * Sends a server-driven test push to all of the user's subscriptions in the
   * workspace. Bypasses the focus-suppression and notification-preference logic
   * because this is an explicit user diagnostic — we want to know whether the
   * full delivery loop (DB → web-push → device) is working.
   *
   * Reports what each device's push service answered. Acceptance by the push
   * service is not display on the device, so nothing here claims delivery.
   * Stale endpoints (404/410) are evicted so the next test reflects current
   * registration state.
   */
  async deliverTestPush(workspaceId: string, userId: string): Promise<PushTestResponse> {
    if (!this.canSend) {
      // Mirror handlers.ts contract (INV-32) so non-handler callers (workers,
      // internal APIs) get the same status/code semantics instead of a generic
      // 500 from a plain Error bubbling through the error middleware.
      throw new HttpError("Push notifications are not enabled", { status: 503, code: "PUSH_DISABLED" })
    }

    const testId = pushDeliveryId()
    const subscriptions = await PushSubscriptionRepository.findByUserId(this.pool, workspaceId, userId)
    if (subscriptions.length === 0) {
      this.telemetry.recordSuppressed(PUSH_SEND_KINDS.TEST, PUSH_SUPPRESSION_REASONS.NO_SUBSCRIPTIONS)
      return { testId, attempted: 0, accepted: 0, failed: 0, delivered: 0, devices: [], progress: null }
    }

    const { tokens, progress } = await this.armTestReceipts(workspaceId, userId, testId, subscriptions)
    const sentAt = Date.now()
    // One attempt per device, never retried: a test is only meaningful while the user watches.
    const results = await this.sendAndEvictStale(
      workspaceId,
      subscriptions,
      (subscription) => {
        const token = tokens.get(subscription.id)
        return JSON.stringify({
          data: { kind: "test" as const, workspaceId, sentAt },
          ...(token ? { receipt: { token } } : {}),
        })
      },
      { ttlSeconds: TEST_PUSH_TTL_SECONDS, urgency: "high" },
      PUSH_SEND_KINDS.TEST
    )

    let storedProgress = progress
    if (progress) {
      try {
        await PushReceiptRepository.recordTestProviderOutcomes(this.pool, {
          workspaceId,
          testId,
          results: results.map((r) => ({
            subscriptionId: r.subscription.id,
            outcome: r.outcome,
            statusCode: r.statusCode,
          })),
        })
      } catch (err) {
        // Without stored provider outcomes the poll would show every device awaiting a receipt.
        logger.warn({ errorCode: safeErrorCode(err) }, "Failed to store push test provider outcomes")
        storedProgress = null
      }
    }

    const accepted = results.filter((r) => r.outcome === PUSH_PROVIDER_OUTCOMES.ACCEPTED).length
    return {
      testId,
      attempted: results.length,
      accepted,
      failed: results.length - accepted,
      delivered: accepted,
      devices: results.map(({ subscription, outcome, statusCode }) => ({
        subscriptionId: subscription.id,
        deviceKey: subscription.deviceKey,
        userAgent: subscription.userAgent,
        outcome,
        statusCode,
      })),
      progress: storedProgress,
    }
  }

  /** Per-device results of the caller's own test. Another user's test id is indistinguishable from a missing one. */
  async getTestProgress(workspaceId: string, userId: string, testId: string): Promise<PushTestProgress> {
    const found = await PushReceiptRepository.findTestProgress(this.pool, { workspaceId, userId, testId })
    if (!found) throw new HttpError("Push test not found", { status: 404, code: "PUSH_TEST_NOT_FOUND" })
    return { testId, expiresAt: found.expiresAt.toISOString(), devices: found.devices }
  }

  /**
   * Record what a service worker reported, authorized by the capability token
   * alone (no cookie: a parked account or closed app still reports). Every
   * outcome, unknown, expired, revoked or replayed included, returns the same
   * way so the caller learns nothing. An automatic receipt is kept only while
   * the analytics consent grant it was armed under is still the user's current
   * one and the stream's root is not end-to-end encrypted, both read now.
   */
  async recordReceipt(params: {
    workspaceId: string
    token: string
    stage: PushReceiptStage
    reason: PushReceiptSuppressionReason | null
  }): Promise<void> {
    const { workspaceId } = params
    const tokenHash = sha256Hex(params.token)
    // One transaction: the receipt row and the consent row stay locked from the
    // check to the write, so a withdrawal or re-arm lands before (and is seen)
    // or after, never between.
    const result = await withTransaction(this.pool, async (client) => {
      const receipt = await PushReceiptRepository.findLive(client, { workspaceId, tokenHash })
      if (!receipt) return PUSH_RECEIPT_RESULTS.UNMATCHED

      if (
        receipt.scope === PUSH_RECEIPT_SCOPES.DELIVERY &&
        !(await this.deliveryReceiptAllowed(client, workspaceId, receipt))
      ) {
        await PushReceiptRepository.revoke(client, { workspaceId, id: receipt.id, tokenHash })
        return PUSH_RECEIPT_RESULTS.REVOKED
      }

      await PushReceiptRepository.recordStage(client, {
        workspaceId,
        tokenHash,
        stage: params.stage,
        reason: params.stage === PUSH_RECEIPT_STAGES.SUPPRESSED ? params.reason : null,
      })
      return PUSH_RECEIPT_RESULTS.RECORDED
    })
    this.telemetry.recordReceipt(result)
  }

  async upsertSession(params: {
    workspaceId: string
    userId: string
    deviceKey: string
    focused?: boolean
    interacted?: boolean
  }): Promise<UserSession> {
    return UserSessionRepository.upsert(this.pool, params)
  }

  async upsertSessionsBatch(
    entries: Array<{ workspaceId: string; userId: string; deviceKey: string }>,
    options?: { focused?: boolean; interacted?: boolean }
  ): Promise<void> {
    return UserSessionRepository.upsertBatch(this.pool, entries, options)
  }

  /**
   * Delete user sessions that haven't sent a heartbeat within the retention window.
   * Cross-workspace by design (INV-8 infra exception): user_sessions is ephemeral
   * delivery-infrastructure data (heartbeat timestamps for push suppression), not
   * user-facing product data. Scoping cleanup per-workspace would require iterating
   * all workspaces for a simple time-based GC — same pattern as orphan session cleanup.
   */
  async cleanupStaleSessions(olderThanMs: number): Promise<number> {
    return UserSessionRepository.cleanupStale(this.pool, olderThanMs)
  }

  /**
   * Plan push for an activity:created event: shared recipient gates, then one
   * device delivery row plus its first queue job per targeted device, committed
   * together before the outbox cursor moves. No provider I/O here; content is
   * built fresh by each attempt, never copied from the event.
   */
  async planActivityPush(event: PushSourceEvent, payload: ActivityCreatedOutboxPayload): Promise<void> {
    const kind = PUSH_SEND_KINDS.ACTIVITY
    if (!this.canSend) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PUSH_DISABLED)

    const { workspaceId, targetUserId, activity } = payload

    // Self rows represent the target user's own action — do not push.
    if (activity.isSelf) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.SELF)

    // Member-added activities notify via the feed only, not push.
    if (activity.activityType === ActivityTypes.MEMBER_ADDED) {
      return this.suppress(kind, PUSH_SUPPRESSION_REASONS.MEMBER_ADDED)
    }

    // The same fire also emits saved_reminder:fired, which owns the reminder push.
    if (activity.activityType === ActivityTypes.SAVED_REMINDER) {
      return this.suppress(kind, PUSH_SUPPRESSION_REASONS.NOT_PUSHABLE)
    }

    const recipient = await this.checkRecipient(workspaceId, targetUserId, {
      activityType: activity.activityType,
      streamId: activity.streamId,
    })
    if (!recipient.eligible) return this.suppress(kind, recipient.reason)

    await this.planDevices({
      kind,
      workspaceId,
      userId: targetUserId,
      event,
      sourceId: activity.id,
      sourceGeneration: null,
      sourceStreamId: activity.streamId,
    })
  }

  /**
   * Plan push for a fired saved reminder. Reminders respect the user's global
   * notification preference and do-not-disturb (the in-app toast still fires).
   * Each attempt revalidates the reminder at the generation pinned when it
   * fired, so a cancelled, rescheduled or re-fired reminder never pushes late.
   */
  async planSavedReminderPush(event: PushSourceEvent, payload: SavedReminderFiredOutboxPayload): Promise<void> {
    const kind = PUSH_SEND_KINDS.SAVED_REMINDER
    if (!this.canSend) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PUSH_DISABLED)

    if (payload.reminderGeneration === undefined) return this.deliverLegacySavedReminder(event, payload)

    const recipient = await this.checkRecipient(payload.workspaceId, payload.targetUserId, null)
    if (!recipient.eligible) return this.suppress(kind, recipient.reason)

    await this.planDevices({
      kind,
      workspaceId: payload.workspaceId,
      userId: payload.targetUserId,
      event,
      sourceId: payload.savedId,
      sourceGeneration: payload.reminderGeneration,
      sourceStreamId: null,
    })
  }

  /**
   * Plan the offline owner's re-wrap nudge: an enclave turn in their E2E
   * scratchpad is stuck because no live agent instance holds the stream's key,
   * and only their unlocked device can re-wrap it. The graced web-push pulls
   * them back to the app, where the heal fires on open. Respects the global
   * notification preference and do-not-disturb like a saved reminder — an owner
   * who silenced push isn't woken; their next app open heals it regardless.
   * Focus targeting keeps it off a device the owner is already looking at —
   * there the socket signal already healed it.
   */
  async planRewrapNudgePush(event: PushSourceEvent, payload: E2eRewrapNudgeOutboxPayload): Promise<void> {
    const kind = PUSH_SEND_KINDS.REWRAP_NUDGE
    if (!this.canSend) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PUSH_DISABLED)

    const recipient = await this.checkRecipient(payload.workspaceId, payload.targetUserId, null)
    if (!recipient.eligible) return this.suppress(kind, recipient.reason)

    await this.planDevices({
      kind,
      workspaceId: payload.workspaceId,
      userId: payload.targetUserId,
      event,
      sourceId: payload.rootStreamId,
      sourceGeneration: null,
      sourceStreamId: null,
    })
  }

  /**
   * One provider attempt for one device delivery (the `push.deliver` job).
   * Claims the row before anything else, revalidates everything a delay can
   * change, re-asserts the claim, sends with no DB connection held (INV-41),
   * then records the result and schedules the next attempt in one
   * transaction. Throws only on infrastructure failure; the queue retries the
   * job, and a retry that finds this attempt still leased schedules a wake-up
   * for when the lease lapses instead of finishing as a no-op.
   */
  async attemptDelivery(data: PushDeliverJobData): Promise<void> {
    const { workspaceId, deliveryId, attempt } = data
    const claimed = await PushDeliveryRepository.claim(this.pool, {
      workspaceId,
      deliveryId,
      attempt,
      leaseMs: PUSH_DELIVERY_LEASE_MS,
    })
    if (!claimed) return this.wakeWhenClaimable(this.pool, data)

    if (claimed.abandonedClaims >= PUSH_MAX_ABANDONED_CLAIMS) {
      logger.warn({ kind: claimed.kind }, "Push delivery failed after repeated abandoned claims")
      return this.settleUnsent(this.pool, claimed, PUSH_DELIVERY_STATUSES.FAILED, PUSH_INFRASTRUCTURE_FAILURE)
    }

    const prepared = await this.prepareAttempt(claimed, data)
    if (!prepared.send) {
      this.suppress(claimed.kind, prepared.reason)
      return this.settleUnsent(this.pool, claimed, prepared.status, prepared.reason)
    }

    const { owned, receiptToken } = await this.renewLeaseAndArmReceipt(claimed, prepared)
    if (!owned) return

    // The reads and the arming above can be slow: the send window and TTL are measured after them.
    const ttlSeconds = sendableTtlSeconds(claimed.expiresAt, prepared.deadline, Date.now())
    if (ttlSeconds === null) {
      this.suppress(claimed.kind, PUSH_SUPPRESSION_REASONS.EXPIRED)
      return this.settleUnsent(this.pool, claimed, PUSH_DELIVERY_STATUSES.EXPIRED, PUSH_SUPPRESSION_REASONS.EXPIRED)
    }

    const payload = JSON.stringify({
      data: prepared.data,
      ...(receiptToken ? { receipt: { token: receiptToken } } : {}),
    })

    // At-least-once: a crash or failed settle after this send leaves the row
    // pending, and the attempt is reclaimed and sent again once the lease
    // lapses, up to PUSH_MAX_ABANDONED_CLAIMS times.
    const result = await sendToDevice(prepared.subscription, payload, {
      ttlSeconds,
      urgency: "high",
      topic: prepared.topic,
    })
    this.telemetry.recordSendOutcome({
      ...result,
      kind: claimed.kind,
      provider: providerFamily(prepared.subscription.endpoint),
    })

    const settlement = decideSettlement({
      result,
      attemptsBefore: claimed.attempts,
      nowMs: Date.now(),
      deadline: prepared.deadline,
    })
    await withTransaction(this.pool, async (client) => {
      const settled = await PushDeliveryRepository.settle(client, {
        workspaceId,
        deliveryId,
        claimVersion: claimed.version,
        settlement,
      })
      if (!settled) return
      if (settlement.kind === "retry") {
        await QueueRepository.batchInsert(client, [
          deliverJob(
            { workspaceId, deliveryId, attempt: settled.attempts, sourceStreamId: data.sourceStreamId },
            settlement.nextAttemptAt
          ),
        ])
      }
      if (settled.status === PUSH_DELIVERY_STATUSES.REGISTRATION_GONE) {
        await PushSubscriptionRepository.deleteByIdsAtGeneration(client, workspaceId, [
          { id: claimed.subscriptionId, generation: claimed.subscriptionGeneration },
        ])
      }
    })
  }

  /**
   * `push.deliver` onDLQ hook, inside the dead-letter transaction, so a job
   * whose infrastructure retries ran out never leaves its delivery pending with
   * nothing left to run it. No-op unless this job really is dead-lettered and
   * no other open job for the same attempt can still run it. Otherwise it
   * claims the attempt and fails it as infrastructure. A live lease (possibly
   * this job's own orphan) or a scheduled retry blocks the claim; the attempt
   * then goes to a wake-up job at the claimable time, whose claims
   * PUSH_MAX_ABANDONED_CLAIMS bounds.
   */
  async recoverDeadLetteredAttempt(db: Querier, job: { id: string; data: PushDeliverJobData }): Promise<void> {
    const { workspaceId, deliveryId, attempt } = job.data
    const message = await QueueRepository.getById(db, job.id)
    if (!message?.dlqAt) return
    // Sibling jobs for the same attempt can dead-letter in overlapping transactions; each would see
    // the other's uncommitted DLQ as a live successor and both would leave the row pending.
    await PushDeliveryRepository.lockForUpdate(db, { workspaceId, deliveryId })
    const successor = await QueueRepository.hasOtherOpenMessage(db, {
      queueName: JobQueues.PUSH_DELIVER,
      workspaceId,
      payload: { deliveryId, attempt },
      excludeId: job.id,
    })
    if (successor) return

    const claimed = await PushDeliveryRepository.claim(db, {
      workspaceId,
      deliveryId,
      attempt,
      leaseMs: PUSH_DELIVERY_LEASE_MS,
    })
    if (!claimed) return this.wakeWhenClaimable(db, job.data)
    logger.warn({ kind: claimed.kind }, "Push delivery failed after its job was dead-lettered")
    await this.settleUnsent(db, claimed, PUSH_DELIVERY_STATUSES.FAILED, PUSH_INFRASTRUCTURE_FAILURE)
  }

  /**
   * The "session expired" push for one registration (`push.session_expired`
   * job): a single best-effort attempt, never retried on a provider failure.
   * Skipped when the registration was removed or re-keyed, or its device has
   * signed back in since planning; otherwise sent, then removed at the
   * generation it was sent to unless it came back to life during the send.
   */
  async deliverSessionExpired(data: PushSessionExpiredJobData): Promise<void> {
    if (!this.canSend) return
    const { workspaceId, subscriptionId, generation } = data
    const subscription = await PushSubscriptionRepository.findById(this.pool, workspaceId, subscriptionId)
    if (!subscription || subscription.generation !== generation) return

    const recentDeviceKeys = await UserSessionRepository.getRecentDeviceKeys(
      this.pool,
      [subscription.deviceKey],
      SESSION_EXPIRY_WINDOW_MS
    )
    if (isSessionLive(subscription, recentDeviceKeys)) return

    const pushPayload = JSON.stringify({ data: { action: "session_expired" as const, workspaceId } })
    const result = await sendToDevice(subscription, pushPayload, {
      ttlSeconds: SESSION_EXPIRED_TTL_SECONDS,
      urgency: "normal",
      topic: "session-expired",
    })
    this.telemetry.recordSendOutcome({
      ...result,
      kind: PUSH_SEND_KINDS.SESSION_EXPIRED,
      provider: providerFamily(subscription.endpoint),
    })

    // Not thrown: a queue retry would send the notice again.
    try {
      await PushSubscriptionRepository.deleteStaleAtGeneration(this.pool, {
        workspaceId,
        id: subscriptionId,
        generation,
        staleForMs: SESSION_EXPIRY_WINDOW_MS,
      })
    } catch (err) {
      logger.warn({ errorCode: safeErrorCode(err) }, "Failed to clean up push subscription for expired session")
    }
  }

  /** Delete receipt rows past their retention, in bounded batches. */
  async cleanupExpiredReceipts(): Promise<number> {
    let deleted = 0
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
      const count = await PushReceiptRepository.deleteExpired(this.pool, { limit: RETENTION_BATCH_SIZE })
      deleted += count
      if (count < RETENTION_BATCH_SIZE) break
    }
    return deleted
  }

  /** Delete ledger rows whose expiry is past the retention window, in bounded batches. */
  async cleanupExpiredDeliveries(): Promise<number> {
    const expiredBefore = new Date(Date.now() - PUSH_DELIVERY_RETENTION_MS)
    let deleted = 0
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
      const count = await PushDeliveryRepository.deleteExpiredPlans(this.pool, {
        expiredBefore,
        limit: RETENTION_BATCH_SIZE,
      })
      deleted += count
      if (count < RETENTION_BATCH_SIZE) break
    }
    return deleted
  }

  /**
   * Legacy `saved_reminder:fired` events (written by replicas predating
   * reminder generations) carry no generation to revalidate against, so they
   * keep the previous behavior: one inline attempt from the event's snapshot,
   * no retries, never resolving a current generation for them. Finite: only
   * events emitted during the rolling deploy take this path.
   */
  private async deliverLegacySavedReminder(
    event: PushSourceEvent,
    payload: SavedReminderFiredOutboxPayload
  ): Promise<void> {
    const kind = PUSH_SEND_KINDS.SAVED_REMINDER
    const { workspaceId, targetUserId, savedId, messageId, streamId, saved } = payload

    const expiresAt = expiryFor(event)
    if (remainingSeconds(expiresAt, Date.now()) < 1) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.EXPIRED)

    const recipient = await this.checkRecipient(workspaceId, targetUserId, null)
    if (!recipient.eligible) return this.suppress(kind, recipient.reason)

    const { active, expired } = await this.getTargetSubscriptions(workspaceId, targetUserId)
    if (expired.length > 0) await QueueRepository.batchInsert(this.pool, sessionExpiredJobs(workspaceId, expired))
    if (active.length === 0) return this.suppress(kind, noDevicesReason(expired))

    const ttlSeconds = remainingSeconds(expiresAt, Date.now())
    if (ttlSeconds < 1) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.EXPIRED)

    const pushPayload = JSON.stringify({
      data: {
        kind: "saved_reminder",
        workspaceId,
        savedId,
        streamId,
        messageId,
        conversationId: saved.conversationId ?? undefined,
        streamName: saved.message?.streamName ?? null,
        contentPreview: resolvePushPreview(saved.message?.contentMarkdown) ?? saved.title,
        unavailableReason: saved.unavailableReason ?? null,
      },
    })
    await this.sendAndEvictStale(
      workspaceId,
      active,
      () => pushPayload,
      { ttlSeconds, urgency: "high", topic: pushTopic(savedId) },
      kind
    )
  }

  /**
   * Persist the plan and its jobs atomically. A replayed event finds its plan
   * and enqueues nothing new; a failure throws so the outbox retries the event.
   * Devices whose session expired get their one-shot notice as a separate job.
   */
  private async planDevices(params: {
    kind: DurablePushKind
    workspaceId: string
    userId: string
    event: PushSourceEvent
    sourceId: string
    sourceGeneration: number | null
    sourceStreamId: string | null
  }): Promise<void> {
    const { kind, workspaceId, userId, event } = params
    const expiresAt = expiryFor(event)
    if (Date.now() >= sendDeadline(kind, event.createdAt, expiresAt).getTime()) {
      return this.suppress(kind, PUSH_SUPPRESSION_REASONS.EXPIRED)
    }

    const { active, expired } = await this.getTargetSubscriptions(workspaceId, userId)
    if (active.length === 0) this.suppress(kind, noDevicesReason(expired))
    if (active.length === 0 && expired.length === 0) return

    await withTransaction(this.pool, async (client) => {
      const jobs = sessionExpiredJobs(workspaceId, expired)
      if (active.length > 0) {
        const plan = await PushDeliveryRepository.insertPlan(client, {
          workspaceId,
          userId,
          kind,
          sourceEventId: event.id,
          sourceId: params.sourceId,
          sourceGeneration: params.sourceGeneration,
          sourceCreatedAt: event.createdAt,
          expiresAt,
          subscriptions: active.map((s) => ({ id: s.id, generation: s.generation })),
        })
        for (const device of plan?.devices ?? []) {
          jobs.push(
            deliverJob(
              { workspaceId, deliveryId: device.id, attempt: 0, sourceStreamId: params.sourceStreamId },
              new Date()
            )
          )
        }
      }
      await QueueRepository.batchInsert(client, jobs)
    })
  }

  /** Everything a delay can change, rechecked on every attempt. */
  private async prepareAttempt(claimed: ClaimedPushDelivery, data: PushDeliverJobData): Promise<PreparedAttempt> {
    const { workspaceId, userId, kind } = claimed
    if (!claimed.subscription) return drop(PUSH_DELIVERY_STATUSES.SUPERSEDED, PUSH_SUPPRESSION_REASONS.SUPERSEDED)

    const deadline = sendDeadline(kind, claimed.sourceCreatedAt, claimed.expiresAt)
    if (sendableTtlSeconds(claimed.expiresAt, deadline, Date.now()) === null) {
      return drop(PUSH_DELIVERY_STATUSES.EXPIRED, PUSH_SUPPRESSION_REASONS.EXPIRED)
    }

    const content = await this.resolveContent(claimed, data)
    if (!content.valid) return drop(PUSH_DELIVERY_STATUSES.SUPPRESSED, content.reason)

    const recipient = await this.checkRecipient(workspaceId, userId, content.activity)
    if (!recipient.eligible) return drop(PUSH_DELIVERY_STATUSES.SUPPRESSED, recipient.reason)

    const { active } = await this.getTargetSubscriptions(workspaceId, userId)
    const targeted = active.some(
      (s) => s.id === claimed.subscriptionId && s.generation === claimed.subscriptionGeneration
    )
    if (!targeted) return drop(PUSH_DELIVERY_STATUSES.SUPPRESSED, PUSH_SUPPRESSION_REASONS.NOT_TARGETED)

    const workosUserId = content.withWorkosUserId ? await this.lookups.getWorkosUserId(workspaceId, userId) : null
    const payloadData = {
      ...content.data,
      ...(workosUserId ? { workosUserId } : {}),
      ...(content.withButtons
        ? {
            // Button preferences ride every card so the worker renders them without a fetch.
            pushActions: recipient.prefs.pushActions,
            pushReminderMinutes: recipient.prefs.pushReminderMinutes,
            pushQuickReaction: recipient.prefs.pushQuickReaction,
          }
        : {}),
    }
    const receipt = content.receipt && supportsReceipts(claimed.subscription.receiptVersion) ? content.receipt : null
    return {
      send: true,
      subscription: claimed.subscription,
      data: payloadData,
      receipt,
      topic: content.topic,
      deadline,
    }
  }

  /**
   * When this attempt wants a receipt, arm it with a fresh capability in one
   * transaction with a lease renewal: the renewal's version CAS row-locks the
   * delivery, so only the current claim holder can rotate the token. The
   * user's consent grant is read in that transaction, after the receipt row is
   * locked (the order ingest uses), so the capability is issued only under the
   * grant that is current when it commits. No grant, or a failed arming, never
   * fails the attempt; it sends without a capability. Either way
   * the claim is re-asserted by a standalone renewal as the last step before
   * the send: the arming transaction's lease is measured from its start (NOW()),
   * so a slow arm can commit an already-lapsed lease that a rival may reclaim.
   */
  private async renewLeaseAndArmReceipt(
    claimed: ClaimedPushDelivery,
    { receipt, topic, subscription }: Extract<PreparedAttempt, { send: true }>
  ): Promise<{ owned: boolean; receiptToken: string | null }> {
    const lease = {
      workspaceId: claimed.workspaceId,
      deliveryId: claimed.id,
      claimVersion: claimed.version,
      leaseMs: PUSH_DELIVERY_LEASE_MS,
    }
    let receiptToken: string | null = null
    if (receipt) {
      const token = newReceiptToken()
      try {
        const armed = await withTransaction(this.pool, async (client) => {
          if (!(await PushDeliveryRepository.renewLease(client, lease))) return null
          await PushReceiptRepository.lockDelivery(client, { workspaceId: claimed.workspaceId, deliveryId: claimed.id })
          const consentGeneration = await this.lookups.findAnalyticsConsentGrant(client, claimed.userId)
          if (consentGeneration === null) return false
          return PushReceiptRepository.armDelivery(client, {
            workspaceId: claimed.workspaceId,
            userId: claimed.userId,
            deliveryId: claimed.id,
            subscriptionId: claimed.subscriptionId,
            streamId: receipt.streamId,
            tokenHash: sha256Hex(token),
            consentGeneration,
            capabilityExpiresAt: new Date(claimed.expiresAt.getTime() + DELIVERY_RECEIPT_GRACE_MS),
            retainUntil: new Date(claimed.expiresAt.getTime() + PUSH_DELIVERY_RETENTION_MS),
          })
        })
        if (armed === null) return { owned: false, receiptToken: null }
        if (armed) {
          this.telemetry.recordReceipt(PUSH_RECEIPT_RESULTS.ISSUED)
          receiptToken = token
        }
      } catch (err) {
        this.receiptIssueFailed(claimed.kind, err)
      }
    }
    const owned = await PushDeliveryRepository.renewLease(this.pool, {
      ...lease,
      sent: {
        topic: topic ?? null,
        withReceipt: receiptToken !== null,
        endpointHash: sha256Hex(subscription.endpoint),
      },
    })
    return { owned, receiptToken: owned ? receiptToken : null }
  }

  /** Store an explicit test's per-device rows before sending. On failure the test still sends, provider results only. */
  private async armTestReceipts(
    workspaceId: string,
    userId: string,
    testId: string,
    subscriptions: PushSubscription[]
  ): Promise<{ tokens: Map<string, string>; progress: { expiresAt: string } | null }> {
    const tokens = new Map(
      subscriptions.filter((s) => supportsReceipts(s.receiptVersion)).map((s) => [s.id, newReceiptToken()] as const)
    )
    const now = Date.now()
    const expiresAt = new Date(now + TEST_RECEIPT_CAPABILITY_MS)
    try {
      await PushReceiptRepository.insertTestDevices(this.pool, {
        workspaceId,
        userId,
        testId,
        devices: subscriptions.map((s) => {
          const token = tokens.get(s.id)
          return {
            subscriptionId: s.id,
            deviceKey: s.deviceKey,
            userAgent: s.userAgent,
            tokenHash: token ? sha256Hex(token) : null,
          }
        }),
        capabilityExpiresAt: expiresAt,
        retainUntil: new Date(now + TEST_RECEIPT_RETENTION_MS),
      })
      for (let i = 0; i < tokens.size; i++) this.telemetry.recordReceipt(PUSH_RECEIPT_RESULTS.ISSUED)
      return { tokens, progress: { expiresAt: expiresAt.toISOString() } }
    } catch (err) {
      this.receiptIssueFailed(PUSH_SEND_KINDS.TEST, err)
      return { tokens: new Map(), progress: null }
    }
  }

  private receiptIssueFailed(kind: PushSendKind, err: unknown): void {
    this.telemetry.recordReceipt(PUSH_RECEIPT_RESULTS.ISSUE_FAILED)
    logger.warn({ kind, errorCode: safeErrorCode(err) }, "Push receipt capability not issued; sending without it")
  }

  /**
   * The consent grant the receipt was armed under is still the current one,
   * and the root policy allows it now; issuance-time eligibility is never
   * trusted. A grant withdrawn and given again is a different grant.
   */
  private async deliveryReceiptAllowed(db: Querier, workspaceId: string, receipt: LivePushReceipt): Promise<boolean> {
    const grant = await this.lookups.findAnalyticsConsentGrant(db, receipt.userId)
    if (grant === null || grant !== receipt.consentGeneration) return false
    return receipt.streamId === null || !(await this.lookups.isE2eRootedStream(db, workspaceId, receipt.streamId))
  }

  /** Current source content per kind; the event snapshot is never reused. */
  private async resolveContent(claimed: ClaimedPushDelivery, data: PushDeliverJobData): Promise<ResolvedContent> {
    const { workspaceId, userId, sourceId } = claimed

    if (claimed.kind === PUSH_SEND_KINDS.ACTIVITY) {
      const resolution = await this.lookups.resolveActivityPush({
        workspaceId,
        userId,
        activityId: sourceId,
        plannedStreamId: data.sourceStreamId,
      })
      if (!resolution.valid) return { valid: false, reason: ACTIVITY_INVALID_REASONS[resolution.reason] }
      const source = resolution.source
      // A missed call renders with its own SW branch ("Missed call from …"): the
      // generic message-grouping path has no missed_call copy, so it would title
      // the banner "New message". The kind + mode route it to the dedicated branch.
      const isMissedCall = source.activityType === ActivityTypes.MISSED_CALL
      const isMention = source.activityType === ActivityTypes.MENTION
      return {
        valid: true,
        activity: { activityType: source.activityType, streamId: source.streamId },
        receipt: source.encrypted || source.e2eRooted ? null : { streamId: source.streamId },
        withWorkosUserId: true,
        withButtons: true,
        // Topic keyed by stream + notification group: mentions display under their
        // own tag in the SW, so they collapse separately from plain messages.
        topic: source.streamId ? pushTopic(source.streamId, isMention ? "m" : "") : undefined,
        data: {
          ...(isMissedCall ? { kind: "missed_call" as const, mode: source.mode ?? undefined } : {}),
          workspaceId,
          streamId: source.streamId,
          messageId: source.messageId,
          activityType: source.activityType,
          contentPreview: source.encrypted
            ? ENCRYPTED_MESSAGE_PREVIEW_LABEL
            : (resolvePushPreview(source.contentMarkdown) ?? undefined),
          streamName: source.streamName ?? undefined,
          authorName: source.authorName ?? undefined,
          authorAvatarUrl: source.authorAvatarUrl,
          // Reactions are stored as shortcodes; a custom emoji has no character
          // and stays as its shortcode.
          emoji: source.emoji ? (toEmoji(source.emoji) ?? source.emoji) : undefined,
        },
      }
    }

    if (claimed.kind === PUSH_SEND_KINDS.SAVED_REMINDER) {
      const reminder =
        claimed.sourceGeneration === null
          ? null
          : await this.lookups.resolveFiredReminder({
              workspaceId,
              userId,
              savedId: sourceId,
              reminderGeneration: claimed.sourceGeneration,
            })
      if (!reminder) return { valid: false, reason: PUSH_SUPPRESSION_REASONS.SOURCE_GONE }
      // When the message is unavailable (deleted or access lost) the reminder
      // still notifies — the user set it deliberately — with the reason so the
      // SW renders "Reminder (message deleted)", and no content.
      return {
        valid: true,
        activity: null,
        receipt: reminder.e2eRooted ? null : { streamId: reminder.streamId },
        withWorkosUserId: false,
        withButtons: false,
        topic: pushTopic(sourceId),
        data: {
          kind: "saved_reminder",
          workspaceId,
          savedId: sourceId,
          streamId: reminder.streamId,
          messageId: reminder.messageId,
          // When the message was saved from a conversation, the SW deep-links the
          // click into the conversation panel instead of the stream permalink.
          conversationId: reminder.conversationId ?? undefined,
          streamName: reminder.streamName,
          // Standalone (message-less) items preview their own title.
          contentPreview: resolvePushPreview(reminder.contentMarkdown) ?? reminder.title,
          unavailableReason: reminder.unavailableReason ?? null,
        },
      }
    }

    const outstanding = await this.lookups.isRewrapOutstanding({
      workspaceId,
      rootStreamId: sourceId,
      ownerUserId: userId,
    })
    if (!outstanding) return { valid: false, reason: PUSH_SUPPRESSION_REASONS.SOURCE_GONE }
    // A rewrap nudge only exists for end-to-end encrypted scratchpads: never a receipt.
    return {
      valid: true,
      activity: null,
      receipt: null,
      withWorkosUserId: true,
      withButtons: false,
      // "r" suffix keeps repeated nudges collapsing with each other, not with
      // message pushes for the same stream.
      topic: pushTopic(sourceId, "r"),
      data: { kind: "rewrap_needed", workspaceId, streamId: sourceId },
    }
  }

  /**
   * A job that could not claim its attempt: finished work (terminal, a later
   * attempt, or retention-deleted) completes quietly. An attempt that is only
   * leased or not yet due gets a wake-up job at the time a claim can succeed,
   * committed before this job completes — so a retry that follows a failure
   * mid-attempt neither strands the delivery nor burns the queue's short
   * retry budget waiting out the lease.
   */
  private async wakeWhenClaimable(db: Querier, data: PushDeliverJobData): Promise<void> {
    const state = await PushDeliveryRepository.findState(db, {
      workspaceId: data.workspaceId,
      deliveryId: data.deliveryId,
    })
    if (!state || state.status !== PUSH_DELIVERY_STATUSES.PENDING || state.attempts !== data.attempt) return

    const wake = (data.wake ?? 0) + 1
    await QueueRepository.batchInsert(db, [
      {
        ...deliverJob({ ...data, wake }, new Date(state.claimableAt.getTime() + WAKE_MARGIN_MS)),
        id: `${data.deliveryId}_a${data.attempt}_v${state.version}_w${wake}`,
      },
    ])
  }

  /**
   * Recipient gates shared by planning and every attempt: notification level,
   * do-not-disturb (evaluated at delivery time, so an expired pause stops
   * suppressing even while the user is offline) and, for activities, the
   * mentions-mode rule.
   */
  private async checkRecipient(
    workspaceId: string,
    userId: string,
    activity: { activityType: string; streamId: string | null } | null
  ): Promise<{ eligible: true; prefs: PushPreferences } | { eligible: false; reason: PushSuppressionReason }> {
    const prefs = await this.lookups.getUserPushPreferences(workspaceId, userId)
    if (prefs.notificationLevel === PrefNotificationLevels.NONE) {
      return { eligible: false, reason: PUSH_SUPPRESSION_REASONS.PREF_NONE }
    }
    // Do-not-disturb suppresses push delivery (the activity feed already
    // recorded the row — DND silences the alert, it does not drop history).
    if (await this.lookups.isNotificationPaused(workspaceId, userId)) {
      return { eligible: false, reason: PUSH_SUPPRESSION_REASONS.PAUSED }
    }
    if (
      activity &&
      prefs.notificationLevel === PrefNotificationLevels.MENTIONS &&
      !(await this.shouldPushForMentionsMode(workspaceId, activity.activityType, activity.streamId))
    ) {
      return { eligible: false, reason: PUSH_SUPPRESSION_REASONS.MENTIONS_MODE }
    }
    return { eligible: true, prefs }
  }

  /**
   * For "mentions" mode: push if activityType is "mention", or if the message
   * or reaction is from a DM or scratchpad (direct communication channels).
   *
   * Reactions follow the same semantics as messages (thread-activity tier,
   * not mention tier) — they push in direct channels, not in general channels.
   */
  private async shouldPushForMentionsMode(
    workspaceId: string,
    activityType: string,
    /** Null only for stream-less saved_reminder rows, which never reach the DM/scratchpad check below. */
    streamId: string | null
  ): Promise<boolean> {
    if (activityType === ActivityTypes.MENTION) {
      return true
    }

    // A missed call is direct communication like a DM message — it pushes in
    // mentions mode regardless of the host stream type.
    if (activityType === ActivityTypes.MISSED_CALL) {
      return true
    }

    if ((activityType === ActivityTypes.MESSAGE || activityType === ActivityTypes.REACTION) && streamId !== null) {
      const streamType = await this.lookups.getStreamType(workspaceId, streamId)
      if (streamType === StreamTypes.DM || streamType === StreamTypes.SCRATCHPAD) {
        return true
      }
    }

    return false
  }

  /**
   * Deliver the incoming-call ring push. High-urgency, short-TTL, topic-collapsed
   * on the attempt id so the matching cancel push supersedes an undelivered ring.
   * Respects the invitee's notification preference and do-not-disturb (NONE or
   * DND → no push; the in-app socket ring still fires, and the overlay is
   * quiet-able). Fans to the invitee's devices without the focus-suppression
   * of `getTargetSubscriptions` — a ring must reach a locked phone. Structured
   * payload (INV-46): the service worker composes the notification.
   */
  async deliverCallRing(payload: CallInvitationCreatedOutboxPayload): Promise<void> {
    const kind = PUSH_SEND_KINDS.CALL_RING
    if (!this.canSend) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PUSH_DISABLED)
    const { workspaceId, targetUserId, attemptId, callId, streamId, inviter, mode, expiresAt } = payload

    const { notificationLevel: prefLevel } = await this.lookups.getUserPushPreferences(workspaceId, targetUserId)
    if (prefLevel === PrefNotificationLevels.NONE) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PREF_NONE)
    if (await this.lookups.isNotificationPaused(workspaceId, targetUserId)) {
      return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PAUSED)
    }

    const subscriptions = await PushSubscriptionRepository.findByUserId(this.pool, workspaceId, targetUserId)
    if (subscriptions.length === 0) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.NO_SUBSCRIPTIONS)

    const recipientWorkosUserId = await this.lookups.getWorkosUserId(workspaceId, targetUserId)
    const pushPayload = JSON.stringify({
      data: {
        kind: "call_ring",
        workspaceId,
        workosUserId: recipientWorkosUserId ?? undefined,
        attemptId,
        callId,
        streamId,
        inviterName: inviter.name ?? undefined,
        mode,
        expiresAt,
      },
    })

    await this.sendAndEvictStale(
      workspaceId,
      subscriptions,
      () => pushPayload,
      { ttlSeconds: CALL_RING_TTL_SECONDS, urgency: "high", topic: pushTopic(attemptId, "c") },
      kind
    )
  }

  /**
   * Cancel a ring push on every settle (accept/decline/cancel/expire). Same topic
   * as the ring so an undelivered ring queued for an offline device collapses to
   * this cancel; a delivered ring is closed by the service worker.
   *
   * Gated on the same preference/DND check as {@link deliverCallRing}: if the ring
   * itself was suppressed (NONE / do-not-disturb) then nothing was ever queued to
   * collapse, and a cancel push that shows no notification would burn the browser's
   * silent-push quota (Firefox revokes the subscription at 0) — so there is nothing
   * to cancel.
   */
  async deliverCallRingCancel(payload: CallInvitationSettledOutboxPayload): Promise<void> {
    const kind = PUSH_SEND_KINDS.CALL_RING_CANCEL
    if (!this.canSend) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PUSH_DISABLED)
    const { workspaceId, targetUserId, attemptId, inviterName } = payload

    const { notificationLevel: prefLevel } = await this.lookups.getUserPushPreferences(workspaceId, targetUserId)
    if (prefLevel === PrefNotificationLevels.NONE) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PREF_NONE)
    if (await this.lookups.isNotificationPaused(workspaceId, targetUserId)) {
      return this.suppress(kind, PUSH_SUPPRESSION_REASONS.PAUSED)
    }

    const subscriptions = await PushSubscriptionRepository.findByUserId(this.pool, workspaceId, targetUserId)
    if (subscriptions.length === 0) return this.suppress(kind, PUSH_SUPPRESSION_REASONS.NO_SUBSCRIPTIONS)

    const pushPayload = JSON.stringify({
      data: {
        kind: "call_ring_cancel",
        workspaceId,
        attemptId,
        inviterName: inviterName ?? undefined,
        // The SW's no-ring-shown fallback branches on this: the user's own act
        // (accepted/declined) must not render as "call ended".
        outcome: payload.outcome,
      },
    })

    await this.sendAndEvictStale(
      workspaceId,
      subscriptions,
      () => pushPayload,
      { ttlSeconds: CALL_RING_TTL_SECONDS, urgency: "high", topic: pushTopic(attemptId, "c") },
      kind
    )
  }

  /**
   * Sends a push payload to the given subscriptions, records each push
   * service answer, and batch-deletes registrations that are gone (404/410,
   * INV-56). Shared by all delivery paths (INV-35).
   *
   * Deliberately NO web-push "clear" fan-out exists here (it used to): a push
   * that results in no visible notification counts against browser silent-push
   * quotas — Firefox revokes the subscription outright when its quota hits 0,
   * iOS revokes after 3 — so notification-less pushes actively destroy the
   * registrations they ride on. Cross-device dismissal rides the socket
   * instead (workspace-sync posts SW_MSG_CLEAR_NOTIFICATIONS for open apps)
   * plus a bootstrap-time sweep for apps that were closed
   * (lib/notification-sweep.ts).
   */
  private async sendAndEvictStale(
    workspaceId: string,
    subscriptions: PushSubscription[],
    payloadFor: (subscription: PushSubscription) => string,
    options: PushDeliveryOptions,
    kind: PushSendKind
  ): Promise<DeviceSendResult[]> {
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = await sendToDevice(subscription, payloadFor(subscription), options)
        this.telemetry.recordSendOutcome({ ...result, kind, provider: providerFamily(subscription.endpoint) })
        return { ...result, subscription }
      })
    )

    // Pinned to the generation that was sent to: a registration re-keyed since
    // then is a new binding and must survive this eviction.
    const stale = results
      .filter((r) => r.outcome === PUSH_PROVIDER_OUTCOMES.REGISTRATION_GONE)
      .map((r) => ({ id: r.subscription.id, generation: r.subscription.generation }))
    if (stale.length > 0) {
      try {
        await PushSubscriptionRepository.deleteByIdsAtGeneration(this.pool, workspaceId, stale)
      } catch (deleteErr) {
        logger.warn(
          { kind, count: stale.length, errorCode: safeErrorCode(deleteErr) },
          "Failed to delete stale push subscriptions"
        )
      }
    }
    return results
  }

  /** Settle a claimed attempt that sent nothing, guarded by its claim. */
  private async settleUnsent(
    db: Querier,
    claimed: ClaimedPushDelivery,
    status: TerminalPushDeliveryStatus,
    reason: string
  ): Promise<void> {
    await PushDeliveryRepository.settle(db, {
      workspaceId: claimed.workspaceId,
      deliveryId: claimed.id,
      claimVersion: claimed.version,
      settlement: { kind: "terminal", status, attempted: false, outcome: null, statusCode: null, reason },
    })
  }

  private suppress(kind: PushSendKind, reason: PushSuppressionReason): void {
    this.telemetry.recordSuppressed(kind, reason)
  }

  /**
   * Determines which devices should receive a push notification and which
   * have expired sessions that should be cleaned up.
   *
   * Returns `active` (subscriptions to deliver to) and `expired` (subscriptions
   * on devices with no session within SESSION_EXPIRY_WINDOW_MS — these get a
   * session-expired push and are cleaned up).
   *
   * Routing rule for active subscriptions:
   *   - If any device is currently focused AND has had a real user interaction
   *     in the last 2 minutes, push only to those device(s) — the SW on a
   *     focused device suppresses display since the user can already see Threa,
   *     and other devices stay quiet so the user doesn't get duplicate alerts
   *     where they aren't looking.
   *   - Otherwise (no focused-and-interacting device, or the user has put the
   *     phone down / walked away), fan out to every device with a live
   *     heartbeat so the user gets the notification on whichever device they
   *     pick up next.
   */
  private async getTargetSubscriptions(
    workspaceId: string,
    userId: string
  ): Promise<{ active: PushSubscription[]; expired: PushSubscription[] }> {
    // INV-30: multiple related reads share a client; INV-41: release before network I/O
    const { allSubs, activeSessions, recentDeviceKeys } = await withClient(this.pool, async (client) => {
      const subs = await PushSubscriptionRepository.findByUserId(client, workspaceId, userId)
      if (subs.length === 0)
        return {
          allSubs: subs,
          activeSessions: [] as Awaited<ReturnType<typeof UserSessionRepository.getActiveSessions>>,
          recentDeviceKeys: new Set<string>(),
        }
      const sessions = await UserSessionRepository.getActiveSessions(
        client,
        workspaceId,
        userId,
        ACTIVE_SESSION_WINDOW_MS
      )
      // Check which device keys have had any session activity within the expiry
      // window — cross-workspace, because the auth cookie is global.
      const subDeviceKeys = [...new Set(subs.map((s) => s.deviceKey))]
      const deviceKeys = await UserSessionRepository.getRecentDeviceKeys(
        client,
        subDeviceKeys,
        SESSION_EXPIRY_WINDOW_MS
      )
      return { allSubs: subs, activeSessions: sessions, recentDeviceKeys: deviceKeys }
    })
    if (allSubs.length === 0) return { active: [], expired: [] }

    // Partition subscriptions by whether the device still looks logged in.
    //
    // Two independent signals prove a device is still authenticated, and EITHER
    // keeps the subscription alive:
    //   1. A socket heartbeat for the device within the window (recentDeviceKeys,
    //      cross-workspace since the auth cookie is global).
    //   2. A recent authenticated re-registration of the subscription itself
    //      (updatedAt — the only write to this row). The frontend re-runs the
    //      idempotent subscribe handshake over HTTP on every app open/foreground.
    //      This is the signal that survives a backend socket-session timeout: on
    //      devices where WebSockets are flaky or short-lived (mobile, iOS PWA,
    //      proxies that block WS) the heartbeat never lands, but the HTTP
    //      re-register does, so the user who keeps opening the app keeps push.
    //
    // A subscription is only "expired" (→ session-expired push + cleanup) once
    // BOTH signals are stale for the full window — i.e. the device genuinely
    // hasn't logged in for ~30 days (matching the auth cookie TTL).
    const activeSubs: PushSubscription[] = []
    const expiredSubs: PushSubscription[] = []
    for (const sub of allSubs) {
      if (isSessionLive(sub, recentDeviceKeys)) {
        activeSubs.push(sub)
      } else {
        expiredSubs.push(sub)
      }
    }

    if (activeSubs.length === 0) return { active: [], expired: expiredSubs }

    // No live heartbeats anywhere → user is offline; fan out so they see the
    // notification on whichever device they pick up next.
    if (activeSessions.length === 0) return { active: activeSubs, expired: expiredSubs }

    // Identify devices the user is actually on right now: focused window AND a
    // real user interaction within the last 2m. A focused-but-idle window
    // (PWA running in the background of another desktop space, tab the user
    // tabbed to and then walked off) doesn't qualify.
    const now = Date.now()
    const attendedDeviceKeys = new Set(
      activeSessions
        .filter(
          (s) =>
            s.lastFocusedAt !== null &&
            now - s.lastFocusedAt.getTime() < CURRENTLY_FOCUSED_WINDOW_MS &&
            s.lastInteractionAt !== null &&
            now - s.lastInteractionAt.getTime() < RECENT_INTERACTION_WINDOW_MS
        )
        .map((s) => s.deviceKey)
    )

    if (attendedDeviceKeys.size === 0) {
      // No device proves the user is on it — fan out to every active device.
      return { active: activeSubs, expired: expiredSubs }
    }

    // Push only to the attended device(s). The SW on each device decides
    // whether to display (focused window = suppress, since the user can
    // already see Threa). If the intersection is empty (a session exists on
    // a device without a registered push subscription), fall back to fanout
    // so we still notify *something*.
    const matched = activeSubs.filter((sub) => attendedDeviceKeys.has(sub.deviceKey))
    const active = matched.length > 0 ? matched : activeSubs
    return { active, expired: expiredSubs }
  }
}

/** Either signal proves the device still authenticated within the window: a heartbeat for its device key, or a re-registration. */
function isSessionLive(sub: PushSubscription, recentDeviceKeys: ReadonlySet<string>): boolean {
  return recentDeviceKeys.has(sub.deviceKey) || sub.updatedAt.getTime() > Date.now() - SESSION_EXPIRY_WINDOW_MS
}

function noDevicesReason(expired: PushSubscription[]): PushSuppressionReason {
  return expired.length > 0 ? PUSH_SUPPRESSION_REASONS.SESSIONS_EXPIRED : PUSH_SUPPRESSION_REASONS.NO_SUBSCRIPTIONS
}

/** Anchored to the source event's time, so a late or replayed event never gains a fresh TTL. */
function expiryFor(event: PushSourceEvent): Date {
  return new Date(event.createdAt.getTime() + MESSAGE_PUSH_TTL_SECONDS * 1_000)
}

/**
 * Last moment an attempt may be sent. A rewrap nudge stops at the sweep's
 * re-emit window, after which a still-stuck turn gets a fresh nudge; its
 * push-service TTL still runs to the original expiry.
 */
function sendDeadline(kind: DurablePushKind, sourceCreatedAt: Date, expiresAt: Date): Date {
  if (kind !== PUSH_SEND_KINDS.REWRAP_NUDGE) return expiresAt
  return new Date(Math.min(expiresAt.getTime(), sourceCreatedAt.getTime() + REWRAP_WEBPUSH_REEMIT_MS))
}

function remainingSeconds(until: Date, nowMs: number): number {
  return Math.floor((until.getTime() - nowMs) / 1_000)
}

/**
 * Push-service TTL left for an attempt sent at `nowMs`, or null once its send
 * window closed. The TTL runs to the original expiry even where attempts stop
 * earlier (rewrap), since the push service may still hold it for an offline device.
 */
function sendableTtlSeconds(expiresAt: Date, deadline: Date, nowMs: number): number | null {
  const ttlSeconds = remainingSeconds(expiresAt, nowMs)
  return nowMs >= deadline.getTime() || ttlSeconds < 1 ? null : ttlSeconds
}

function deliverJob(data: PushDeliverJobData, processAfter: Date): InsertQueueMessageParams {
  return {
    id: `${data.deliveryId}_a${data.attempt}`,
    queueName: JobQueues.PUSH_DELIVER,
    workspaceId: data.workspaceId,
    payload: data,
    processAfter,
    insertedAt: new Date(),
  }
}

/** One per registration generation and notice bucket, so every event that finds the same expired device enqueues one notice. */
function sessionExpiredJobs(workspaceId: string, subscriptions: PushSubscription[]): InsertQueueMessageParams[] {
  const bucket = Math.floor(Date.now() / SESSION_EXPIRED_NOTICE_BUCKET_MS)
  return subscriptions.map((s) => {
    const payload: PushSessionExpiredJobData = { workspaceId, subscriptionId: s.id, generation: s.generation }
    return {
      id: `${s.id}_expired_g${s.generation}_b${bucket}`,
      queueName: JobQueues.PUSH_SESSION_EXPIRED,
      workspaceId,
      payload,
      processAfter: new Date(),
      insertedAt: new Date(),
    }
  })
}

const ACTIVITY_INVALID_REASONS: Record<ActivityPushInvalidReason, PushSuppressionReason> = {
  gone: PUSH_SUPPRESSION_REASONS.SOURCE_GONE,
  not_pushable: PUSH_SUPPRESSION_REASONS.NOT_PUSHABLE,
  read: PUSH_SUPPRESSION_REASONS.READ,
  sealed: PUSH_SUPPRESSION_REASONS.SOURCE_GONE,
  access_lost: PUSH_SUPPRESSION_REASONS.ACCESS_LOST,
  moved: PUSH_SUPPRESSION_REASONS.SOURCE_GONE,
}

type PreparedAttempt =
  | {
      send: true
      subscription: NonNullable<ClaimedPushDelivery["subscription"]>
      data: Record<string, unknown>
      /** Set when this attempt should carry a receipt capability. */
      receipt: { streamId: string | null } | null
      topic: string | undefined
      deadline: Date
    }
  | { send: false; status: TerminalPushDeliveryStatus; reason: PushSuppressionReason }

type ResolvedContent =
  | {
      valid: true
      /** Present for activities: drives the mentions-mode gate. */
      activity: { activityType: string; streamId: string | null } | null
      /** Null when the source's stream root is end-to-end encrypted: no receipt metadata may leave it. */
      receipt: { streamId: string | null } | null
      withWorkosUserId: boolean
      withButtons: boolean
      topic: string | undefined
      data: Record<string, unknown>
    }
  | { valid: false; reason: PushSuppressionReason }

/** The registration's active worker advertised a receipt protocol this server speaks. Unknown is unsupported. */
function supportsReceipts(receiptVersion: number | null): boolean {
  return receiptVersion !== null && receiptVersion >= PUSH_RECEIPT_SW_VERSION
}

/** 32 random bytes as base64url: the opaque capability. Only its hash is stored. */
function newReceiptToken(): string {
  return randomBytes(32).toString("base64url")
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function drop(status: TerminalPushDeliveryStatus, reason: PushSuppressionReason): PreparedAttempt {
  return { send: false, status, reason }
}
