import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as authModule from "@/auth"
import { ServicesProvider, type StreamService } from "@/contexts"
import { clearAllCachedData, db } from "@/db"
import { seedWorkspaceUser } from "@/test/workspace-rows"
import { useMentionables, useMentionStreamContext, type MentionStreamContext } from "./use-mentionables"
import { streamKeys } from "./use-streams"

const WORKSPACE_ID = "ws_1"

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    MemoryRouter,
    { initialEntries: [`/w/${WORKSPACE_ID}`] },
    createElement(Routes, undefined, createElement(Route, { path: "/w/:workspaceId", element: children }))
  )
}

describe("useMentionables host user copies", () => {
  beforeEach(async () => {
    await clearAllCachedData()
    vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_usr_local" } as ReturnType<typeof authModule.useUser>)
  })

  afterEach(() => vi.restoreAllMocks())

  it("should offer a local user and leave out a copy of a host user when listing who to mention", async () => {
    await seedWorkspaceUser(WORKSPACE_ID, "usr_local", "Lena Local")
    await seedWorkspaceUser(WORKSPACE_ID, "usr_copy", "Hosted Hazel")
    await db.workspaceUsers.update([WORKSPACE_ID, "usr_copy"], { originWorkspaceId: "ws_host" })

    const { result } = renderHook(() => useMentionables(), { wrapper })

    await waitFor(() =>
      expect(result.current.mentionables.filter((m) => m.type === "user").map((m) => m.id)).toEqual(["usr_local"])
    )
  })

  it("should keep a copy of a host user when a from filter asks for host copies", async () => {
    await seedWorkspaceUser(WORKSPACE_ID, "usr_local", "Lena Local")
    await seedWorkspaceUser(WORKSPACE_ID, "usr_copy", "Hosted Hazel")
    await db.workspaceUsers.update([WORKSPACE_ID, "usr_copy"], { originWorkspaceId: "ws_host" })

    const { result } = renderHook(() => useMentionables(undefined, { includeHostCopies: true }), { wrapper })

    await waitFor(() =>
      expect(
        result.current.mentionables
          .filter((m) => m.type === "user")
          .map((m) => m.id)
          .sort()
      ).toEqual(["usr_copy", "usr_local"])
    )
  })
})

// One transaction so a live query never observes the copy before its origin is set.
async function seedLocalUserAndPartnerCopy() {
  await db.transaction("rw", db.workspaceUsers, async () => {
    await seedWorkspaceUser(WORKSPACE_ID, "usr_local", "Lena Local")
    await seedWorkspaceUser(WORKSPACE_ID, "usr_copy", "Partner Petra")
    await db.workspaceUsers.update([WORKSPACE_ID, "usr_copy"], { originWorkspaceId: "ws_partner" })
  })
}

describe("useMentionables connected workspace copies", () => {
  const sharedChannel: MentionStreamContext = {
    streamType: "channel",
    connectedWorkspaceIds: new Set(["ws_partner"]),
  }

  beforeEach(async () => {
    await clearAllCachedData()
    vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_usr_local" } as ReturnType<typeof authModule.useUser>)
    await seedLocalUserAndPartnerCopy()
  })

  afterEach(() => vi.restoreAllMocks())

  it("should list a copy of a connected workspace's user when the stream is shared with that workspace", async () => {
    const { result } = renderHook(() => useMentionables(sharedChannel), { wrapper })

    await waitFor(() =>
      expect(
        result.current.mentionables
          .filter((m) => m.type === "user")
          .map((m) => m.id)
          .sort()
      ).toEqual(["usr_copy", "usr_local"])
    )
  })

  it("should leave out a copy when the stream is shared with a different workspace", async () => {
    const { result } = renderHook(
      () => useMentionables({ streamType: "channel", connectedWorkspaceIds: new Set(["ws_other"]) }),
      { wrapper }
    )

    await waitFor(() =>
      expect(result.current.mentionables.filter((m) => m.type === "user").map((m) => m.id)).toEqual(["usr_local"])
    )
  })

  it("should leave out a connected workspace's copy when listing who to invite", async () => {
    const { result } = renderHook(() => useMentionables({ ...sharedChannel, inviteMode: true, memberIds: new Set() }), {
      wrapper,
    })

    await waitFor(() =>
      expect(result.current.mentionables.filter((m) => m.type === "user").map((m) => m.id)).toEqual(["usr_local"])
    )
  })
})

describe("useMentionStreamContext connected workspaces", () => {
  let queryClient: QueryClient

  function contextWrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      // No socket is provided, so the bootstrap is read from the seeded cache and never fetched.
      createElement(ServicesProvider, {
        services: { streams: {} as StreamService },
        children: wrapper({ children }),
      })
    )
  }

  function seedBootstrap(streamId: string, bootstrap: Record<string, unknown>) {
    queryClient.setQueryData(streamKeys.bootstrap(WORKSPACE_ID, streamId), {
      members: [],
      botMemberIds: [],
      ...bootstrap,
    })
  }

  beforeEach(async () => {
    await clearAllCachedData()
    queryClient = new QueryClient()
    vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_usr_local" } as ReturnType<typeof authModule.useUser>)
    await seedLocalUserAndPartnerCopy()
  })

  afterEach(() => vi.restoreAllMocks())

  it("should list a connected workspace's copy when the stream's bootstrap names that workspace", async () => {
    seedBootstrap("stream_shared", { connectedWorkspaces: [{ id: "ws_partner", name: "Globex" }] })

    const { result } = renderHook(
      () => useMentionables(useMentionStreamContext(WORKSPACE_ID, { id: "stream_shared", type: "channel" })),
      { wrapper: contextWrapper }
    )

    await waitFor(() =>
      expect(
        result.current.mentionables
          .filter((m) => m.type === "user")
          .map((m) => m.id)
          .sort()
      ).toEqual(["usr_copy", "usr_local"])
    )
  })

  it("should take the connected workspaces from the root stream's bootstrap when the stream is a thread", async () => {
    seedBootstrap("stream_shared", { connectedWorkspaces: [{ id: "ws_partner", name: "Globex" }] })

    const { result } = renderHook(
      () =>
        useMentionStreamContext(WORKSPACE_ID, { id: "stream_thread", type: "thread", rootStreamId: "stream_shared" }),
      { wrapper: contextWrapper }
    )

    await waitFor(() => expect(result.current?.connectedWorkspaceIds).toEqual(new Set(["ws_partner"])))
  })

  it("should connect no workspaces when the bootstrap omits the field", async () => {
    seedBootstrap("stream_shared", {})

    const { result } = renderHook(
      () => useMentionStreamContext(WORKSPACE_ID, { id: "stream_shared", type: "channel" }),
      { wrapper: contextWrapper }
    )

    await waitFor(() => expect(result.current?.connectedWorkspaceIds).toEqual(new Set()))
  })
})
