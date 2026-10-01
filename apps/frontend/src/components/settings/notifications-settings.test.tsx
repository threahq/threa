import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Link, MemoryRouter, Route, Routes } from "react-router-dom"
import type { PushTestResponse } from "@threahq/types"
import { render, screen, userEvent, within } from "@/test"
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
