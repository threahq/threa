import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Link, MemoryRouter, Route, Routes } from "react-router-dom"
import type { PushTestDeviceProgress, PushTestProgress, PushTestResponse } from "@threahq/types"
import { act, fireEvent, render, screen, userEvent, within } from "@/test"
import { api } from "@/api/client"
import * as contextsModule from "@/contexts"
import * as pushHooksModule from "@/hooks/use-push-notifications"
import * as pauseControlsModule from "@/hooks/use-notification-pause-controls"
import * as pushActionsModule from "./push-actions-section"
import { NotificationsSettings } from "./notifications-settings"

const WS = "ws_1"
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0"
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

const push = { isSubscribed: true }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function mount() {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { notificationLevel: "all" },
    updatePreference: vi.fn(),
    updatePreferences: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  push.isSubscribed = true
  vi.spyOn(pushHooksModule, "usePushNotifications").mockImplementation(
    () =>
      ({
        permission: "granted",
        isSubscribed: push.isSubscribed,
        status: push.isSubscribed ? "subscribed" : "idle",
        error: null,
        optedOut: false,
        pushDisabledOnServer: false,
        requestPermission: vi.fn(),
        unsubscribe: vi.fn(),
        retry: vi.fn(),
      }) as unknown as ReturnType<typeof pushHooksModule.usePushNotifications>
  )
  vi.spyOn(pauseControlsModule, "useNotificationPauseControls").mockReturnValue({
    active: null,
    statusOnly: false,
    busy: false,
    pauseFor: vi.fn(),
    pauseUntilDate: vi.fn(),
    pauseUntilLocal: vi.fn(),
    resume: vi.fn(),
  } as unknown as ReturnType<typeof pauseControlsModule.useNotificationPauseControls>)
  vi.spyOn(pushActionsModule, "PushActionsSection").mockImplementation(() => <></>)
  const tree = () => (
    <MemoryRouter initialEntries={[`/w/${WS}/settings`]}>
      <Link to="/w/ws_2/settings">Other workspace</Link>
      <Routes>
        <Route path="/w/:workspaceId/settings" element={<NotificationsSettings />} />
      </Routes>
    </MemoryRouter>
  )
  const { rerender } = render(tree())
  return {
    setSubscribed(isSubscribed: boolean) {
      push.isSubscribed = isSubscribed
      rerender(tree())
    },
  }
}

function devicesResponse(
  devices: PushTestResponse["devices"],
  accepted = devices.filter((d) => d.outcome === "accepted").length
): PushTestResponse {
  return {
    testId: "push_del_x",
    attempted: devices.length,
    accepted,
    failed: devices.length - accepted,
    delivered: accepted,
    devices,
  }
}

describe("NotificationsSettings Send test", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("with per-device results", () => {
    beforeEach(() => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME_MAC)
    })

    it("should list each device with its push-service outcome and mark this device", async () => {
      const thisDeviceKey = await pushHooksModule.getDeviceKey()
      const response: PushTestResponse = {
        testId: "push_del_1",
        attempted: 3,
        accepted: 1,
        failed: 2,
        // Differs from `accepted` so the summary proves which field drives it.
        delivered: 3,
        devices: [
          {
            subscriptionId: "sub_a",
            deviceKey: thisDeviceKey,
            userAgent: CHROME_MAC,
            outcome: "accepted",
            statusCode: 201,
          },
          {
            subscriptionId: "sub_b",
            deviceKey: "other_1",
            userAgent: FIREFOX_ANDROID,
            outcome: "registration_gone",
            statusCode: 410,
          },
          {
            subscriptionId: "sub_c",
            deviceKey: "other_2",
            userAgent: SAFARI_IPHONE,
            outcome: "unreachable",
            statusCode: 503,
          },
        ],
      }
      const post = vi.spyOn(api, "post").mockResolvedValue(response)
      mount()

      await userEvent.click(screen.getByRole("button", { name: "Send test" }))

      const rows = await screen.findAllByRole("listitem")
      expect(post).toHaveBeenCalledWith(`/api/workspaces/${WS}/push/test`)
      expect(rows.map((row) => row.textContent)).toEqual([
        "Chrome on macOSThis deviceAccepted by push service",
        "Firefox on AndroidRegistration expired — removed",
        "Safari on iPhoneCouldn't reach push service",
      ])
      expect(within(rows[0]!).getByText("This device")).toBeInTheDocument()
      // Replay masks text but would still record each row's structure and tone icon.
      expect(screen.getByRole("list").closest(".ph-no-capture")).toContainElement(
        screen.getByText("Accepted by push service on 1 of 3 devices.")
      )
      expect(screen.getByText("Accepted by push service on 1 of 3 devices.")).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/delivered/i)
    })

    it("should not claim This device when several devices share this device's key", async () => {
      const thisDeviceKey = await pushHooksModule.getDeviceKey()
      vi.spyOn(api, "post").mockResolvedValue(
        devicesResponse([
          {
            subscriptionId: "sub_a",
            deviceKey: thisDeviceKey,
            userAgent: CHROME_MAC,
            outcome: "accepted",
            statusCode: 201,
          },
          {
            subscriptionId: "sub_b",
            deviceKey: thisDeviceKey,
            userAgent: CHROME_MAC,
            outcome: "rejected",
            statusCode: 400,
          },
        ])
      )
      mount()

      await userEvent.click(screen.getByRole("button", { name: "Send test" }))

      const rows = await screen.findAllByRole("listitem")
      expect(rows.map((row) => row.textContent)).toEqual([
        "Chrome on macOSAccepted by push service",
        "Chrome on macOSRejected by push service",
      ])
    })

    it("should keep the previous results on screen, marked busy, while a re-test is in flight", async () => {
      const first = devicesResponse([
        {
          subscriptionId: "sub_a",
          deviceKey: "other_1",
          userAgent: FIREFOX_ANDROID,
          outcome: "accepted",
          statusCode: 201,
        },
      ])
      const second = deferred<PushTestResponse>()
      vi.spyOn(api, "post").mockResolvedValueOnce(first).mockReturnValueOnce(second.promise)
      mount()

      await userEvent.click(screen.getByRole("button", { name: "Send test" }))
      await screen.findByText("Accepted by push service on 1 of 1 device.")
      await userEvent.click(screen.getByRole("button", { name: "Send test" }))

      expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled()
      expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
        "Firefox on AndroidAccepted by push service",
      ])
      expect(screen.getByText("Accepted by push service on 1 of 1 device.").closest("[aria-busy]")).toHaveAttribute(
        "aria-busy",
        "true"
      )

      second.resolve(
        devicesResponse([
          {
            subscriptionId: "sub_a",
            deviceKey: "other_1",
            userAgent: FIREFOX_ANDROID,
            outcome: "unreachable",
            statusCode: 503,
          },
        ])
      )

      expect(await screen.findByText("Accepted by push service on 0 of 1 device.")).toBeInTheDocument()
      expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
        "Firefox on AndroidCouldn't reach push service",
      ])
    })

    it("should drop results when push is disabled and re-enabled", async () => {
      vi.spyOn(api, "post").mockResolvedValue(
        devicesResponse([
          {
            subscriptionId: "sub_a",
            deviceKey: "other_1",
            userAgent: FIREFOX_ANDROID,
            outcome: "accepted",
            statusCode: 201,
          },
        ])
      )
      const view = mount()

      await userEvent.click(screen.getByRole("button", { name: "Send test" }))
      await screen.findByText("Accepted by push service on 1 of 1 device.")
      view.setSubscribed(false)
      view.setSubscribed(true)

      expect(screen.getByRole("button", { name: "Send test" })).toBeEnabled()
      expect(screen.queryByText(/Accepted by push service/)).not.toBeInTheDocument()
      expect(screen.queryAllByRole("listitem")).toEqual([])
    })

    it("should ignore a test that completes after push was disabled", async () => {
      const pending = deferred<PushTestResponse>()
      vi.spyOn(api, "post").mockReturnValue(pending.promise)
      const view = mount()

      await userEvent.click(screen.getByRole("button", { name: "Send test" }))
      view.setSubscribed(false)
      pending.resolve(
        devicesResponse([
          {
            subscriptionId: "sub_a",
            deviceKey: "other_1",
            userAgent: FIREFOX_ANDROID,
            outcome: "accepted",
            statusCode: 201,
          },
        ])
      )
      await pending.promise
      view.setSubscribed(true)

      expect(screen.getByRole("button", { name: "Send test" })).toBeEnabled()
      expect(screen.queryByText(/Accepted by push service/)).not.toBeInTheDocument()
    })

    it("should not carry results or a pending test over to another workspace", async () => {
      const pending = deferred<PushTestResponse>()
      const post = vi
        .spyOn(api, "post")
        .mockResolvedValueOnce(
          devicesResponse([
            {
              subscriptionId: "sub_a",
              deviceKey: "other_1",
              userAgent: FIREFOX_ANDROID,
              outcome: "accepted",
              statusCode: 201,
            },
          ])
        )
        .mockReturnValueOnce(pending.promise)
      mount()

      await userEvent.click(screen.getByRole("button", { name: "Send test" }))
      await screen.findByText("Accepted by push service on 1 of 1 device.")
      await userEvent.click(screen.getByRole("button", { name: "Send test" }))
      await userEvent.click(screen.getByRole("link", { name: "Other workspace" }))
      pending.resolve(devicesResponse([]))
      await pending.promise

      expect(post).toHaveBeenLastCalledWith(`/api/workspaces/${WS}/push/test`)
      expect(screen.getByRole("button", { name: "Send test" })).toBeEnabled()
      expect(screen.queryByText(/Accepted by push service|No devices subscribed/)).not.toBeInTheDocument()
    })
  })

  it("should summarize a response from a backend that predates per-device results", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ attempted: 2, failed: 0, delivered: 2 })
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Send test" }))

    expect(await screen.findByText("Accepted by push service on 2 of 2 devices.")).toBeInTheDocument()
    expect(screen.queryAllByRole("listitem")).toEqual([])
    expect(document.body.textContent).not.toMatch(/delivered/i)
  })

  it("should keep the empty copy when no device is subscribed", async () => {
    vi.spyOn(api, "post").mockResolvedValue({
      testId: "push_del_2",
      attempted: 0,
      accepted: 0,
      failed: 0,
      delivered: 0,
      devices: [],
    })
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Send test" }))

    expect(await screen.findByText("No devices subscribed yet.")).toBeInTheDocument()
  })
})

describe("NotificationsSettings Send test device reports", () => {
  const THIS_KEY = "this_key"
  const progressPath = `/api/workspaces/${WS}/push/test/push_del_t`

  function device(
    subscriptionId: string,
    userAgent: string,
    outcome: PushTestResponse["devices"][number]["outcome"],
    deviceKey = `key_${subscriptionId}`
  ): PushTestResponse["devices"][number] {
    const statusCode = { accepted: 201, rejected: 400, unreachable: 503, registration_gone: 410 }[outcome as string]
    return { subscriptionId, deviceKey, userAgent, outcome, statusCode: statusCode ?? null }
  }

  function testResponse(devices: PushTestResponse["devices"]): PushTestResponse {
    return {
      ...devicesResponse(devices),
      testId: "push_del_t",
      progress: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
    }
  }

  function progress(
    devices: PushTestResponse["devices"],
    receipts: Record<string, Partial<PushTestDeviceProgress["receipt"]>>
  ): PushTestProgress {
    return {
      testId: "push_del_t",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      devices: devices.map((d) => ({
        ...d,
        receipt: { expected: true, stage: null, reason: null, ...receipts[d.subscriptionId] },
      })),
    }
  }

  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  function rows() {
    return screen.queryAllByRole("listitem").map((row) => row.textContent)
  }

  async function sendTest() {
    fireEvent.click(screen.getByRole("button", { name: "Send test" }))
    await flush()
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.spyOn(pushHooksModule, "getDeviceKey").mockResolvedValue(THIS_KEY)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("should disclose the first-party device report before a test is sent", () => {
    mount()

    expect(screen.getByRole("button", { name: "Send test" })).toHaveAccessibleDescription(
      "Devices on a current version of Threa report back to Threa whether they created it. Those reports expire after 24 hours and are only shown here."
    )
  })

  it("should follow a device from received to notification created and then stop polling", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted", THIS_KEY)]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(progress(devices, {}))
      .mockResolvedValueOnce(progress(devices, { sub_a: { stage: "received" } }))
      .mockResolvedValue(progress(devices, { sub_a: { stage: "notification_created" } }))
    mount()

    await sendTest()
    const waiting = rows()
    await flush(2_000)
    const received = rows()
    await flush(2_000)
    const created = rows()
    await flush(20_000)

    expect({ waiting, received, created, polls: get.mock.calls.length, path: get.mock.calls[0]![0] }).toEqual({
      waiting: ["Chrome on macOSThis deviceAccepted by push serviceWaiting for device report"],
      received: ["Chrome on macOSThis deviceAccepted by push serviceReceived by device"],
      created: ["Chrome on macOSThis deviceAccepted by push serviceNotification created"],
      polls: 3,
      path: progressPath,
    })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("should show provider failures and device reports as separate results", async () => {
    const devices = [
      device("sub_a", CHROME_MAC, "accepted"),
      device("sub_b", FIREFOX_ANDROID, "rejected"),
      device("sub_c", SAFARI_IPHONE, "unreachable"),
    ]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    vi.spyOn(api, "get").mockResolvedValue(
      progress(devices, {
        sub_a: { stage: "creation_failed" },
        sub_b: { expected: false },
        sub_c: { stage: "notification_created" },
      })
    )
    mount()

    await sendTest()

    expect(rows()).toEqual([
      "Chrome on macOSAccepted by push serviceDevice couldn't create the notification",
      "Firefox on AndroidRejected by push service",
      "Safari on iPhoneCouldn't reach push serviceNotification created",
    ])
  })

  it("should call a device unconfirmed, not failed, once the 60 second window ends without a report", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted"), device("sub_b", FIREFOX_ANDROID, "accepted")]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    const get = vi.spyOn(api, "get").mockResolvedValue(progress(devices, { sub_b: { stage: "received" } }))
    mount()

    await sendTest()
    await flush(59_000)
    const beforeDeadline = rows()
    await flush(1_000)
    const pollsAtClose = get.mock.calls.length
    await flush(30_000)

    expect({
      beforeDeadline,
      after: rows(),
      note: screen.getByRole("status").textContent,
      extraPolls: get.mock.calls.length - pollsAtClose,
    }).toEqual({
      beforeDeadline: [
        "Chrome on macOSAccepted by push serviceWaiting for device report",
        "Firefox on AndroidAccepted by push serviceReceived by device",
      ],
      after: [
        "Chrome on macOSAccepted by push serviceNot confirmed by device",
        "Firefox on AndroidAccepted by push serviceReceived, notification not confirmed",
      ],
      note: "A device that didn't report within a minute may still have shown the notification.",
      extraPolls: 0,
    })
    expect(document.body.textContent).not.toMatch(/failed/i)
  })

  it("should close the window at 60 seconds even while a report check is still in flight", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    // Every check hangs until the client's own request timeout gives up on it.
    vi.spyOn(api, "get").mockImplementation(
      (_path, options) =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), options?.timeoutMs ?? Infinity)
        )
    )
    mount()

    await sendTest()
    await flush(60_000)

    expect(rows()).toEqual(["Chrome on macOSAccepted by push serviceNot confirmed by device"])
  })

  describe("when the page was suspended past the window", () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    const SUSPENDED_MS = 70_000

    function catchUpOptions(calls: ReadonlyArray<ReadonlyArray<unknown>>) {
      const options = calls.at(-1)?.[1] as { timeoutMs?: number; signal?: AbortSignal } | undefined
      return { timeoutMs: options?.timeoutMs, aborted: options?.signal?.aborted }
    }

    it("should read once more on resume and show the stage recorded while the page was frozen", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, {}))
        .mockResolvedValue(progress(devices, { sub_a: { stage: "notification_created" } }))
      mount()

      await sendTest()
      const beforeSuspension = rows()
      // Frozen: the wall clock runs on, the pending poll timer does not.
      vi.setSystemTime(Date.now() + SUSPENDED_MS)
      await flush(2_000)
      const resumed = { rows: rows(), polls: get.mock.calls.length, catchUp: catchUpOptions(get.mock.calls) }
      await flush(30_000)

      expect({
        beforeSuspension,
        resumed,
        pollsLater: get.mock.calls.length,
        note: screen.queryByRole("status"),
      }).toEqual({
        beforeSuspension: ["Chrome on macOSAccepted by push serviceWaiting for device report"],
        resumed: {
          rows: ["Chrome on macOSAccepted by push serviceNotification created"],
          polls: 2,
          catchUp: { timeoutMs: 5_000, aborted: false },
        },
        pollsLater: 2,
        note: null,
      })
    })

    it("should replace a read that started before the suspension with one fresh read", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const frozen = deferred<PushTestProgress>()
      const get = vi
        .spyOn(api, "get")
        .mockReturnValueOnce(frozen.promise)
        .mockResolvedValue(progress(devices, { sub_a: { stage: "notification_created" } }))
      mount()

      await sendTest()
      vi.setSystemTime(Date.now() + SUSPENDED_MS)
      // The response to the pre-suspension request lands after resume, stale.
      frozen.resolve(progress(devices, { sub_a: { stage: "received" } }))
      await flush()
      const resumed = { rows: rows(), polls: get.mock.calls.length }
      await flush(30_000)

      expect({ resumed, pollsLater: get.mock.calls.length }).toEqual({
        resumed: { rows: ["Chrome on macOSAccepted by push serviceNotification created"], polls: 2 },
        pollsLater: 2,
      })
    })

    it("should close as unchecked when the one catch-up read times out", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, { sub_a: { stage: "received" } }))
        .mockImplementation(
          (_path, options) =>
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error("Request timed out")), options?.timeoutMs ?? Infinity)
            )
        )
      mount()

      await sendTest()
      vi.setSystemTime(Date.now() + SUSPENDED_MS)
      await flush(2_000)
      const during = rows()
      await flush(5_000)
      const closed = { rows: rows(), note: screen.getByRole("status").textContent }
      await flush(30_000)

      expect({ during, closed, polls: get.mock.calls.length }).toEqual({
        during: ["Chrome on macOSAccepted by push serviceReceived by device"],
        closed: {
          rows: ["Chrome on macOSAccepted by push serviceReceived, notification not confirmed"],
          note: "Couldn't check device reports.",
        },
        polls: 2,
      })
    })

    it("should cancel the catch-up read when a new test supersedes it or push is disabled", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const lateCatchUp = deferred<PushTestProgress>()
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, {}))
        .mockReturnValueOnce(lateCatchUp.promise)
        .mockResolvedValueOnce(progress(devices, { sub_a: { stage: "received" } }))
        .mockResolvedValueOnce(progress(devices, {}))
        .mockReturnValueOnce(new Promise(() => {}))
      const view = mount()

      await sendTest()
      vi.setSystemTime(Date.now() + SUSPENDED_MS)
      await flush(2_000)
      const superseded = get.mock.calls[1]![1]!.signal!
      await sendTest()
      lateCatchUp.resolve(progress(devices, { sub_a: { stage: "creation_failed" } }))
      await flush()
      const afterSupersede = rows()

      await sendTest()
      vi.setSystemTime(Date.now() + SUSPENDED_MS)
      await flush(2_000)
      const disabled = get.mock.calls[4]![1]!.signal!
      view.setSubscribed(false)
      await flush(30_000)

      expect({
        supersededAborted: superseded.aborted,
        afterSupersede,
        disabledAborted: disabled.aborted,
        polls: get.mock.calls.length,
      }).toEqual({
        supersededAborted: true,
        afterSupersede: ["Chrome on macOSAccepted by push serviceReceived by device"],
        disabledAborted: true,
        polls: 5,
      })
    })
  })

  describe("when the page resumes in the window's last seconds", () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]

    function timeouts(calls: ReadonlyArray<ReadonlyArray<unknown>>) {
      return calls.map((call) => (call[1] as { timeoutMs?: number } | undefined)?.timeoutMs)
    }

    /** Frozen after the first read; the pending 2 s poll timer fires at `resumeAt`. */
    async function resumeAt(ms: number) {
      vi.setSystemTime(Date.now() + ms - 2_000)
      await flush(2_000)
    }

    function answerAfter(ms: number, value: PushTestProgress) {
      return (_path: string, options?: { timeoutMs?: number }) =>
        new Promise<PushTestProgress>((resolve, reject) => {
          setTimeout(() => resolve(value), ms)
          setTimeout(() => reject(new Error("Request timed out")), options?.timeoutMs ?? Infinity)
        })
    }

    it("should give the resumed read a full budget and show a report that arrives after the deadline", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, {}))
        .mockImplementation(answerAfter(2_000, progress(devices, { sub_a: { stage: "notification_created" } })))
      mount()

      await sendTest()
      await resumeAt(59_000)
      await flush(2_000)
      const answered = rows()
      await flush(30_000)

      expect({
        answered,
        timeouts: timeouts(get.mock.calls),
        note: screen.queryByRole("status"),
      }).toEqual({
        answered: ["Chrome on macOSAccepted by push serviceNotification created"],
        timeouts: [5_000, 5_000],
        note: null,
      })
    })

    it("should keep polling to the deadline when the resumed read answers early without settling", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, {}))
        .mockResolvedValueOnce(progress(devices, { sub_a: { stage: "received" } }))
        .mockResolvedValue(progress(devices, { sub_a: { stage: "notification_created" } }))
      mount()

      await sendTest()
      await resumeAt(56_000)
      const resumed = rows()
      await flush(2_000)
      await flush(30_000)

      expect({ resumed, after: rows(), timeouts: timeouts(get.mock.calls) }).toEqual({
        resumed: ["Chrome on macOSAccepted by push serviceReceived by device"],
        after: ["Chrome on macOSAccepted by push serviceNotification created"],
        timeouts: [5_000, 5_000, 2_000],
      })
    })

    it("should not spend a second catch-up read when the page is suspended again", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, {}))
        .mockResolvedValue(progress(devices, { sub_a: { stage: "received" } }))
      mount()

      await sendTest()
      await resumeAt(56_000)
      vi.setSystemTime(Date.now() + 20_000)
      await flush(2_000)
      await flush(30_000)

      expect({ rows: rows(), polls: get.mock.calls.length }).toEqual({
        rows: ["Chrome on macOSAccepted by push serviceReceived, notification not confirmed"],
        polls: 2,
      })
    })

    it("should close as unchecked when the resumed read fails", async () => {
      vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
      const get = vi
        .spyOn(api, "get")
        .mockResolvedValueOnce(progress(devices, {}))
        .mockImplementation(answerAfter(10 * 60_000, progress(devices, {})))
      mount()

      await sendTest()
      await resumeAt(59_000)
      await flush(1_000)
      const atDeadline = rows()
      await flush(4_000)
      const closed = { rows: rows(), note: screen.getByRole("status").textContent }
      await flush(30_000)

      expect({ atDeadline, closed, timeouts: timeouts(get.mock.calls) }).toEqual({
        atDeadline: ["Chrome on macOSAccepted by push serviceWaiting for device report"],
        closed: {
          rows: ["Chrome on macOSAccepted by push serviceNot confirmed by device"],
          note: "Couldn't check device reports.",
        },
        timeouts: [5_000, 5_000],
      })
    })
  })

  it("should settle immediately when a device's worker cannot report", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    const get = vi.spyOn(api, "get").mockResolvedValue(progress(devices, { sub_a: { expected: false } }))
    mount()

    await sendTest()
    await flush(10_000)

    expect({ rows: rows(), polls: get.mock.calls.length }).toEqual({
      rows: ["Chrome on macOSAccepted by push serviceDevice report unavailable"],
      polls: 1,
    })
    expect(document.body.textContent).not.toMatch(/older version/i)
  })

  it("should show a recorded device stage even when the push service refused and the device was not expected to report", async () => {
    const devices = [device("sub_a", CHROME_MAC, "rejected")]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValue(progress(devices, { sub_a: { expected: false, stage: "notification_created" } }))
    mount()

    await sendTest()
    await flush(10_000)

    expect({ rows: rows(), polls: get.mock.calls.length }).toEqual({
      rows: ["Chrome on macOSRejected by push serviceNotification created"],
      polls: 1,
    })
  })

  it.each([
    ["a backend that predates receipts", undefined],
    ["a backend that could not keep the test's progress", null],
  ])("should show provider results only for %s", async (_label, progressField) => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    const response: PushTestResponse = { ...testResponse(devices), progress: progressField }
    if (progressField === undefined) delete response.progress
    vi.spyOn(api, "post").mockResolvedValue(response)
    const get = vi.spyOn(api, "get")
    mount()

    await sendTest()
    await flush(10_000)

    expect({ rows: rows(), note: screen.getByRole("status").textContent, polls: get.mock.calls.length }).toEqual({
      rows: ["Chrome on macOSAccepted by push service"],
      note: "Device reports aren't available for this test.",
      polls: 0,
    })
  })

  it("should show a failed check and recover on the next poll", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    vi.spyOn(api, "get")
      .mockRejectedValueOnce(new Error("Request timed out after 5000ms"))
      .mockResolvedValue(progress(devices, { sub_a: { stage: "notification_created" } }))
    mount()

    await sendTest()
    const duringFailure = { rows: rows(), note: screen.getByRole("status").textContent }
    await flush(2_000)

    expect({ duringFailure, rows: rows(), note: screen.queryByRole("status") }).toEqual({
      duringFailure: {
        rows: ["Chrome on macOSAccepted by push serviceWaiting for device report"],
        note: "Couldn't check device reports. Retrying…",
      },
      rows: ["Chrome on macOSAccepted by push serviceNotification created"],
      note: null,
    })
  })

  it("should not let a late report from a previous test overwrite the current one", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    const staleReport = deferred<PushTestProgress>()
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    vi.spyOn(api, "get")
      .mockReturnValueOnce(staleReport.promise)
      .mockResolvedValue(progress(devices, { sub_a: { stage: "received" } }))
    mount()

    await sendTest()
    await sendTest()
    staleReport.resolve(progress(devices, { sub_a: { stage: "creation_failed" } }))
    await flush()

    expect(rows()).toEqual(["Chrome on macOSAccepted by push serviceReceived by device"])
  })

  it("should stop polling when push is disabled or the workspace changes", async () => {
    const devices = [device("sub_a", CHROME_MAC, "accepted")]
    vi.spyOn(api, "post").mockResolvedValue(testResponse(devices))
    const get = vi.spyOn(api, "get").mockResolvedValue(progress(devices, {}))
    const view = mount()

    await sendTest()
    view.setSubscribed(false)
    const afterDisable = get.mock.calls.length
    await flush(10_000)
    const disabledPolls = get.mock.calls.length - afterDisable

    view.setSubscribed(true)
    await sendTest()
    fireEvent.click(screen.getByRole("link", { name: "Other workspace" }))
    const afterSwitch = get.mock.calls.length
    await flush(10_000)

    expect({ disabledPolls, switchedPolls: get.mock.calls.length - afterSwitch }).toEqual({
      disabledPolls: 0,
      switchedPolls: 0,
    })
  })
})
