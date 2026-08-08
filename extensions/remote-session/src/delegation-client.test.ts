import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { ThreaApiError } from "./client"
import { DelegationClient, type InspectedDelegation } from "./delegation-client"

const fetchSpy = spyOn(globalThis, "fetch")
const client = new DelegationClient({ baseUrl: "https://example.test", workspaceId: "ws_1", apiKey: "key" })

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

afterEach(() => fetchSpy.mockReset())

describe("DelegationClient", () => {
  it("inspects by id without exposing or sending a claim token", async () => {
    fetchSpy.mockResolvedValue(
      response(200, {
        data: {
          id: "dlg_1",
          brief: "work",
          contextRefs: ["msg_1"],
          claimExpiresAt: "2026-07-12T10:15:00.000Z",
        },
      })
    )
    const result: InspectedDelegation = await client.get("dlg_1")
    expect(result).toMatchObject({
      id: "dlg_1",
      brief: "work",
      contextRefs: ["msg_1"],
      claimExpiresAt: "2026-07-12T10:15:00.000Z",
    })
    expect(result).not.toHaveProperty("claimToken")
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1")
    expect((init as RequestInit).headers).not.toHaveProperty("X-Threa-Callback-Token")
  })

  it("releases with the callback token and no reason payload", async () => {
    fetchSpy.mockResolvedValue(response(200, { data: { id: "dlg_1", status: "open" } }))
    await client.release("dlg_1", "secret")
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/release")
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { "X-Threa-Callback-Token": "secret" },
    })
  })

  it("preserves structured 404 errors", async () => {
    fetchSpy.mockResolvedValue(response(404, { code: "NOT_FOUND" }))
    await expect(client.get("dlg_missing")).rejects.toEqual(new ThreaApiError("Threa API 404: ", 404, "NOT_FOUND"))
  })
})
