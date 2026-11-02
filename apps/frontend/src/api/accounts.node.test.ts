import { describe, it, expect, vi, afterEach } from "vitest"
import { accountsApi } from "./accounts"
import * as client from "./client"

describe("accountsApi.resolveIdentity", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("requests the identity resolve form with both params URL-encoded", async () => {
    const getSpy = vi.spyOn(client.api, "get").mockResolvedValue({ ownerUserId: "user_owner" })

    const result = await accountsApi.resolveIdentity("user_01H/ABC", "ws_a&b")

    expect(result).toEqual({ ownerUserId: "user_owner" })
    expect(getSpy).toHaveBeenCalledWith("/api/accounts/resolve?userId=user_01H%2FABC&workspaceId=ws_a%26b")
  })

  it("resolve (bare-workspace form) still omits the userId param", async () => {
    const getSpy = vi.spyOn(client.api, "get").mockResolvedValue({ ownerUserId: "user_owner" })

    await accountsApi.resolve("ws_x y")

    expect(getSpy).toHaveBeenCalledWith("/api/accounts/resolve?workspaceId=ws_x%20y")
  })
})
