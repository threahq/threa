import { describe, expect, test } from "bun:test"
import { TestClient, createWorkspace, loginAs } from "../client"

const GRANT = "urn:ietf:params:oauth:grant-type:device_code"

interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

async function authorize(client: TestClient, body: Record<string, unknown> = {}): Promise<DeviceAuthorization> {
  const res = await client.post<DeviceAuthorization>("/api/oauth/device_authorization", {
    client_id: "threa-bot",
    ...body,
  })
  expect(res.status).toBe(200)
  return res.data
}

function token(client: TestClient, deviceCode: string) {
  return client.post<Record<string, unknown>>("/api/oauth/token", { grant_type: GRANT, device_code: deviceCode })
}

describe("OAuth device authorization grant (threa-bot connect)", () => {
  test("device_authorization answers with the RFC 8628 response", async () => {
    const auth = await authorize(new TestClient(), { name: "my-agent", host: "laptop" })
    expect(auth.device_code.length).toBeGreaterThanOrEqual(40)
    expect(auth.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ2-9]{4}-[BCDFGHJKMNPQRSTVWXYZ2-9]{4}$/)
    expect(auth.verification_uri).toEndWith("/connect")
    expect(auth.verification_uri_complete).toBe(`${auth.verification_uri}?code=${auth.user_code}`)
    expect(auth.interval).toBe(3)
    expect(auth.expires_in).toBe(15 * 60)
  })

  test("token is authorization_pending until a member approves, then issues the key exactly once", async () => {
    const device = new TestClient()
    const auth = await authorize(device, { name: "my-agent" })
    const pending = await token(device, auth.device_code)
    expect(pending.status).toBe(400)
    expect(pending.data).toEqual({ error: "authorization_pending" })

    const browser = new TestClient()
    await loginAs(browser, "connect-approver@example.com", "Approver")
    const workspace = await createWorkspace(browser, "Connect WS")
    const lookup = await browser.get<{ userCode: string; requestedName: string | null }>(
      `/api/bot-connect/lookup?code=${auth.user_code.toLowerCase()}`
    )
    expect(lookup.status).toBe(200)
    expect(lookup.data).toMatchObject({ userCode: auth.user_code, requestedName: "my-agent" })

    const approve = await browser.post("/api/bot-connect/approve", {
      code: auth.user_code,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      botId: "bot_01TEST",
      botSlug: "my-agent",
      scope: "bot-runtime:write bot-invocations:write",
      apiKey: "threa_bk_test_value",
    })
    expect(approve.status).toBe(200)

    const issued = await token(device, auth.device_code)
    expect(issued.status).toBe(200)
    expect(issued.headers.get("cache-control")).toBe("no-store")
    expect(issued.data).toEqual({
      access_token: "threa_bk_test_value",
      token_type: "Bearer",
      scope: "bot-runtime:write bot-invocations:write",
      base_url: expect.any(String),
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      bot_id: "bot_01TEST",
      bot_slug: "my-agent",
    })
    const again = await token(device, auth.device_code)
    expect(again.status).toBe(400)
    expect(again.data).toEqual({ error: "invalid_grant" })
    // Once approved the user code is spent.
    expect((await browser.get(`/api/bot-connect/lookup?code=${auth.user_code}`)).status).toBe(404)
  })

  test("approval needs a session and membership of the named workspace", async () => {
    const auth = await authorize(new TestClient())
    const body = {
      code: auth.user_code,
      workspaceId: "ws_x",
      workspaceName: "x",
      botId: "bot_x",
      botSlug: "x",
      scope: "bot-runtime:write",
      apiKey: "threa_bk_x",
    }
    expect((await new TestClient().post("/api/bot-connect/approve", body)).status).toBe(401)

    const outsider = new TestClient()
    await loginAs(outsider, "connect-outsider@example.com", "Outsider")
    const owner = new TestClient()
    await loginAs(owner, "connect-owner@example.com", "Owner")
    const workspace = await createWorkspace(owner, "Owner WS")
    const forbidden = await outsider.post("/api/bot-connect/approve", {
      ...body,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    expect(forbidden.status).toBe(403)
    expect((await token(new TestClient(), auth.device_code)).data).toEqual({ error: "authorization_pending" })
  })

  test("deny turns into access_denied for the device", async () => {
    const device = new TestClient()
    const auth = await authorize(device)
    const browser = new TestClient()
    await loginAs(browser, "connect-denier@example.com", "Denier")
    expect((await browser.post("/api/bot-connect/deny", { code: auth.user_code })).status).toBe(200)
    expect((await token(device, auth.device_code)).data).toEqual({ error: "access_denied" })
    expect((await browser.post("/api/bot-connect/deny", { code: auth.user_code })).status).toBe(404)
  })

  test("bad grants and unknown codes are OAuth errors, not hints", async () => {
    const client = new TestClient()
    const wrongGrant = await client.post<{ error: string }>("/api/oauth/token", {
      grant_type: "authorization_code",
      device_code: "x".repeat(43),
    })
    expect(wrongGrant.status).toBe(400)
    expect(wrongGrant.data).toEqual({ error: "unsupported_grant_type" })
    const unknown = await token(client, "x".repeat(43))
    expect(unknown.status).toBe(400)
    expect(unknown.data).toEqual({ error: "invalid_grant" })
    await loginAs(client, "connect-lookup@example.com", "Lookup")
    expect((await client.get("/api/bot-connect/lookup?code=ZZZZ-ZZZZ")).status).toBe(404)
  })

  test("a form-encoded token request works too, as the RFC clients send it", async () => {
    const device = new TestClient()
    const auth = await authorize(device)
    const res = await fetch(`${process.env.TEST_BASE_URL}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: GRANT, device_code: auth.device_code }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "authorization_pending" })
  })
})
