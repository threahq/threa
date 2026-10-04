import { renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as authModule from "@/auth"
import { clearAllCachedData, db } from "@/db"
import { seedWorkspaceUser } from "@/test/workspace-rows"
import { useMentionables } from "./use-mentionables"

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
})
