import type { ReactNode } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkspaceBootstrap } from "@threahq/types"
import { workspaceMembersApi } from "@/api/workspace-members"
import { db, type CachedWorkspaceUser } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useChangeWorkspaceMemberRole, useRemoveWorkspaceMember } from "./use-workspace-member-management"

const WS = "ws_members"
const OTHER_WS = "ws_partner"
const USER_ID = "usr_member"

function makeUser(role: "owner" | "admin" | "member", workspaceId = WS): CachedWorkspaceUser {
  return {
    id: USER_ID,
    workspaceId,
    workosUserId: "workos_1",
    email: "kris@example.com",
    role,
    slug: "kris",
    name: "Kris",
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
    joinedAt: "2026-01-01T00:00:00Z",
    _cachedAt: Date.now(),
  }
}

describe("useChangeWorkspaceMemberRole", () => {
  beforeEach(async () => {
    await db.workspaceUsers.clear()
  })

  it("patches both the IDB row and the cached bootstrap's user entry", async () => {
    await db.workspaceUsers.put(makeUser("member"))

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { _cachedAt, ...wireUser } = makeUser("member")
    queryClient.setQueryData(workspaceKeys.bootstrap(WS), { users: [wireUser] } as unknown as WorkspaceBootstrap)

    const changeRole = vi.spyOn(workspaceMembersApi, "changeRole").mockResolvedValue(undefined)

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useChangeWorkspaceMemberRole(WS), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ userId: USER_ID, roleSlug: "admin" })
    })

    await waitFor(async () => {
      expect((await db.workspaceUsers.get([WS, USER_ID]))?.role).toBe("admin")
    })
    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(WS))?.users).toEqual([
      { ...wireUser, role: "admin" },
    ])
    expect(changeRole).toHaveBeenCalledWith(WS, USER_ID, "admin")
  })
})

describe("workspace member management with the same user id in two workspaces", () => {
  const partnerUser = (): CachedWorkspaceUser => ({
    ...makeUser("owner", OTHER_WS),
    slug: "kris-partner",
    name: "Kris (partner)",
  })

  let queryClient: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const rowsByWorkspace = async () =>
    (await db.workspaceUsers.toArray()).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))

  beforeEach(async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await db.workspaceUsers.clear()
  })

  it("should change only the role of the workspace being managed when another workspace holds the same user id", async () => {
    const member = makeUser("member")
    const partner = partnerUser()
    await db.workspaceUsers.bulkPut([member, partner])
    vi.spyOn(workspaceMembersApi, "changeRole").mockResolvedValue(undefined)
    const { result } = renderHook(() => useChangeWorkspaceMemberRole(WS), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ userId: USER_ID, roleSlug: "admin" })
    })

    expect(await rowsByWorkspace()).toEqual([{ ...member, role: "admin", _cachedAt: expect.any(Number) }, partner])
  })

  it("should restore only the role of the workspace being managed when the change fails", async () => {
    const member = makeUser("member")
    const partner = partnerUser()
    await db.workspaceUsers.bulkPut([member, partner])
    vi.spyOn(workspaceMembersApi, "changeRole").mockRejectedValue(new Error("denied"))
    const { result } = renderHook(() => useChangeWorkspaceMemberRole(WS), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync({ userId: USER_ID, roleSlug: "admin" })).rejects.toThrow("denied")
    })

    await waitFor(async () => {
      expect(await rowsByWorkspace()).toEqual([{ ...member, _cachedAt: expect.any(Number) }, partner])
    })
  })

  it("should remove only the user of the workspace being managed when another workspace holds the same user id", async () => {
    const member = makeUser("member")
    const partner = partnerUser()
    await db.workspaceUsers.bulkPut([member, partner])
    vi.spyOn(workspaceMembersApi, "remove").mockResolvedValue(undefined)
    const { result } = renderHook(() => useRemoveWorkspaceMember(WS), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ userId: USER_ID })
    })

    expect(await rowsByWorkspace()).toEqual([partner])
  })

  it("should restore only the user of the workspace being managed when the removal fails", async () => {
    const member = makeUser("member")
    const partner = partnerUser()
    await db.workspaceUsers.bulkPut([member, partner])
    vi.spyOn(workspaceMembersApi, "remove").mockRejectedValue(new Error("denied"))
    const { result } = renderHook(() => useRemoveWorkspaceMember(WS), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync({ userId: USER_ID })).rejects.toThrow("denied")
    })

    await waitFor(async () => {
      expect(await rowsByWorkspace()).toEqual([member, partner])
    })
  })
})
