import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test"
import { AuthProvider } from "@/auth"
import { AccountScopeProvider, useAccountScope, type AccountScopeValue } from "@/auth/account-scope"
import { hasSeededWorkspaceCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { addIncomingCall, getIncomingCalls } from "@/stores/incoming-call-store"
import type { CachedWorkspace } from "@/db"

// PR-4a headline test. Mounts the real AuthProvider + AccountScopeProvider
// (not the full App: that drags in socket.io, the router, and every route
// component, which are unrelated to PR-4a's logic and make the test brittle —
// INV-22). The data layers under test (per-account IndexedDB, QueryClient,
// module store caches) are exercised through their real implementations
// (INV-39).

const WORKSPACE: CachedWorkspace = {
  id: "workspace_A",
  name: "A workspace",
  slug: "a-workspace",
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  _cachedAt: Date.now(),
}

const QUERY_KEY = ["account-scope-test", "workspace_A"]

function meResponse(id: string): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ id, email: `${id}@example.com`, name: id }),
  } as unknown as Response
}

/** Stub /api/auth/me (account A until switched) and /api/accounts/switch. */
function installFetchStub() {
  let activeId = "workos_A"
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.endsWith("/api/accounts/switch")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { targetUserId: string }
      activeId = body.targetUserId
      return { status: 200, ok: true, json: async () => ({ activeUserId: activeId }) } as unknown as Response
    }
    if (url.endsWith("/api/auth/me")) {
      return meResponse(activeId)
    }
    return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
}

function mountScopeTree() {
  const handle: { current: AccountScopeValue | null } = { current: null }
  function Probe() {
    handle.current = useAccountScope()
    return null
  }
  const utils = render(
    <AuthProvider>
      <AccountScopeProvider>
        <Probe />
      </AccountScopeProvider>
    </AuthProvider>
  )
  return { handle, utils }
}

async function waitForActive(handle: { current: AccountScopeValue | null }, id: string) {
  await waitFor(() => {
    expect(handle.current?.activeWorkosUserId).toBe(id)
  })
}

describe("AccountScope", () => {
  const originalLocation = window.location
  let reloadSpy: ReturnType<typeof vi.fn>
  let hrefValues: string[]

  beforeEach(() => {
    installFetchStub()
    reloadSpy = vi.fn()
    hrefValues = []
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/",
        search: "",
        reload: reloadSpy,
        set href(v: string) {
          hrefValues.push(v)
        },
        get href() {
          return hrefValues[hrefValues.length - 1] ?? ""
        },
      } as unknown as Location,
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    // Await deletion so a not-yet-dropped DB never bleeds into the next test.
    await Promise.all(
      ["threa", "threa_workos_A", "threa_workos_B"].map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name)
            req.onsuccess = () => resolve()
            req.onerror = () => resolve()
            req.onblocked = () => resolve()
          })
      )
    )
  })

  it("isolates db, query cache, and stores across an in-place switch (no reload)", async () => {
    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    const scope = handle.current!
    const dbA = scope.getDb()
    const qcA = scope.getQueryClient()
    await dbA.workspaces.put(WORKSPACE)
    qcA.setQueryData(QUERY_KEY, { hello: "from-A" })
    seedWorkspaceCache("workspace_A", {
      workspace: WORKSPACE,
      users: [],
      streams: [],
      memberships: [],
      dmPeers: [],
      personas: [],
      bots: [],
      unreadState: {
        id: "workspace_A",
        workspaceId: "workspace_A",
        unreadCounts: {},
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        unreadActivities: [],
        mutedStreamIds: [],
        _cachedAt: Date.now(),
      },
      userPreferences: {
        id: "workspace_A",
        workspaceId: "workspace_A",
        userId: "user_A",
        theme: "system",
        sendMode: "enter",
        _cachedAt: Date.now(),
      },
      metadata: {
        id: "workspace_A",
        workspaceId: "workspace_A",
        emojis: [],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      },
    })
    expect(hasSeededWorkspaceCache("workspace_A")).toBe(true)

    // A live incoming-call ring must not survive an account switch — the store
    // is registered in flushModuleStoreCaches; this guards that registration.
    addIncomingCall({
      attemptId: "callinv_A",
      callId: "call_A",
      workspaceId: "workspace_A",
      streamId: "stream_A",
      inviterId: "user_A",
      inviterName: "A",
      mode: "video",
      expiresAtMs: Date.now() + 60_000,
    })
    expect(getIncomingCalls()).toHaveLength(1)

    await act(async () => {
      await scope.switchAccount("workos_B")
    })
    await waitForActive(handle, "workos_B")

    // No page reload / location navigation happened.
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(hrefValues).toEqual([])

    const scopeB = handle.current!
    expect(scopeB.activeWorkosUserId).toBe("workos_B")

    // Layer 1 — IndexedDB: B's db is empty; A's db is preserved (isolation,
    // not deletion); the two are physically distinct named databases.
    expect(await scopeB.getDb().workspaces.count()).toBe(0)
    expect(await dbA.workspaces.count()).toBe(1)
    expect(dbA.name).toBe("threa_workos_A")
    expect(scopeB.getDb().name).toBe("threa_workos_B")

    // Layer 2 — TanStack Query: B's client never sees A's cached entry.
    expect(scopeB.getQueryClient().getQueryData(QUERY_KEY)).toBeUndefined()
    expect(scopeB.getQueryClient()).not.toBe(qcA)

    // Layer 3 — module store cache: flushed on switch.
    expect(hasSeededWorkspaceCache("workspace_A")).toBe(false)
    expect(getIncomingCalls()).toHaveLength(0)
  })

  it("flips a second tab over BroadcastChannel and serves no cross-account data", async () => {
    const tab1 = mountScopeTree()
    const tab2 = mountScopeTree()
    await waitForActive(tab1.handle, "workos_A")
    await waitForActive(tab2.handle, "workos_A")

    const tab2QcA = tab2.handle.current!.getQueryClient()
    const cancelSpy = vi.spyOn(tab2QcA, "cancelQueries")
    const tab2DbA = tab2.handle.current!.getDb()
    await tab2DbA.workspaces.put(WORKSPACE)
    tab2QcA.setQueryData(QUERY_KEY, { hello: "from-A" })

    await act(async () => {
      await tab1.handle.current!.switchAccount("workos_B")
    })

    // Tab 2 receives the broadcast and flips without its own switch call.
    await waitForActive(tab2.handle, "workos_B")
    const tab2B = tab2.handle.current!
    expect(await tab2B.getDb().workspaces.count()).toBe(0)
    expect(tab2B.getQueryClient().getQueryData(QUERY_KEY)).toBeUndefined()
    expect(tab2B.getQueryClient()).not.toBe(tab2QcA)
    // The now-stale client had its in-flight queries cancelled.
    expect(cancelSpy).toHaveBeenCalled()
  })
})
