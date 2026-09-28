import { useEffect, useRef, useState } from "react"
import {
  PUSH_RECEIPT_STAGES,
  pushTestProgressPath,
  type PushTestDeviceProgress,
  type PushTestProgress,
  type PushTestResponse,
} from "@threahq/types"
import { ApiError, api } from "@/api/client"
import { getDeviceKey } from "@/hooks/use-push-notifications"

/** How long Settings waits for device reports after a test was sent. */
const PUSH_TEST_REPORT_WINDOW_MS = 60_000
const POLL_INTERVAL_MS = 2_000
const POLL_REQUEST_TIMEOUT_MS = 5_000
/**
 * On a live page consecutive reads start at most one interval plus one request
 * timeout apart; one more interval absorbs background-tab timer clamping. A
 * newest read started longer ago than this means the page was suspended (a
 * phone left for the home screen) or badly delayed.
 */
const STALE_READ_MS = 2 * POLL_INTERVAL_MS + POLL_REQUEST_TIMEOUT_MS

/**
 * A backend that predates per-device results answers only
 * `{ attempted, failed, delivered }`, where `delivered` counts push-service
 * acceptances. One that predates receipts omits `testId`-linked `progress`.
 */
export type TestPushResult =
  | (Pick<PushTestResponse, "attempted" | "accepted"> &
      Partial<Pick<PushTestResponse, "testId" | "devices" | "progress">>)
  | Pick<PushTestResponse, "attempted" | "delivered">

export type DeviceReport = PushTestDeviceProgress["receipt"]

/**
 * Device reports for one test. `unavailable`: the backend kept no progress, so
 * only provider results exist. `waiting`: polling inside the window. `settled`:
 * every device that could report did. `closed`: the window ended; whatever is
 * still missing is unconfirmed, never failed.
 */
export type TestReports =
  | { phase: "unavailable" }
  | { phase: "waiting" | "settled" | "closed"; devices: Record<string, DeviceReport>; pollFailed: boolean }

export interface TestOutcome {
  result: TestPushResult
  thisDeviceKey: string | null
  reports: TestReports
}

export type TestStatus =
  | { kind: "idle" }
  | { kind: "sending"; previous: TestOutcome | null }
  | ({ kind: "ok" } & TestOutcome)
  | { kind: "error"; message: string }

function isTerminal(report: DeviceReport): boolean {
  return report.stage !== null && report.stage !== PUSH_RECEIPT_STAGES.RECEIVED
}

function reportsOf(progress: PushTestProgress): Record<string, DeviceReport> {
  return Object.fromEntries(progress.devices.map((device) => [device.subscriptionId, device.receipt]))
}

export function usePushTest(workspaceId: string) {
  const [state, setState] = useState<TestStatus>({ kind: "idle" })
  // Only an error resets on its own; per-device results stay until the next
  // test so they can be read.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  // Bumped per attempt and on unmount: a completion whose attempt is no longer
  // current (superseded, unsubscribed, workspace switched) is dropped.
  const attemptRef = useRef(0)

  function stopPolling() {
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
  }

  useEffect(
    () => () => {
      attemptRef.current += 1
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
      stopPolling()
    },
    []
  )

  function updateReports(attempt: number, next: (reports: TestReports) => TestReports) {
    if (attempt !== attemptRef.current) return
    setState((current) => (current.kind === "ok" ? { ...current, reports: next(current.reports) } : current))
  }

  function pollReports(attempt: number, testId: string, deadline: number) {
    let lastReadStartedAt = Date.now()
    // A suspended page gets one catch-up read with a full request budget, never more.
    let catchUpUsed = false

    const read = async (timeoutMs: number): Promise<PushTestProgress | null> => {
      lastReadStartedAt = Date.now()
      const controller = new AbortController()
      pollAbortRef.current = controller
      try {
        return await api.get<PushTestProgress>(pushTestProgressPath(workspaceId, testId), {
          signal: controller.signal,
          timeoutMs,
        })
      } catch {
        return null
      } finally {
        if (pollAbortRef.current === controller) pollAbortRef.current = null
      }
    }

    const isSettled = (devices: Record<string, DeviceReport> | null) =>
      devices !== null && Object.values(devices).every((r) => !r.expected || isTerminal(r))

    const tick = async () => {
      pollTimerRef.current = null
      // No request outlives the window: the last one is cut off at the deadline.
      const remaining = deadline - Date.now()
      // Resuming in the window's last seconds would otherwise leave only a
      // truncated read, and a just-woken radio misses it. That read is the
      // catch-up instead. The window keeps its deadline if it answers early.
      const resumedNearEnd =
        !catchUpUsed &&
        remaining > 0 &&
        remaining <= POLL_REQUEST_TIMEOUT_MS &&
        Date.now() - lastReadStartedAt > STALE_READ_MS
      if (resumedNearEnd) catchUpUsed = true
      let progress: PushTestProgress | null = null
      if (remaining > 0) {
        progress = await read(resumedNearEnd ? POLL_REQUEST_TIMEOUT_MS : Math.min(POLL_REQUEST_TIMEOUT_MS, remaining))
        if (attempt !== attemptRef.current) return
      }

      let devices = progress ? reportsOf(progress) : null
      let settled = isSettled(devices)
      let closed = !settled && Date.now() >= deadline
      // Closing on a read that started before the page was suspended would
      // call reports the server already holds unconfirmed. One more read,
      // bounded on its own, replaces it; polling never resumes after it.
      let catchUpFailed = resumedNearEnd && progress === null
      if (closed && !catchUpUsed && Date.now() - lastReadStartedAt > STALE_READ_MS) {
        catchUpUsed = true
        const caughtUp = await read(POLL_REQUEST_TIMEOUT_MS)
        if (attempt !== attemptRef.current) return
        if (caughtUp) {
          devices = reportsOf(caughtUp)
          settled = isSettled(devices)
          closed = !settled
        } else {
          catchUpFailed = true
        }
      }

      updateReports(attempt, (reports) => {
        if (reports.phase === "unavailable") return reports
        if (settled) return { phase: "settled", devices: devices!, pollFailed: false }
        if (closed)
          return {
            phase: "closed",
            devices: devices ?? reports.devices,
            pollFailed: catchUpFailed || (reports.pollFailed && !devices),
          }
        return { phase: "waiting", devices: devices ?? reports.devices, pollFailed: devices === null }
      })
      if (settled || closed) return
      pollTimerRef.current = setTimeout(tick, Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now())))
    }
    void tick()
  }

  async function sendTest() {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
    stopPolling()
    const attempt = ++attemptRef.current
    setState((current) => ({
      kind: "sending",
      previous:
        current.kind === "ok"
          ? { result: current.result, thisDeviceKey: current.thisDeviceKey, reports: current.reports }
          : null,
    }))
    try {
      // Backend-driven test: exercises DB → web-push → push service, not just
      // the local SW path.
      const [result, thisDeviceKey] = await Promise.all([
        api.post<TestPushResult>(`/api/workspaces/${workspaceId}/push/test`),
        getDeviceKey().catch(() => null),
      ])
      if (attempt !== attemptRef.current) return
      const trackedTestId =
        "testId" in result && result.testId && result.progress && (result.devices?.length ?? 0) > 0
          ? result.testId
          : null
      setState({
        kind: "ok",
        result,
        thisDeviceKey,
        reports: trackedTestId ? { phase: "waiting", devices: {}, pollFailed: false } : { phase: "unavailable" },
      })
      if (trackedTestId) pollReports(attempt, trackedTestId, Date.now() + PUSH_TEST_REPORT_WINDOW_MS)
    } catch (err) {
      if (attempt !== attemptRef.current) return
      console.error("[Push] Test push failed:", err)
      const message = ApiError.isApiError(err) ? err.message : "Failed to send test"
      setState({ kind: "error", message })
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null
        setState({ kind: "idle" })
      }, 5000)
    }
  }

  return { state, sendTest }
}
