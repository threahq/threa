import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { useSyncExternalStore } from "react"
import { db, type CachedWorkspaceUser } from "@/db"
import * as perfCapture from "@/lib/perf/capture"
import { resetWorkspaceStoreCache, useWorkspaceUsers } from "./workspace-store"
import {
  activeWorkspaceSubscriptionCount,
  getWorkspaceTableRow,
  getWorkspaceTableSnapshot,
  resetWorkspaceTableRegistry,
  subscribeWorkspaceTable,
  subscribeWorkspaceTableRow,
} from "./workspace-table-registry"

const WORKSPACE = "workspace_1"
const OTHER_WORKSPACE = "workspace_2"

function makeUser(id: string, overrides: Partial<CachedWorkspaceUser> = {}): CachedWorkspaceUser {
  return {
    id,
    workspaceId: WORKSPACE,
    workosUserId: `workos_${id}`,
    email: `${id}@example.com`,
    role: "member",
    slug: id,
    name: id,
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: "2026-03-01T10:00:00Z",
    _cachedAt: 1,
    ...overrides,
  }
}

function ManyConsumers({ count }: { count: number }) {
  const rows: CachedWorkspaceUser[][] = []
  for (let i = 0; i < count; i++) {
    rows.push(useWorkspaceUsers(WORKSPACE))
  }
  return <div data-testid="rows">{rows[0].length}</div>
}

function useRegistryRows(workspaceId: string): CachedWorkspaceUser[] | undefined {
  return useSyncExternalStore(
    (listener) => subscribeWorkspaceTable(workspaceId, "users", listener),
    () => getWorkspaceTableSnapshot(workspaceId, "users"),
    () => getWorkspaceTableSnapshot(workspaceId, "users")
  )
}

describe("workspace table registry", () => {
  beforeEach(async () => {
    resetWorkspaceTableRegistry()
    resetWorkspaceStoreCache()
    await db.workspaceUsers.clear()
  })

  afterEach(() => {
    resetWorkspaceTableRegistry()
    vi.restoreAllMocks()
  })

  it("twenty consumers of useWorkspaceUsers open one IDB read", async () => {
    await db.workspaceUsers.bulkPut([makeUser("user_1"), makeUser("user_2")])
    const where = vi.spyOn(db.workspaceUsers, "where")

    const { findByText } = render(<ManyConsumers count={20} />)
    await findByText("2")

    expect(where).toHaveBeenCalledTimes(1)
    expect(activeWorkspaceSubscriptionCount()).toBe(1)
  })

  it("an unchanged row keeps its object identity across emissions", async () => {
    await db.workspaceUsers.put(makeUser("user_1"))
    const { result } = renderHook(() => useRegistryRows(WORKSPACE))
    await waitFor(() => expect(result.current).toHaveLength(1))
    const first = result.current![0]

    await act(async () => {
      await db.workspaceUsers.put(makeUser("user_2"))
    })
    await waitFor(() => expect(result.current).toHaveLength(2))

    expect(result.current!.find((row) => row.id === "user_1")).toBe(first)
  })

  it("a change to one row does not re-render a consumer reading another row", async () => {
    await db.workspaceUsers.bulkPut([makeUser("user_1"), makeUser("user_2")])
    const renders = { user_1: 0, user_2: 0 }

    function RowProbe({ rowId }: { rowId: "user_1" | "user_2" }) {
      const row = useSyncExternalStore(
        (listener) => subscribeWorkspaceTableRow(WORKSPACE, "users", rowId, listener),
        () => getWorkspaceTableRow(WORKSPACE, "users", rowId),
        () => getWorkspaceTableRow(WORKSPACE, "users", rowId)
      )
      renders[rowId] += 1
      return <span data-testid={rowId}>{row?.name ?? "-"}</span>
    }

    const { findByText } = render(
      <>
        <RowProbe rowId="user_1" />
        <RowProbe rowId="user_2" />
      </>
    )
    await findByText("user_1")
    const before = { ...renders }

    await act(async () => {
      await db.workspaceUsers.put(makeUser("user_2", { name: "Renamed" }))
    })
    await findByText("Renamed")

    expect({
      user_1: renders.user_1 - before.user_1,
      user_2: renders.user_2 - before.user_2 > 0,
    }).toEqual({ user_1: 0, user_2: true })
  })

  it("the last unsubscribe tears the query down after the grace window, and a re-subscribe inside it reuses the entry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await db.workspaceUsers.put(makeUser("user_1"))
      const noop = () => {}
      const unsubscribe = subscribeWorkspaceTable(WORKSPACE, "users", noop)
      await vi.waitFor(() => expect(getWorkspaceTableSnapshot(WORKSPACE, "users")).toHaveLength(1))

      unsubscribe()
      expect(activeWorkspaceSubscriptionCount()).toBe(1)

      const again = subscribeWorkspaceTable(WORKSPACE, "users", noop)
      expect(getWorkspaceTableSnapshot(WORKSPACE, "users")).toHaveLength(1)
      expect(activeWorkspaceSubscriptionCount()).toBe(1)

      again()
      await act(async () => {
        vi.advanceTimersByTime(6_000)
      })
      expect(activeWorkspaceSubscriptionCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a subscriber that mounts after the first emission gets the current snapshot synchronously", async () => {
    await db.workspaceUsers.put(makeUser("user_1"))
    const { result } = renderHook(() => useRegistryRows(WORKSPACE))
    await waitFor(() => expect(result.current).toHaveLength(1))

    const seen: (number | undefined)[] = []
    function LateConsumer() {
      const rows = useWorkspaceUsers(WORKSPACE)
      seen.push(rows.length)
      return null
    }
    render(<LateConsumer />)

    expect(seen[0]).toBe(1)
  })

  it("switching workspaces does not leak the previous workspace's rows", async () => {
    await db.workspaceUsers.bulkPut([makeUser("user_1"), makeUser("user_other", { workspaceId: OTHER_WORKSPACE })])

    const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceUsers(workspaceId), {
      initialProps: { workspaceId: WORKSPACE },
    })
    await waitFor(() => expect(result.current.map((row) => row.id)).toEqual(["user_1"]))

    rerender({ workspaceId: OTHER_WORKSPACE })
    await waitFor(() => expect(result.current.map((row) => row.id)).toEqual(["user_other"]))
  })

  it("the subscription-count mark tracks entry lifecycle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const mark = vi.fn()
      vi.spyOn(perfCapture, "getPerfCapture").mockReturnValue({
        mark,
        measure: () => {},
        flush: async () => {},
      } as unknown as ReturnType<typeof perfCapture.getPerfCapture>)

      await db.workspaceUsers.put(makeUser("user_1"))

      const { findByText, unmount } = render(<ManyConsumers count={3} />)
      await findByText("1")
      const afterMount = mark.mock.calls.filter(([name]) => name === "store.tableSubscriptions").pop()

      unmount()
      await act(async () => {
        vi.advanceTimersByTime(6_000)
      })
      const afterUnmount = mark.mock.calls.filter(([name]) => name === "store.tableSubscriptions").pop()

      expect({ afterMount: afterMount?.[1], afterUnmount: afterUnmount?.[1] }).toEqual({
        afterMount: 1,
        afterUnmount: 0,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
