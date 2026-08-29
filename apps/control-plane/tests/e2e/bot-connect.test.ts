import { describe, expect, test } from "bun:test"
import { TestClient, createWorkspace, loginAs } from "../client"

interface Started {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresAt: string
  intervalSeconds: number
}

async function start(client: TestClient, body: Record<string, unknown> = {}): Promise<Started> {
  const res = await client.post<Started>("/api/bot-connect", body)
  expect(res.status).toBe(201)
  return res.data
}

describe("Bot connect (device-code flow)", () => {
  test("start hands out a device code and a typeable user code", async () => {
    const started = await start(new TestClient(), { name: "my-agent", host: "laptop" })
    expect(started.deviceCode.length).toBeGreaterThanOrEqual(40)
    expect(started.userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ2-9]{4}-[BCDFGHJKMNPQRSTVWXYZ2-9]{4}$/)
    expect(started.verificationUrl).toEndWith(`/connect?code=${started.userCode}`)
    expect(started.intervalSeconds).toBe(3)
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000)
  })

  test("poll reports pending until a member approves, then hands the key over exactly once", async () => {
    const device = new TestClient()
    const started = await start(device, { name: "my-agent" })
    expect((await device.get("/api/bot-connect/poll?deviceCode=" + started.deviceCode)).data).toEqual({
      status: "pending",
    })

    const browser = new TestClient()
    await loginAs(browser, "connect-approver@example.com", "Approver")
    const workspace = await createWorkspace(browser, "Connect WS")
    const lookup = await browser.get<{ userCode: string; requestedName: string | null }>(
      `/api/bot-connect/lookup?code=${started.userCode.toLowerCase()}`
    )
    expect(lookup.status).toBe(200)
    expect(lookup.data).toMatchObject({ userCode: started.userCode, requestedName: "my-agent" })

    const approve = await browser.post("/api/bot-connect/approve", {
      code: started.userCode,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      botId: "bot_01TEST",
      botSlug: "my-agent",
      apiKey: "threa_bk_test_value",
    })
    expect(approve.status).toBe(200)

    const first = await device.get<Record<string, unknown>>("/api/bot-connect/poll?deviceCode=" + started.deviceCode)
    expect(first.data).toEqual({
      status: "approved",
      baseUrl: expect.any(String),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      botId: "bot_01TEST",
      botSlug: "my-agent",
      apiKey: "threa_bk_test_value",
    })
    const second = await device.get<Record<string, unknown>>("/api/bot-connect/poll?deviceCode=" + started.deviceCode)
    expect(second.data).toEqual({ status: "claimed" })
    // Once approved the user code is spent.
    expect((await browser.get(`/api/bot-connect/lookup?code=${started.userCode}`)).status).toBe(404)
  })

  test("approval needs a session and membership of the named workspace", async () => {
    const started = await start(new TestClient())
    const anonymous = await new TestClient().post("/api/bot-connect/approve", {
      code: started.userCode,
      workspaceId: "ws_x",
      workspaceName: "x",
      botId: "bot_x",
      botSlug: "x",
      apiKey: "threa_bk_x",
    })
    expect(anonymous.status).toBe(401)

    const outsider = new TestClient()
    await loginAs(outsider, "connect-outsider@example.com", "Outsider")
    const owner = new TestClient()
    await loginAs(owner, "connect-owner@example.com", "Owner")
    const workspace = await createWorkspace(owner, "Owner WS")
    const forbidden = await outsider.post("/api/bot-connect/approve", {
      code: started.userCode,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      botId: "bot_x",
      botSlug: "x",
      apiKey: "threa_bk_x",
    })
    expect(forbidden.status).toBe(403)
    expect((await new TestClient().get("/api/bot-connect/poll?deviceCode=" + started.deviceCode)).data).toEqual({
      status: "pending",
    })
  })

  test("deny closes the request and the device learns it", async () => {
    const device = new TestClient()
    const started = await start(device)
    const browser = new TestClient()
    await loginAs(browser, "connect-denier@example.com", "Denier")
    expect((await browser.post("/api/bot-connect/deny", { code: started.userCode })).status).toBe(200)
    expect((await device.get("/api/bot-connect/poll?deviceCode=" + started.deviceCode)).data).toEqual({
      status: "denied",
    })
    expect((await browser.post("/api/bot-connect/deny", { code: started.userCode })).status).toBe(404)
  })

  test("an unknown device code or user code is a 404, not a hint", async () => {
    const client = new TestClient()
    expect((await client.get("/api/bot-connect/poll?deviceCode=" + "x".repeat(43))).status).toBe(404)
    await loginAs(client, "connect-lookup@example.com", "Lookup")
    expect((await client.get("/api/bot-connect/lookup?code=ZZZZ-ZZZZ")).status).toBe(404)
  })
})
