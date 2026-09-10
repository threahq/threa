import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { StrictMode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { useNotificationAccountSwitch } from "./use-notification-account-switch"
import { ApiError } from "@/api/client"
import { accountsApi } from "@/api"
import * as accountScopeModule from "@/auth/account-scope"
import * as authModule from "@/auth"
import type { AccountScopeValue } from "@/auth/account-scope"
import { setNotificationIntent, takeNotificationIntent } from "@/lib/notification-intent"

const WS = "ws_deeplink"

const switchAccountMock = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
const loginMock = vi.fn<(redirectTo?: string) => void>()
let mockActiveId: string | null = "workos_A"

function installSpies() {
  vi.spyOn(accountScopeModule, "useAccountScope").mockImplementation(
    () =>
      ({
        activeWorkosUserId: mockActiveId,
        switchAccount: switchAccountMock,
        getDb: () => {
          throw new Error("not used")
        },
        getQueryClient: () => {
          throw new Error("not used")
        },
      }) satisfies AccountScopeValue
  )
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    login: loginMock,
  } as unknown as ReturnType<typeof authModule.useAuth>)
}

beforeEach(() => {
  mockActiveId = "workos_A"
  switchAccountMock.mockClear().mockResolvedValue(undefined)
  loginMock.mockReset()
  // Drain any intent a prior test stashed but did not consume.
  takeNotificationIntent(WS)
  installSpies()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useNotificationAccountSwitch", () => {
  it("resolves the parked owner and flips in place when the intent names a different account", async () => {
    setNotificationIntent(WS, "workos_B")
    const resolveSpy = vi.spyOn(accountsApi, "resolveIdentity").mockResolvedValue({ ownerUserId: "workos_B" })

    renderHook(() => useNotificationAccountSwitch(WS))

    await waitFor(() => expect(switchAccountMock).toHaveBeenCalledWith("workos_B", { landing: "keep-location" }))
    expect(resolveSpy).toHaveBeenCalledWith("workos_B", WS)
    expect(loginMock).not.toHaveBeenCalled()
  })

  it("switches on a notification click that lands in the workspace already on screen", async () => {
    // No remount: the click navigates within the mounted layout, so the intent
    // arrives after the hook's first read.
    const resolveSpy = vi.spyOn(accountsApi, "resolveIdentity").mockResolvedValue({ ownerUserId: "workos_B" })
    renderHook(() => useNotificationAccountSwitch(WS))
    expect(resolveSpy).not.toHaveBeenCalled()

    setNotificationIntent(WS, "workos_B")

    await waitFor(() => expect(switchAccountMock).toHaveBeenCalledWith("workos_B", { landing: "keep-location" }))
    expect(resolveSpy).toHaveBeenCalledWith("workos_B", WS)
  })

  it("does nothing when there is no pending intent", async () => {
    const resolveSpy = vi.spyOn(accountsApi, "resolveIdentity").mockResolvedValue({ ownerUserId: "workos_B" })

    renderHook(() => useNotificationAccountSwitch(WS))

    await Promise.resolve()
    expect(resolveSpy).not.toHaveBeenCalled()
    expect(switchAccountMock).not.toHaveBeenCalled()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it("does not resolve or switch when the intent already names the active account", async () => {
    setNotificationIntent(WS, "workos_A")
    const resolveSpy = vi.spyOn(accountsApi, "resolveIdentity").mockResolvedValue({ ownerUserId: "workos_A" })

    renderHook(() => useNotificationAccountSwitch(WS))

    await Promise.resolve()
    expect(resolveSpy).not.toHaveBeenCalled()
    expect(switchAccountMock).not.toHaveBeenCalled()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it("full re-auth back to the deep link when that account is not signed in here", async () => {
    setNotificationIntent(WS, "workos_B")
    vi.spyOn(accountsApi, "resolveIdentity").mockRejectedValue(
      new ApiError(404, "ACCOUNT_NOT_SIGNED_IN", "not signed in")
    )

    renderHook(() => useNotificationAccountSwitch(WS))

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith(`/w/${WS}`))
    expect(switchAccountMock).not.toHaveBeenCalled()
  })

  it("benign no-op on an ambiguous/unresolvable workspace (no switch, no login, no throw)", async () => {
    setNotificationIntent(WS, "workos_B")
    vi.spyOn(accountsApi, "resolveIdentity").mockRejectedValue(
      new ApiError(404, "WORKSPACE_NOT_RESOLVABLE", "ambiguous")
    )

    renderHook(() => useNotificationAccountSwitch(WS))

    await Promise.resolve()
    await Promise.resolve()
    expect(switchAccountMock).not.toHaveBeenCalled()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it("benign no-op on a network failure", async () => {
    setNotificationIntent(WS, "workos_B")
    vi.spyOn(accountsApi, "resolveIdentity").mockRejectedValue(new Error("network down"))

    renderHook(() => useNotificationAccountSwitch(WS))

    await Promise.resolve()
    await Promise.resolve()
    expect(switchAccountMock).not.toHaveBeenCalled()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it("drops a late resolve after unmount (ignore-flag cleanup)", async () => {
    setNotificationIntent(WS, "workos_B")
    let resolveLate: (v: { ownerUserId: string }) => void = () => {}
    const pending = new Promise<{ ownerUserId: string }>((r) => {
      resolveLate = r
    })
    vi.spyOn(accountsApi, "resolveIdentity").mockReturnValue(pending)

    const { unmount } = renderHook(() => useNotificationAccountSwitch(WS))
    unmount()
    resolveLate({ ownerUserId: "workos_B" })
    await pending
    await Promise.resolve()

    expect(switchAccountMock).not.toHaveBeenCalled()
    expect(loginMock).not.toHaveBeenCalled()
  })

  it("survives StrictMode's throwaway first mount (intent handed back, switch still fires)", async () => {
    setNotificationIntent(WS, "workos_B")
    const resolveSpy = vi.spyOn(accountsApi, "resolveIdentity").mockResolvedValue({ ownerUserId: "workos_B" })

    renderHook(() => useNotificationAccountSwitch(WS), { wrapper: StrictMode })

    await waitFor(() => expect(switchAccountMock).toHaveBeenCalledWith("workos_B", { landing: "keep-location" }))
    expect(resolveSpy).toHaveBeenCalledWith("workos_B", WS)
    expect(loginMock).not.toHaveBeenCalled()
  })
})
