import { useEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test"
import { AuthProvider, useAuth } from "@/auth"
import { AccountScopeProvider, useAccountScope, type AccountScopeValue } from "@/auth/account-scope"
import { setLastWorkspaceId } from "@/lib/last-workspace"
import { runAccountOwnedWork } from "@/sync/account-fence"
import { reportAccountMismatch } from "@/api/account-assertion"
import { hasSeededWorkspaceCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { addIncomingCall, getIncomingCalls } from "@/stores/incoming-call-store"
import { getFloatingSurfaceGeometry, publishFloatingSurfaceGeometry } from "@/stores/floating-surface-geometry-store"
import { accountDbName, getActiveDb, type CachedWorkspace } from "@/db"
import { setStorageAccount } from "@/lib/account-storage"
import { TEST_STORAGE_ACCOUNT } from "@/test/setup"
import { readStagedDraft, stageDraftContent } from "@/lib/drafts/draft-staging"
import { openCompose, useComposeOverlay } from "@/stores/compose-overlay-store"

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

/**
 * `/api/auth/me` that hangs until released, with `/api/accounts/switch` still
 * answering — the window between a switch committing server-side and identity
 * revalidation returning.
 */
function stallRevalidation() {
  let settle!: (value: Response) => void
  const pending = new Promise<Response>((resolve) => {
    settle = resolve
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.endsWith("/api/auth/me")) return pending
    const body = JSON.parse(String(init?.body ?? "{}")) as { targetUserId: string }
    return { status: 200, ok: true, json: async () => ({ activeUserId: body.targetUserId }) } as unknown as Response
  })
  return {
    fetchMock,
    release: async (id: string) => {
      settle(meResponse(id))
      await pending
    },
  }
}

// Landing paths requested by the provider, in order. The real router is not
// mounted here, so the injected navigation records instead of navigating.
const landings: string[] = []

interface MountOptions {
  /** Mounted inside the keyed per-account subtree, alongside the probe. */
  children?: ReactNode
  landAt?: (path: string) => void | Promise<unknown>
}

function mountScopeTree(opts?: MountOptions) {
  const handle: { current: AccountScopeValue | null } = { current: null }
  const identity: { current: { id: string; email: string; name: string } | null | undefined } = { current: undefined }
  function Probe() {
    handle.current = useAccountScope()
    identity.current = useAuth().user
    return null
  }
  const landAt = opts?.landAt ?? ((path: string) => void landings.push(path))
  const utils = render(
    <AuthProvider>
      <AccountScopeProvider landAt={landAt}>
        <Probe />
        {opts?.children}
      </AccountScopeProvider>
    </AuthProvider>
  )
  return { handle, identity, utils }
}

async function waitForActive(handle: { current: AccountScopeValue | null }, id: string) {
  await waitFor(() => {
    expect(handle.current?.activeWorkosUserId).toBe(id)
  })
}

/** `/api/accounts/switch` refuses; identity revalidation keeps naming account A. */
function failSwitch(status = 500) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.endsWith("/api/auth/me")) return meResponse("workos_A")
    return { status, ok: false, json: async () => ({}) } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

/**
 * A stand-in for the real queue processors (outbox drain, operation queue):
 * kicked from a mount effect, running under the account fence, exiting the
 * moment its account is retired and leaving its rows pending.
 */
function makeQueueProcessor() {
  const drained: string[] = []
  const pending = ["m1", "m2"]
  let mounts = 0
  let opened = false
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    open = () => {
      opened = true
      resolve()
    }
  })

  function QueueProcessor() {
    useEffect(() => {
      mounts += 1
      void runAccountOwnedWork(async (fence) => {
        while (pending.length > 0) {
          if (!opened) await gate
          if (fence.isRetired()) return
          drained.push(pending.shift()!)
        }
      })
    }, [])
    return null
  }

  return { QueueProcessor, drained, mounts: () => mounts, open: () => open() }
}

describe("AccountScope", () => {
  const originalLocation = window.location
  let reloadSpy: ReturnType<typeof vi.fn>
  let hrefValues: string[]

  beforeEach(() => {
    localStorage.clear()
    landings.length = 0
    window.__eagerAuthPromise = undefined
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
    setStorageAccount(TEST_STORAGE_ACCOUNT)
    localStorage.clear()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    // Await deletion so a not-yet-dropped DB never bleeds into the next test.
    await Promise.all(
      ["threa", accountDbName("workos_A"), accountDbName("workos_B")].map(
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

  it("should replace a stale landing when authoritative revalidation changes the account", async () => {
    setLastWorkspaceId("workos_A", "ws_a")
    setLastWorkspaceId("workos_B", "ws_b")
    const landAt = vi.fn((path: string) => (path === "/w/ws_b" ? new Promise<void>(() => {}) : undefined))
    const { handle, utils } = mountScopeTree({ landAt, children: <span data-testid="active-subtree">Ready</span> })
    await waitForActive(handle, "workos_A")
    await act(async () => {
      await handle.current!.switchAccount("workos_B")
    })
    await waitFor(() => expect(landAt).toHaveBeenCalledWith("/w/ws_b"))
    expect(utils.queryByTestId("active-subtree")).toBeNull()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => meResponse("workos_A"))
    )
    await act(async () => {
      reportAccountMismatch()
    })
    await waitFor(() => expect(utils.getByTestId("active-subtree")).toBeVisible())
    expect(landAt.mock.calls).toEqual([["/w/ws_b"], ["/w/ws_a"]])
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

    // Same for the floating call surface's published geometry: it outlives the
    // remount, so a stale square would keep displacing B's rings.
    publishFloatingSurfaceGeometry({
      rect: { x: 676, y: 440, width: 340, height: 320 },
      protectedRects: [{ x: 684, y: 700, width: 324, height: 44 }],
    })
    expect(getFloatingSurfaceGeometry()).not.toBeNull()

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
    expect(dbA.name).toBe(accountDbName("workos_A"))
    expect(scopeB.getDb().name).toBe(accountDbName("workos_B"))

    // Layer 2 — TanStack Query: B's client never sees A's cached entry.
    expect(scopeB.getQueryClient().getQueryData(QUERY_KEY)).toBeUndefined()
    expect(scopeB.getQueryClient()).not.toBe(qcA)

    // Layer 3 — module store cache: flushed on switch.
    expect(hasSeededWorkspaceCache("workspace_A")).toBe(false)
    expect(getIncomingCalls()).toHaveLength(0)
    expect(getFloatingSurfaceGeometry()).toBeNull()
  })

  it("should move account-owned local storage with the scope, and back", async () => {
    // The composer's crash-safe buffer holds plaintext the user typed. It has to
    // follow the account, not the tab: the pre-fix build staged A's body under a
    // key B's startup reconcile then read, recovered into B's database and
    // queued for push as B's draft.
    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A typed this" }] }] }
    stageDraftContent("workspace_A", "stream_shared", body)

    await act(async () => {
      await handle.current!.switchAccount("workos_B")
    })
    await waitForActive(handle, "workos_B")

    expect(readStagedDraft("workspace_A", "stream_shared")).toBeNull()

    await act(async () => {
      await handle.current!.switchAccount("workos_A")
    })
    await waitForActive(handle, "workos_A")
    expect(readStagedDraft("workspace_A", "stream_shared")?.contentJson).toEqual(body)
  })

  it("moves the display identity with the scope, before the cookie catches up", async () => {
    // The switcher already holds the destination's identity from
    // `/api/accounts`, so the flip publishes it immediately. Without a single
    // identity owner the scope moved to B while `useAuth()` kept serving A —
    // every consumer keyed on the viewer (message authorship, per-user storage,
    // "you" badges) attributed B's session to A.
    const { handle, identity } = mountScopeTree()
    await waitForActive(handle, "workos_A")
    expect(identity.current?.id).toBe("workos_A")

    // Revalidation stalls, so what the UI shows is the switcher's identity —
    // not a value the flip happened to race a round trip for.
    const { fetchMock, release } = stallRevalidation()
    vi.stubGlobal("fetch", fetchMock)

    await act(async () => {
      await handle.current!.switchAccount("workos_B", {
        identity: { id: "workos_B", email: "b@example.com", name: "Bea" },
      })
    })
    await waitForActive(handle, "workos_B")

    expect(identity.current).toEqual({ id: "workos_B", email: "b@example.com", name: "Bea" })

    await act(async () => {
      await release("workos_B")
    })
    await waitFor(() => expect(identity.current?.email).toBe("workos_B@example.com"))
  })

  it("leaves the identity unresolved rather than showing the outgoing account", async () => {
    // A cross-tab flip carries no identity hint and this browser has never
    // cached B's. Unresolved (and so `loading`, which gates sending) is the only
    // honest answer; A's name is not a placeholder for B.
    const { handle, identity } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    const { fetchMock, release } = stallRevalidation()
    vi.stubGlobal("fetch", fetchMock)

    await act(async () => {
      await handle.current!.switchAccount("workos_B")
    })
    await waitForActive(handle, "workos_B")
    expect(identity.current).toBeNull()

    await act(async () => {
      await release("workos_B")
    })
    await waitFor(() => expect(identity.current?.id).toBe("workos_B"))
  })

  it("lands an explicit switch on the destination's own workspace, never the outgoing account's", async () => {
    setLastWorkspaceId("workos_B", "ws_b")
    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    await act(async () => {
      await handle.current!.switchAccount("workos_B")
    })
    await waitForActive(handle, "workos_B")

    expect(landings).toEqual(["/w/ws_b"])
  })

  it("lands on the workspace list when the destination has no workspace on this browser", async () => {
    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    await act(async () => {
      await handle.current!.switchAccount("workos_B")
    })
    await waitForActive(handle, "workos_B")

    expect(landings).toEqual(["/workspaces"])
  })

  it("keeps the location for a deep link the destination account was sent to", async () => {
    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    await act(async () => {
      await handle.current!.switchAccount("workos_B", { landing: "keep-location" })
    })
    await waitForActive(handle, "workos_B")

    expect(landings).toEqual([])
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
    // Including its display identity: a tab that missed the switch must not go
    // on rendering the outgoing account as the viewer.
    await waitFor(() => expect(tab2.identity.current?.id).toBe("workos_B"))
    const tab2B = tab2.handle.current!
    expect(await tab2B.getDb().workspaces.count()).toBe(0)
    expect(tab2B.getQueryClient().getQueryData(QUERY_KEY)).toBeUndefined()
    expect(tab2B.getQueryClient()).not.toBe(tab2QcA)
    // The now-stale client had its in-flight queries cancelled.
    expect(cancelSpy).toHaveBeenCalled()
  })

  it("should let the outgoing account's queued work settle before its credential moves", async () => {
    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    const steps: string[] = []
    let releaseSend: () => void = () => {}
    const queued = runAccountOwnedWork(async (fence) => {
      await new Promise<void>((resolve) => {
        releaseSend = resolve
      })
      steps.push(fence.isRetired() ? "queued work stopped" : "queued work continued")
    })

    let switched = false
    const switching = handle.current!.switchAccount("workos_B").then(() => {
      switched = true
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The credential has not moved yet: the outgoing account's send is still
    // on the wire and the switch is waiting for it.
    const switchCalls = () =>
      vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/accounts/switch")).length
    expect({ switchCalls: switchCalls(), switched }).toEqual({ switchCalls: 0, switched: false })

    await act(async () => {
      releaseSend()
      await queued
      await switching
    })

    expect(steps).toEqual(["queued work stopped"])
    expect(switchCalls()).toBe(1)
    await waitForActive(handle, "workos_B")
  })

  it("should retire the outgoing account when a revalidation reveals the browser moved on without this tab", async () => {
    // A tab suspended through another tab's switch: no broadcast reached it,
    // and it only learns from a refused request. The lifecycle must be the
    // same one an explicit switch runs — not a bare identity swap that leaves
    // the previous account's module snapshots in place.
    let activeId = "workos_A"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith("/api/auth/me")) return meResponse(activeId)
        return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
      })
    )

    const { handle } = mountScopeTree()
    await waitForActive(handle, "workos_A")

    const qcA = handle.current!.getQueryClient()
    const cancelSpy = vi.spyOn(qcA, "cancelQueries")
    qcA.setQueryData(QUERY_KEY, { hello: "from-A" })
    await handle.current!.getDb().workspaces.put(WORKSPACE)
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

    activeId = "workos_B"
    await act(async () => {
      reportAccountMismatch()
      await Promise.resolve()
    })
    await waitForActive(handle, "workos_B")

    const scopeB = handle.current!
    expect(await scopeB.getDb().workspaces.count()).toBe(0)
    expect(scopeB.getQueryClient().getQueryData(QUERY_KEY)).toBeUndefined()
    expect(getIncomingCalls()).toHaveLength(0)
    expect(cancelSpy).toHaveBeenCalled()
  })

  it("should notify module-store subscribers after commit, never mid-render", async () => {
    // `flushModuleStoreCaches` emits to real `useSyncExternalStore` subscribers.
    // Run from the provider's render pass, those emits schedule updates on
    // components React is already rendering — a render-phase update, and an
    // inconsistent snapshot for anything reading the store on the same pass.
    const overlayOpen: boolean[] = []
    function OverlaySubscriber() {
      overlayOpen.push(useComposeOverlay().open)
      return null
    }
    const handle: { current: AccountScopeValue | null } = { current: null }
    function Probe() {
      handle.current = useAccountScope()
      return null
    }

    const consoleErrors: string[] = []
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(" "))
    })

    try {
      render(
        <>
          <OverlaySubscriber />
          <AuthProvider>
            <AccountScopeProvider landAt={(path) => void landings.push(path)}>
              <Probe />
            </AccountScopeProvider>
          </AuthProvider>
        </>
      )
      await waitForActive(handle, "workos_A")

      await act(async () => {
        openCompose("stream_A")
      })
      expect(overlayOpen.at(-1)).toBe(true)

      await act(async () => {
        await handle.current!.switchAccount("workos_B")
      })
      await waitForActive(handle, "workos_B")
    } finally {
      errorSpy.mockRestore()
    }

    // The subscriber really is wired to the reset (so a silent listener can't
    // pass this), and React never saw an update scheduled during a render.
    expect({
      overlayAfterSwitch: overlayOpen.at(-1),
      renderPhaseWarnings: consoleErrors.filter((e) => e.includes("while rendering a different component")),
    }).toEqual({ overlayAfterSwitch: false, renderPhaseWarnings: [] })
  })

  it("should restart the retired account's processors when the switch itself fails", async () => {
    // The retirement runs before the request, so a refused switch leaves the
    // account it never left with stopped processors and rows still pending —
    // and nothing scheduled to kick them.
    const proc = makeQueueProcessor()
    const { handle } = mountScopeTree({ children: <proc.QueueProcessor /> })
    await waitForActive(handle, "workos_A")
    const mountsBefore = proc.mounts()
    expect(proc.drained).toEqual([])

    failSwitch()
    let failure: unknown = null
    await act(async () => {
      const switching = handle.current!.switchAccount("workos_B").catch((e: unknown) => {
        failure = e
      })
      // The epoch is already raised; let the parked drain observe it and exit.
      proc.open()
      await switching
    })

    await waitFor(() => expect(proc.drained).toEqual(["m1", "m2"]))
    expect({
      active: handle.current?.activeWorkosUserId,
      error: String(failure),
      // Restarted by remounting the same account, not by rewinding the epoch.
      remounts: proc.mounts() - mountsBefore,
    }).toEqual({ active: "workos_A", error: "Error: Account switch failed (500)", remounts: 1 })
  })

  it("should leave a newer retirement alone when a stale switch attempt fails", async () => {
    // Another tab flips this browser to C while this tab's switch to B is still
    // on the wire. When B's request finally fails, its retirement is no longer
    // the one in force: C is mounted and running, and a resume from the stale
    // attempt would tear C's subtree down for nothing.
    let rejectSwitch: (reason: Error) => void = () => {}
    let sessionId = "workos_A"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/auth/me")) return meResponse(sessionId)
        return new Promise<Response>((_resolve, reject) => {
          rejectSwitch = reject
        })
      })
    )

    let mounts = 0
    function MountCounter() {
      useEffect(() => {
        mounts += 1
      }, [])
      return null
    }
    const { handle } = mountScopeTree({ children: <MountCounter /> })
    await waitForActive(handle, "workos_A")
    const mountsBefore = mounts

    let failure: unknown = null
    const switching = handle.current!.switchAccount("workos_B").catch((e: unknown) => {
      failure = e
    })

    const otherTab = new BroadcastChannel("threa-auth")
    sessionId = "workos_C"
    await act(async () => {
      otherTab.postMessage({ type: "switched", activeWorkosUserId: "workos_C" })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    otherTab.close()
    await waitForActive(handle, "workos_C")
    const mountsAfterAdoption = mounts

    await act(async () => {
      rejectSwitch(new Error("network down"))
      await switching
    })

    expect({
      active: handle.current?.activeWorkosUserId,
      error: String(failure),
      adoptionRemounts: mountsAfterAdoption - mountsBefore,
      // The stale attempt is not the retirement in force: C keeps running.
      staleAttemptRemounts: mounts - mountsAfterAdoption,
    }).toEqual({ active: "workos_C", error: "Error: network down", adoptionRemounts: 1, staleAttemptRemounts: 0 })
  })

  it("should surface a landing that never settles instead of revealing the wrong URL", async () => {
    let settleLanding: (() => void) | null = null
    const landAt = vi.fn((path: string) => {
      landings.push(path)
      return new Promise<void>((resolve) => {
        settleLanding = resolve
      })
    })
    const { handle } = mountScopeTree({ landAt })
    await waitForActive(handle, "workos_A")

    // Fake timers only from here: the landing's timeout is armed by the switch.
    vi.useFakeTimers()
    try {
      await act(async () => {
        await handle.current!.switchAccount("workos_B")
      })
      expect(screen.queryByText("Couldn't open this account")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      // The account is right, the URL is not: say so rather than revealing the
      // outgoing account's location under the new account.
      expect(screen.getByText("Couldn't open this account")).toBeInTheDocument()
      expect(handle.current?.activeWorkosUserId).toBe("workos_A")

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }))
      })
      await act(async () => {
        settleLanding?.()
        await vi.advanceTimersByTimeAsync(0)
      })

      expect({
        landingCalls: landAt.mock.calls.map(([path]) => path),
        active: handle.current?.activeWorkosUserId,
        errorShown: screen.queryByText("Couldn't open this account"),
      }).toEqual({ landingCalls: ["/workspaces", "/workspaces"], active: "workos_B", errorShown: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it("should let the outgoing subtree's teardown write to its own database", async () => {
    // Unmount cleanups run under whatever the `db` proxy points at when they
    // fire. Moving the pointer while the outgoing subtree was still mounted put
    // its last writes — read state, draft flushes, upload bookkeeping — into the
    // account that replaced it. The handover drops the subtree first, so the
    // pointer only moves once there is nothing left to write.
    let teardownDbName: string | null = null
    function Departing() {
      useEffect(() => {
        return () => {
          teardownDbName = getActiveDb().name
        }
      }, [])
      return null
    }

    const { handle } = mountScopeTree({ children: <Departing /> })
    await waitForActive(handle, "workos_A")
    teardownDbName = null

    await act(async () => {
      await handle.current!.switchAccount("workos_B")
    })
    await waitForActive(handle, "workos_B")

    expect(teardownDbName).toBe(accountDbName("workos_A"))
  })
})
