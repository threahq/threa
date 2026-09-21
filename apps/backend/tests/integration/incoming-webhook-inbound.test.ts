/**
 * Inbound webhook delivery over real HTTP against the booted server, so the
 * global body parsers, the route's own parser, the rate limiters, route
 * ordering (no Bearer chain in front of these paths) and the access log are all
 * exercised rather than stubbed.
 *
 * Run: bun test --preload ./tests/setup.ts tests/integration/incoming-webhook-inbound.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { getTestDatabaseTarget } from "../test-database"
import { TestClient, createBot, createChannel, createWorkspace, getBaseUrl, loginAs } from "../client"
import { archiveStream } from "../client"

interface MessageDbRow {
  id: string
  author_id: string
  author_type: string
  content_markdown: string
  sent_via: string | null
}

interface AccessLogDbRow {
  row: {
    actor_type: string
    actor_id: string
    auth_ref: string | null
    operation: string
    outcome: string
    subjects: { type: string; id?: string }[] | null
    [column: string]: unknown
  }
}

const testRunId = Math.random().toString(36).slice(2, 8)

interface Hook {
  id: string
  secret: string
  nativeUrl: string
  slackUrl: string
  streamId: string
  botId: string
}

describe("incoming webhook inbound delivery", () => {
  let pool: Pool
  let client: TestClient
  let workspaceId: string
  let hook: Hook

  async function createHook(streamId: string, name: string, botId: string): Promise<Hook> {
    const { status, data } = await client.post<{ webhook: { id: string }; secret: string }>(
      `/api/workspaces/${workspaceId}/bots/${botId}/webhooks`,
      { name, streamId }
    )
    if (status !== 201) throw new Error(`Create webhook failed: ${JSON.stringify(data)}`)
    const base = `${getBaseUrl()}/api/v1/workspaces/${workspaceId}/hooks/${data.webhook.id}/${data.secret}`
    return { id: data.webhook.id, secret: data.secret, nativeUrl: base, slackUrl: `${base}/slack`, streamId, botId }
  }

  async function post(url: string, body: string, headers: Record<string, string> = {}) {
    const response = await fetch(url, { method: "POST", body, headers })
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      text: await response.text(),
    }
  }

  async function latestMessage(streamId: string): Promise<MessageDbRow | null> {
    const { rows } = await pool.query<MessageDbRow>(
      `SELECT id, author_id, author_type, content_markdown, sent_via
       FROM messages WHERE stream_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [streamId]
    )
    return rows[0] ?? null
  }

  async function pollAccessLog(where: string, params: unknown[]): Promise<AccessLogDbRow[]> {
    for (let attempt = 0; attempt < 40; attempt++) {
      // The whole row, not a column list: a redaction regression that moved the
      // secret into another column would pass a narrower select.
      const { rows } = await pool.query<AccessLogDbRow>(
        `SELECT to_jsonb(access_log) AS row FROM access_log WHERE ${where} ORDER BY occurred_at DESC`,
        params
      )
      if (rows.length > 0) return rows
      await new Promise((r) => setTimeout(r, 50))
    }
    return []
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
    client = new TestClient()
    await loginAs(client, `hook-inbound-${testRunId}@test.com`, "Hook Owner")
    const ws = await createWorkspace(client, "Hook Inbound WS")
    workspaceId = ws.id
    const channel = await createChannel(client, workspaceId, `hooks-${testRunId}`, "public")
    const bot = await createBot(client, workspaceId, {
      type: "shared",
      name: `Hook Bot ${testRunId}`,
      slug: `hook-bot-${testRunId}`,
    })
    hook = await createHook(channel.id, "Alerts", bot.id)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should store a bot-authored message with translated markdown when given slack JSON", async () => {
    const result = await post(
      hook.slackUrl,
      JSON.stringify({ text: "*Deploy* finished — <https://ci.example.com/42|run 42>" }),
      { "Content-Type": "application/json" }
    )

    expect(result.status).toBe(200)
    expect(result.text).toBe("ok")
    expect(result.contentType).toContain("text/plain")

    const message = await latestMessage(hook.streamId)
    expect(message).toMatchObject({
      author_id: hook.botId,
      author_type: "bot",
      content_markdown: "**Deploy** finished — [run 42](https://ci.example.com/42)",
      sent_via: `webhook:${hook.id}`,
    })
  })

  test("should accept a form post when given payload=<json>", async () => {
    const result = await post(
      hook.slackUrl,
      new URLSearchParams({ payload: JSON.stringify({ text: "form _ok_" }) }).toString(),
      {
        "Content-Type": "application/x-www-form-urlencoded",
      }
    )

    expect([result.status, result.text]).toEqual([200, "ok"])
    expect((await latestMessage(hook.streamId))?.content_markdown).toBe("form *ok*")
  })

  test("should accept a JSON body when given no content-type at all", async () => {
    const result = await post(hook.slackUrl, JSON.stringify({ text: "typeless" }))

    expect([result.status, result.text]).toEqual([200, "ok"])
    expect((await latestMessage(hook.streamId))?.content_markdown).toBe("typeless")
  })

  test("should accept a JSON body when given the wrong content-type", async () => {
    const result = await post(hook.slackUrl, JSON.stringify({ text: "mislabelled" }), { "Content-Type": "text/plain" })

    expect([result.status, result.text]).toEqual([200, "ok"])
    expect((await latestMessage(hook.streamId))?.content_markdown).toBe("mislabelled")
  })

  test("should answer 400 invalid_payload in text/plain when given a malformed json body", async () => {
    const result = await post(hook.slackUrl, "{not json", { "Content-Type": "application/json" })

    expect(result.status).toBe(400)
    expect(result.text).toBe("invalid_payload")
    expect(result.contentType).toContain("text/plain")
  })

  test("should answer 400 no_text when given a payload carrying no text", async () => {
    const result = await post(hook.slackUrl, "{}", { "Content-Type": "application/json" })

    expect([result.status, result.text]).toEqual([400, "no_text"])
    expect(result.contentType).toContain("text/plain")
  })

  test("should answer 404 no_service when given a wrong secret", async () => {
    const url = `${getBaseUrl()}/api/v1/workspaces/${workspaceId}/hooks/${hook.id}/wrong-secret-value/slack`
    const result = await post(url, JSON.stringify({ text: "nope" }), { "Content-Type": "application/json" })

    expect([result.status, result.text]).toEqual([404, "no_service"])
    expect(result.contentType).toContain("text/plain")
  })

  test("should answer 404 no_service when given an unknown hook id", async () => {
    const url = `${getBaseUrl()}/api/v1/workspaces/${workspaceId}/hooks/hook_does_not_exist/whatever/slack`
    const result = await post(url, JSON.stringify({ text: "nope" }), { "Content-Type": "application/json" })

    expect([result.status, result.text]).toEqual([404, "no_service"])
  })

  test("should record a wrong-secret attempt in access_log without the secret anywhere in the row", async () => {
    const secret = `probe-${testRunId}-DEADBEEF`
    const url = `${getBaseUrl()}/api/v1/workspaces/${workspaceId}/hooks/${hook.id}/${secret}/slack`
    expect((await post(url, "{}", { "Content-Type": "application/json" })).status).toBe(404)

    const rows = await pollAccessLog(
      "workspace_id = $1 AND operation = 'webhooks.receive' AND outcome = 'denied' AND subjects @> $2::jsonb",
      [workspaceId, JSON.stringify([{ type: "param", id: hook.id }])]
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows[0]?.row).toLowerCase()).not.toContain(secret.toLowerCase())
  })

  test("should attribute a successful post to the bot with the hook as auth_ref in access_log", async () => {
    expect(
      (await post(hook.slackUrl, JSON.stringify({ text: "audited" }), { "Content-Type": "application/json" })).status
    ).toBe(200)

    const rows = await pollAccessLog(
      "workspace_id = $1 AND operation = 'webhooks.receive' AND outcome = 'success' AND auth_ref = $2",
      [workspaceId, hook.id]
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.row).toMatchObject({ actor_type: "bot", actor_id: hook.botId, auth_ref: hook.id })
  })

  test("should store the content verbatim when given a native body", async () => {
    const response = await fetch(hook.nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "native **hello**" }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ok: true })
    expect(await latestMessage(hook.streamId)).toMatchObject({
      author_id: hook.botId,
      content_markdown: "native **hello**",
      sent_via: `webhook:${hook.id}`,
    })
  })

  test("should answer 404 NOT_FOUND as JSON on the native route when given a wrong secret", async () => {
    const response = await fetch(`${getBaseUrl()}/api/v1/workspaces/${workspaceId}/hooks/${hook.id}/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    })

    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" })
  })

  test("should answer 400 VALIDATION_ERROR on the native route when given an empty content", async () => {
    const response = await fetch(hook.nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" })
  })

  test("should answer 400 INVALID_PAYLOAD as JSON on the native route when given a malformed json body", async () => {
    const response = await fetch(hook.nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    })

    expect([response.status, await response.json()]).toEqual([
      400,
      { error: "Request body is not valid JSON or is too large", code: "INVALID_PAYLOAD" },
    ])
  })

  test("should refuse an oversized body with invalid_payload when given more than the route's 256kb limit", async () => {
    const result = await post(hook.slackUrl, JSON.stringify({ text: "x".repeat(300_000) }), {
      "Content-Type": "application/json",
    })

    expect([result.status, result.text]).toEqual([400, "invalid_payload"])
  })

  test("should keep serving a hook when wrong-secret posts exceed its per-hook limit without ever proving the secret", async () => {
    const channel = await createChannel(client, workspaceId, `hooks-bucket-${testRunId}`, "public")
    const bot = await createBot(client, workspaceId, {
      type: "shared",
      name: `Bucket Bot ${testRunId}`,
      slug: `bucket-bot-${testRunId}`,
    })
    const fresh = await createHook(channel.id, "Bucket", bot.id)
    const wrongUrl = `${getBaseUrl()}/api/v1/workspaces/${workspaceId}/hooks/${fresh.id}/wrong-secret/slack`

    const statuses = new Set<number>()
    for (let attempt = 0; attempt < 61; attempt++) {
      statuses.add((await post(wrongUrl, "{}", { "Content-Type": "application/json" })).status)
    }
    expect([...statuses]).toEqual([404])

    const result = await post(fresh.slackUrl, JSON.stringify({ text: "still serving" }), {
      "Content-Type": "application/json",
    })
    expect([result.status, result.text]).toEqual([200, "ok"])
  })

  test("should stop serving both routes when the target stream is archived after creation", async () => {
    const doomed = await createChannel(client, workspaceId, `hooks-archived-${testRunId}`, "public")
    const bot = await createBot(client, workspaceId, {
      type: "shared",
      name: `Archived Bot ${testRunId}`,
      slug: `archived-bot-${testRunId}`,
    })
    const archivedHook = await createHook(doomed.id, "Archived", bot.id)
    await archiveStream(client, workspaceId, doomed.id)

    const slack = await post(archivedHook.slackUrl, JSON.stringify({ text: "late" }), {
      "Content-Type": "application/json",
    })
    expect([slack.status, slack.text]).toEqual([404, "no_service"])
    expect(slack.contentType).toContain("text/plain")

    const native = await fetch(archivedHook.nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "late" }),
    })
    expect(native.headers.get("content-type")).toContain("application/json")
    expect([native.status, await native.json()]).toMatchObject([
      403,
      { code: "STREAM_READ_ONLY", details: { reason: "archived" } },
    ])
  })
})
