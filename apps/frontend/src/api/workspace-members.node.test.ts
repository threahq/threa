import { beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "./client"
import { workspaceMembersApi } from "./workspace-members"

describe("workspaceMembersApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("posts to the workspace member role endpoint", async () => {
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(undefined)

    await workspaceMembersApi.changeRole("ws_1", "usr_2", "admin")

    expect(postSpy).toHaveBeenCalledWith("/api/workspaces/ws_1/users/usr_2/role", { roleSlug: "admin" })
  })

  it("deletes the workspace member", async () => {
    const deleteSpy = vi.spyOn(api, "delete").mockResolvedValue(undefined)

    await workspaceMembersApi.remove("ws_1", "usr_2")

    expect(deleteSpy).toHaveBeenCalledWith("/api/workspaces/ws_1/users/usr_2")
  })
})
