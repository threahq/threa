import type { ReactNode } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkspaceBootstrap } from "@threahq/types"
import { workspaceMembersApi } from "@/api/workspace-members"
import { db, type CachedWorkspaceUser } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useChangeWorkspaceMemberRole } from "./use-workspace-member-management"

const WS = "ws_members"
const USER_ID = "usr_member"

function makeUser(role: "owner" | "admin" | "member"): CachedWorkspaceUser {
  return {
    id: USER_ID,
    workspaceId: WS,
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
      expect((await db.workspaceUsers.get(USER_ID))?.role).toBe("admin")
    })
    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(WS))?.users).toEqual([
      { ...wireUser, role: "admin" },
    ])
    expect(changeRole).toHaveBeenCalledWith(WS, USER_ID, "admin")
  })
})
