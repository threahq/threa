import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useState, type ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { Router } from "react-router-dom"
import { useResolveOrBounce } from "./use-resolve-or-bounce"
import { ApiError } from "@/api/client"
import { accountsApi } from "@/api"
import * as syncStatusModule from "@/sync/sync-status"
import * as accountScopeModule from "@/auth/account-scope"
import { clearAllLastWorkspaceIds, getLastWorkspaceId, setLastWorkspaceId } from "@/lib/last-workspace"
import type { AccountScopeValue } from "@/auth/account-scope"

const WS = "ws_deeplink"

// Navigation capture: `react-router-dom`'s ESM namespace is frozen and not
// spyable, so a bare <Router> with a custom navigator records every
// push/replace as `mockNavigate(path, { replace })` — the shape the hook
// passes to `useNavigate()` (mirrors message-input.test.tsx).
const mockNavigate = vi.fn()

function toPathString(to: { pathname: string; search?: string; hash?: string }): string {
  return `${to.pathname}${to.search ?? ""}${to.hash ?? ""}`
}

function Wrapper({ children }: { children: ReactNode }) {
  const [location] = useState(() => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }))
  const navigator = {
    createHref: (to: unknown) => (typeof to === "string" ? to : JSON.stringify(to)),
    encodeLocation: (to: unknown) =>
      typeof to === "string"
        ? { pathname: to, search: "", hash: "" }
        : (to as { pathname: string; search: string; hash: string }),
    push: (to: unknown) =>
      mockNavigate(typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string }), undefined),
    replace: (to: unknown) =>
      mockNavigate(typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string }), {
        replace: true,
      }),
    go: () => {},
    listen: () => () => {},
    block: () => () => {},
  }
  return (
    <Router
      location={location}
      navigator={navigator as unknown as Parameters<typeof Router>[0]["navigator"]}
      navigationType={"POP" as Parameters<typeof Router>[0]["navigationType"]}
    >
      {children}
    </Router>
  )
}

const switchAccountMock = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
let mockStatus: syncStatusModule.SyncStatus = "error"
let mockActiveId: string | null = "workos_A"

function installSpies() {
  vi.spyOn(syncStatusModule, "useSyncStatus").mockImplementation(() => mockStatus)
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
}

function syncEngine(error: unknown): { lastWorkspaceError: unknown } {
  return { lastWorkspaceError: error }
}

beforeEach(() => {
  mockStatus = "error"
  mockActiveId = "workos_A"
  switchAccountMock.mockClear().mockResolvedValue(undefined)
  mockNavigate.mockReset()
  clearAllLastWorkspaceIds()
  installSpies()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useResolveOrBounce", () => {
  it("flips in place when a different signed-in account owns the workspace", async () => {
    setLastWorkspaceId("workos_A", WS)
    const resolveSpy = vi.spyOn(accountsApi, "resolve").mockResolvedValue({ ownerUserId: "workos_B" })

    renderHook(() => useResolveOrBounce(WS, syncEngine(new ApiError(403, "FORBIDDEN", "no"))), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(switchAccountMock).toHaveBeenCalledWith("workos_B", { landing: "keep-location" }))
    expect(resolveSpy).toHaveBeenCalledWith(WS)
    // In-place flip: no route navigation, last-workspace stays pinned so a
    // reload lands back on this deep link under the owning account.
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(getLastWorkspaceId("workos_A")).toBe(WS)
  })

  it("bounces to the workspace list when nothing resolves (backend 404)", async () => {
    setLastWorkspaceId("workos_A", WS)
    vi.spyOn(accountsApi, "resolve").mockRejectedValue(new ApiError(404, "WORKSPACE_NOT_RESOLVABLE", "none"))

    renderHook(() => useResolveOrBounce(WS, syncEngine(new ApiError(404, "NOT_FOUND", "no"))), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/workspaces", { replace: true }))
    expect(switchAccountMock).not.toHaveBeenCalled()
    // Guarded clear fired because the pinned id matched the dead workspace.
    expect(getLastWorkspaceId("workos_A")).toBeNull()
  })

  it("bounce keeps a non-matching pinned last-workspace untouched", async () => {
    setLastWorkspaceId("workos_A", "ws_other")
    vi.spyOn(accountsApi, "resolve").mockRejectedValue(new ApiError(404, "WORKSPACE_NOT_RESOLVABLE", "none"))

    renderHook(() => useResolveOrBounce(WS, syncEngine(new ApiError(403, "FORBIDDEN", "no"))), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/workspaces", { replace: true }))
    expect(getLastWorkspaceId("workos_A")).toBe("ws_other")
  })

  it("bounces (no self-switch) when resolve returns the already-active account", async () => {
    vi.spyOn(accountsApi, "resolve").mockResolvedValue({ ownerUserId: "workos_A" })

    renderHook(() => useResolveOrBounce(WS, syncEngine(new ApiError(403, "FORBIDDEN", "no"))), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/workspaces", { replace: true }))
    expect(switchAccountMock).not.toHaveBeenCalled()
  })

  it("does not resolve when the error is not a terminal 403/404", async () => {
    const resolveSpy = vi.spyOn(accountsApi, "resolve").mockResolvedValue({ ownerUserId: "workos_B" })

    renderHook(() => useResolveOrBounce(WS, syncEngine(new ApiError(500, "INTERNAL", "boom"))), {
      wrapper: Wrapper,
    })

    await Promise.resolve()
    expect(resolveSpy).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(switchAccountMock).not.toHaveBeenCalled()
  })

  it("attempts resolve at most once while the status stays errored", async () => {
    const resolveSpy = vi
      .spyOn(accountsApi, "resolve")
      .mockRejectedValue(new ApiError(404, "WORKSPACE_NOT_RESOLVABLE", "none"))
    const engine = syncEngine(new ApiError(403, "FORBIDDEN", "no"))

    const { rerender } = renderHook(() => useResolveOrBounce(WS, engine), { wrapper: Wrapper })
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/workspaces", { replace: true }))

    // A transient flip away from "error" and back must not re-attempt resolve.
    mockStatus = "synced"
    rerender()
    mockStatus = "error"
    rerender()
    await Promise.resolve()

    expect(resolveSpy).toHaveBeenCalledTimes(1)
  })
})
