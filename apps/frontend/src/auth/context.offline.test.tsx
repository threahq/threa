import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, spyOnExport } from "@/test"
import { AuthProvider, useAuth } from "@/auth"
import * as dbModule from "@/db"
import { getActiveAccountId, getCachedIdentity, setActiveAccountId, setCachedIdentity } from "@/lib/cached-user"
import { getLastWorkspaceId, setLastWorkspaceId } from "@/lib/last-workspace"

const CACHED = { id: "user_1", email: "a@b.co", name: "Ada" }

function signedInAs(user: typeof CACHED) {
  setCachedIdentity(user)
  setActiveAccountId(user.id)
}

function Probe() {
  const auth = useAuth()
  return (
    <div>
      <span data-testid="user">{auth.user?.name ?? "none"}</span>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="error">{auth.error ?? "none"}</span>
    </div>
  )
}

describe("AuthProvider — offline-first identity", () => {
  beforeEach(() => {
    localStorage.clear()
    window.__eagerAuthPromise = undefined
    spyOnExport(dbModule, "clearAllCachedData").mockReturnValue((async () => {}) as typeof dbModule.clearAllCachedData)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it("renders instantly from the cached identity with no network gate", () => {
    signedInAs(CACHED)
    // Revalidation never resolves — the first paint must not wait on it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    )

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    expect(screen.getByTestId("user")).toHaveTextContent("Ada")
    expect(screen.getByTestId("loading")).toHaveTextContent("false")
  })

  it("keeps the cached user when background revalidation fails (stays usable offline)", async () => {
    signedInAs(CACHED)
    const fetchMock = vi.fn(async () => {
      throw new Error("network down")
    })
    vi.stubGlobal("fetch", fetchMock)

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByTestId("user")).toHaveTextContent("Ada")
      expect(screen.getByTestId("loading")).toHaveTextContent("false")
      expect(screen.getByTestId("error")).toHaveTextContent("none")
    })
    expect(getCachedIdentity(CACHED.id)).toEqual(CACHED)
  })

  it("clears the cached identity and drops the user on a 401", async () => {
    signedInAs(CACHED)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }) as unknown as Response)
    )

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("none"))
    expect(screen.getByTestId("loading")).toHaveTextContent("false")
    expect({ identity: getCachedIdentity(CACHED.id), active: getActiveAccountId() }).toEqual({
      identity: null,
      active: null,
    })
  })
})

describe("AuthProvider — logout clears local identity", () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    window.__eagerAuthPromise = undefined
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "" } as Location,
    })
    spyOnExport(dbModule, "clearAllCachedData").mockReturnValue((async () => {}) as typeof dbModule.clearAllCachedData)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
  })

  it("clears the cached user and last workspace on logout", async () => {
    signedInAs(CACHED)
    setLastWorkspaceId(CACHED.id, "ws_1")
    // Pending revalidation so the mount fetch can't clear state first — only
    // logout should.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    )

    let logout!: () => void
    function LogoutProbe() {
      logout = useAuth().logout
      return null
    }

    render(
      <AuthProvider>
        <LogoutProbe />
      </AuthProvider>
    )

    await act(async () => {
      logout()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(window.location.href).toBe("/api/auth/logout")
    expect({ identity: getCachedIdentity(CACHED.id), active: getActiveAccountId() }).toEqual({
      identity: null,
      active: null,
    })
    expect(getLastWorkspaceId(CACHED.id)).toBeNull()
  })
})
