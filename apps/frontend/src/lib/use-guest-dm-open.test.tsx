import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  GUEST_DM_POLICIES,
  WORKSPACE_ROLE_SLUGS,
  type GuestDmPolicy,
  type User,
  type WorkspaceBootstrap,
} from "@threahq/types"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useGuestDmOpen } from "./use-guest-dm-open"

const WORKSPACE_ID = "ws_1"
const users = [
  { id: "usr_member", role: WORKSPACE_ROLE_SLUGS.MEMBER },
  { id: "usr_member_2", role: WORKSPACE_ROLE_SLUGS.MEMBER },
  { id: "usr_admin", role: WORKSPACE_ROLE_SLUGS.ADMIN },
  { id: "usr_guest", role: WORKSPACE_ROLE_SLUGS.GUEST },
] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>

function openWith(seedBootstrap: (queryClient: QueryClient) => void, viewerId: string | null, peerId: string) {
  const queryClient = new QueryClient()
  seedBootstrap(queryClient)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(users)
  vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(viewerId ? ({ id: viewerId } as User) : null)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useGuestDmOpen(WORKSPACE_ID), { wrapper }).result.current([peerId])
}

function seedPolicy(policy: GuestDmPolicy | null) {
  return (queryClient: QueryClient) =>
    queryClient.setQueryData(workspaceKeys.bootstrap(WORKSPACE_ID), {
      workspaceSettings: policy ? { guestDmPolicy: policy } : undefined,
    } as WorkspaceBootstrap)
}

function open(policy: GuestDmPolicy | null, viewerId: string, peerId: string) {
  return openWith(seedPolicy(policy), viewerId, peerId)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useGuestDmOpen", () => {
  it("should open or close a DM by the bootstrap policy and by who the viewer and peer are", () => {
    const outcomes = (policy: GuestDmPolicy | null) => ({
      memberMember: open(policy, "usr_member", "usr_member_2"),
      memberAdmin: open(policy, "usr_member", "usr_admin"),
      memberGuest: open(policy, "usr_member", "usr_guest"),
      adminGuest: open(policy, "usr_admin", "usr_guest"),
      guestMember: open(policy, "usr_guest", "usr_member"),
      guestBot: open(policy, "usr_guest", "bot_1"),
      memberBot: open(policy, "usr_member", "bot_1"),
    })

    expect({
      off: outcomes(GUEST_DM_POLICIES.OFF),
      admins: outcomes(GUEST_DM_POLICIES.ADMINS),
      open: outcomes(GUEST_DM_POLICIES.OPEN),
      beforeBootstrap: outcomes(null),
    }).toEqual({
      off: {
        memberMember: true,
        memberAdmin: true,
        memberGuest: false,
        adminGuest: false,
        guestMember: false,
        guestBot: false,
        memberBot: true,
      },
      admins: {
        memberMember: true,
        memberAdmin: true,
        memberGuest: false,
        adminGuest: true,
        guestMember: false,
        guestBot: false,
        memberBot: true,
      },
      open: {
        memberMember: true,
        memberAdmin: true,
        memberGuest: true,
        adminGuest: true,
        guestMember: true,
        guestBot: true,
        memberBot: true,
      },
      beforeBootstrap: {
        memberMember: true,
        memberAdmin: true,
        memberGuest: false,
        adminGuest: false,
        guestMember: false,
        guestBot: false,
        memberBot: true,
      },
    })
  })

  it("should close a pair with a guest and keep a member pair open when the bootstrap is not cached", () => {
    const noBootstrap = () => undefined

    expect({
      memberMember: openWith(noBootstrap, "usr_member", "usr_member_2"),
      memberGuest: openWith(noBootstrap, "usr_member", "usr_guest"),
      adminGuest: openWith(noBootstrap, "usr_admin", "usr_guest"),
    }).toEqual({ memberMember: true, memberGuest: false, adminGuest: false })
  })

  it("should close a pair with a guest peer when the viewer has not resolved, even under admins", () => {
    const admins = seedPolicy(GUEST_DM_POLICIES.ADMINS)

    expect({
      memberPeer: openWith(admins, null, "usr_member"),
      guestPeer: openWith(admins, null, "usr_guest"),
    }).toEqual({ memberPeer: true, guestPeer: false })
  })
})
