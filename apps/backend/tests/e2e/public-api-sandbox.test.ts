/**
 * E2E tests for sandbox tokens on the public API: code in an agent's sandbox
 * reads the streams its turn captured, uploads output bound to the agent's
 * stream, streams attachment bytes, and is refused everything else.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-sandbox.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { SandboxSessionTokenService, StreamSandboxRepository } from "../../src/features/sandboxes"
import { personaId, sessionId, streamId } from "../../src/lib/id"
import {
  TestClient,
  createChannel,
  createWorkspace,
  loginAs,
  sendMessage,
  sendMessageWithAttachments,
  uploadAttachment,
} from "../client"
import { createTestPool } from "../integration/setup"

const testRunId = Math.random().toString(36).slice(2)

const baseUrl = () => process.env.TEST_BASE_URL || "http://localhost:3001"

function api(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  })
}

function upload(workspaceId: string, token: string, content: string, fields: Record<string, string> = {}) {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  form.append("file", new Blob([content], { type: "text/csv" }), `out-${testRunId}.csv`)
  return api(`/api/v1/workspaces/${workspaceId}/attachments`, token, { method: "POST", body: form })
}

describe("Public API v1 — sandbox tokens", () => {
  let pool: Pool
  let tokens: SandboxSessionTokenService
  let workspaceId: string
  let capturedId: string
  let uncapturedId: string
  let uncapturedAttachmentId: string
  let quotingId: string
  let persona: string
  let invokerId: string
  let token: string
  let tokenId: string

  /** A token for a command in `agentStreamId`'s sandbox, which must exist for its reads to be served. */
  async function mint(agentStreamId = capturedId, capturedStreamIds = [capturedId]) {
    await StreamSandboxRepository.insertIfAbsent(pool, {
      workspaceId,
      streamId: agentStreamId,
      sandboxId: `box-${agentStreamId}`,
      runner: "fake",
      internet: false,
    })
    return tokens.mint({
      workspaceId,
      invokingUserId: invokerId,
      personaId: persona,
      sessionId: sessionId(),
      streamId: agentStreamId,
      capturedStreamIds,
      ttlSec: 300,
    })
  }

  async function boxContent(agentStreamId: string) {
    return (await StreamSandboxRepository.find(pool, workspaceId, agentStreamId))?.contentStreamIds.sort()
  }

  beforeAll(async () => {
    pool = createTestPool()
    tokens = new SandboxSessionTokenService({ pool })

    const client = new TestClient()
    const user = await loginAs(client, `sandbox-${testRunId}@test.com`, `Sandbox User ${testRunId}`)
    const workspace = await createWorkspace(client, `Sandbox WS ${testRunId}`)
    workspaceId = workspace.id
    // No control-plane in the e2e harness: seed the invoker's permissions
    // mirror, without which the sandbox token 401s OWNER_INACTIVE.
    await pool.query(
      `INSERT INTO workspace_user_permissions (workspace_id, workos_user_id, role_slugs, status, last_event_at)
       VALUES ($1, $2, '{owner}', 'active', now()) ON CONFLICT DO NOTHING`,
      [workspaceId, user.id]
    )
    const captured = await createChannel(client, workspaceId, `sandbox-captured-${testRunId}`, "private")
    const uncaptured = await createChannel(client, workspaceId, `sandbox-other-${testRunId}`, "private")
    capturedId = captured.id
    uncapturedId = uncaptured.id
    await sendMessage(client, workspaceId, capturedId, `captured ${testRunId}`)
    const quoted = await sendMessage(client, workspaceId, uncapturedId, `uncaptured ${testRunId}`)
    const quoting = await createChannel(client, workspaceId, `sandbox-quoting-${testRunId}`, "private")
    quotingId = quoting.id
    await sendMessage(
      client,
      workspaceId,
      quotingId,
      `Shared a message from [Sandbox](shared-message:${uncapturedId}/${quoted.id})`
    )
    const outside = await uploadAttachment(client, workspaceId, {
      content: `secret,${testRunId}`,
      filename: `outside-${testRunId}.csv`,
      mimeType: "text/csv",
    })
    await sendMessageWithAttachments(client, workspaceId, uncapturedId, `attached ${testRunId}`, [outside.id])
    uncapturedAttachmentId = outside.id

    const { data } = await client.get<{ data: { users: Array<{ id: string; workosUserId: string }> } }>(
      `/api/workspaces/${workspaceId}/bootstrap`
    )
    invokerId = data.data.users.find((u) => u.workosUserId === user.id)!.id

    persona = personaId()
    const minted = await mint()
    token = minted.value
    tokenId = minted.session.id
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should list and read only the captured streams", async () => {
    const list = await api(`/api/v1/workspaces/${workspaceId}/streams`, token)
    const listed = ((await list.json()) as { data: Array<{ id: string }> }).data.map((s) => s.id)

    const captured = await api(`/api/v1/workspaces/${workspaceId}/streams/${capturedId}/messages`, token)
    const uncaptured = await api(`/api/v1/workspaces/${workspaceId}/streams/${uncapturedId}/messages`, token)

    expect({ list: list.status, listed, captured: captured.status, uncaptured: uncaptured.status }).toEqual({
      list: 200,
      listed: [capturedId],
      captured: 200,
      uncaptured: 403,
    })
  })

  test("should 404 operations outside the sandbox allowlist", async () => {
    const send = await api(`/api/v1/workspaces/${workspaceId}/streams/${capturedId}/messages`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "from the sandbox" }),
    })
    const me = await api(`/api/v1/workspaces/${workspaceId}/me`, token)

    expect([send.status, me.status]).toEqual([404, 404])
  })

  test("should bind an upload to the agent's stream and stream its bytes back", async () => {
    const content = `x,y\n1,${testRunId}\n`
    const res = await upload(workspaceId, token, content)
    expect(res.status).toBe(201)
    const { data } = (await res.json()) as { data: { id: string } }

    const row = await pool.query<{ stream_id: string; uploaded_by: string; message_id: string | null }>(
      "SELECT stream_id, uploaded_by, message_id FROM attachments WHERE id = $1",
      [data.id]
    )
    const signedUrl = await api(`/api/v1/workspaces/${workspaceId}/attachments/${data.id}/url`, token)
    const download = await api(`/api/v1/workspaces/${workspaceId}/attachments/${data.id}/content`, token)

    expect({
      row: row.rows[0],
      signedUrl: signedUrl.status,
      download: download.status,
      contentType: download.headers.get("content-type"),
      csp: download.headers.get("content-security-policy"),
      body: await download.text(),
    }).toEqual({
      row: { stream_id: capturedId, uploaded_by: persona, message_id: null },
      signedUrl: 404,
      download: 200,
      contentType: expect.stringContaining("text/csv"),
      csp: "sandbox",
      body: content,
    })
  })

  test("should 404 an attachment in a stream the turn did not capture", async () => {
    const base = `/api/v1/workspaces/${workspaceId}/attachments/${uncapturedAttachmentId}`
    const [metadata, content] = await Promise.all([api(base, token), api(`${base}/content`, token)])

    expect([metadata.status, content.status]).toEqual([404, 404])
  })

  test("should refuse an e2e upload", async () => {
    const res = await upload(workspaceId, token, "ciphertext", { e2e: "true" })
    expect({ status: res.status, code: ((await res.json()) as { code: string }).code }).toEqual({
      status: 400,
      code: "E2E_UPLOAD_UNSUPPORTED",
    })
  })

  test("should record the streams a search served on the sandbox", async () => {
    const box = streamId()
    const searcher = await mint(box)
    const search = await api(`/api/v1/workspaces/${workspaceId}/messages/search`, searcher.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: testRunId }),
    })
    const found = ((await search.json()) as { data: Array<{ streamId: string }> }).data.map((r) => r.streamId)

    expect({ found, content: await boxContent(box) }).toEqual({ found: [capturedId], content: [capturedId] })
  })

  test("should record the stream of a quoted message it hydrated on the sandbox", async () => {
    const reader = await mint(quotingId, [quotingId, uncapturedId])
    const list = await api(`/api/v1/workspaces/${workspaceId}/streams/${quotingId}/messages`, reader.value)
    const slots = Object.values(((await list.json()) as { slots: Record<string, { state: string }> }).slots)

    expect({ slots: slots.map((s) => s.state), content: await boxContent(quotingId) }).toEqual({
      slots: ["ok"],
      content: [quotingId, uncapturedId].sort(),
    })
  })

  test("should refuse a read when the token's stream has no sandbox to record it on", async () => {
    const orphan = await tokens.mint({
      workspaceId,
      invokingUserId: invokerId,
      personaId: persona,
      sessionId: sessionId(),
      streamId: streamId(),
      capturedStreamIds: [capturedId],
      ttlSec: 300,
    })
    const res = await api(`/api/v1/workspaces/${workspaceId}/streams/${capturedId}/messages`, orphan.value)
    expect(res.status).toBe(401)
  })

  test("should stop answering once the token is revoked, its reads kept on the sandbox", async () => {
    await tokens.revoke(workspaceId, tokenId)
    const res = await api(`/api/v1/workspaces/${workspaceId}/streams`, token)
    expect({ status: res.status, content: await boxContent(capturedId) }).toEqual({
      status: 401,
      content: [capturedId],
    })
  })
})
