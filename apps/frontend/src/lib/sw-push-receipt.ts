import {
  PUSH_RECEIPT_STAGES,
  PUSH_RECEIPT_TOKEN_PATTERN,
  pushReceiptPath,
  type PushReceiptRequest,
  type PushReceiptStage,
  type PushReceiptSuppressionReason,
} from "@threahq/types"

/** A report still in flight after this is abandoned; the stage stays unconfirmed server-side. */
export const PUSH_RECEIPT_TIMEOUT_MS = 5_000

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

type TerminalStage = Exclude<PushReceiptStage, typeof PUSH_RECEIPT_STAGES.RECEIVED>

export interface PushReceiptDeps {
  origin: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Keeps the push event alive until the report settles: `event.waitUntil`. */
  hold: (report: Promise<void>) => void
  timeoutMs?: number
}

export interface PushReceipt {
  received(): void
  /** Only the first terminal stage is sent; later calls are ignored. */
  settle(stage: TerminalStage, reason?: PushReceiptSuppressionReason): void
}

/**
 * Receipt reporter for one push, or null when the payload carries no usable
 * capability (old backend, unsupported worker, consent denied): then nothing
 * is reported. Reports go only to this origin's receipt route for the
 * payload's workspace, without cookies, never following a redirect, and never
 * reject, so a failed report cannot touch the notification it describes.
 */
export function createPushReceipt(
  data: { workspaceId?: unknown; receipt?: unknown },
  deps: PushReceiptDeps
): PushReceipt | null {
  const token = (data.receipt as { token?: unknown } | null | undefined)?.token
  const workspaceId = data.workspaceId
  if (typeof token !== "string" || !PUSH_RECEIPT_TOKEN_PATTERN.test(token)) return null
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) return null
  const url = new URL(pushReceiptPath(workspaceId), deps.origin)
  if (url.origin !== new URL(deps.origin).origin) return null

  const timeoutMs = deps.timeoutMs ?? PUSH_RECEIPT_TIMEOUT_MS
  const send = async (body: PushReceiptRequest): Promise<void> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await deps.fetch(url.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
      })
    } catch {
      // Unreported stays unconfirmed; there is nothing to retry into.
    } finally {
      clearTimeout(timer)
    }
  }

  let settled = false
  return {
    received() {
      deps.hold(send({ token, stage: PUSH_RECEIPT_STAGES.RECEIVED }))
    },
    settle(stage, reason) {
      if (settled) return
      settled = true
      deps.hold(send(reason ? { token, stage, reason } : { token, stage }))
    },
  }
}

/**
 * Report whether `show` created the notification. A failure is reported and
 * rethrown so the push event still sees the original error.
 */
export async function trackNotificationCreation(receipt: PushReceipt | null, show: Promise<unknown>): Promise<void> {
  try {
    await show
  } catch (error) {
    receipt?.settle(PUSH_RECEIPT_STAGES.CREATION_FAILED)
    throw error
  }
  receipt?.settle(PUSH_RECEIPT_STAGES.NOTIFICATION_CREATED)
}
