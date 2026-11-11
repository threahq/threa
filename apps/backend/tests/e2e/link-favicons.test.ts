import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { createTestServerPool, seedCompletedLinkPreview } from "../integration/setup"
import { TestClient, createScratchpad, createWorkspace, joinWorkspace, loginAs, sendMessage } from "../client"
import { LinkFaviconRepository } from "../../src/features/link-previews"

const runId = Math.random().toString(36).slice(2, 8)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe("GET /api/workspaces/:workspaceId/link-favicons/:host", () => {
  let pool: Pool

  beforeAll(() => {
    pool = createTestServerPool()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function answer(client: TestClient, workspaceId: string, host: string, headers?: Record<string, string>) {
    const response = await client.request(
      "GET",
      `/api/workspaces/${workspaceId}/link-favicons/${encodeURIComponent(host)}`,
      undefined,
      headers
    )
    if (response.status === 404) {
      return { status: 404, cacheControl: response.headers.get("cache-control"), body: response.data }
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      nosniff: response.headers.get("x-content-type-options"),
      csp: response.headers.get("content-security-policy"),
      etag: response.headers.get("etag"),
    }
  }

  test("should serve a cached icon only to users who can read a message linking its host", async () => {
    const owner = new TestClient()
    const member = new TestClient()
    const guest = new TestClient()
    await loginAs(owner, `favicon-owner-${runId}@test.com`, "Favicon Owner")
    await loginAs(member, `favicon-member-${runId}@test.com`, "Favicon Member")
    await loginAs(guest, `favicon-guest-${runId}@test.com`, "Favicon Guest")
    const workspace = await createWorkspace(owner, `Favicon WS ${runId}`)
    await joinWorkspace(member, workspace.id)
    await joinWorkspace(guest, workspace.id, WORKSPACE_ROLE_SLUGS.GUEST)

    const scratchpad = await createScratchpad(owner, workspace.id, "off")
    const linked = {
      "private-notes.example": "https://private-notes.example/plan",
      "under_score.example": "https://under_score.example/page",
      "[2001:db8::1]:8080": "http://[2001:db8::1]:8080/status",
    }
    for (const [host, url] of Object.entries(linked)) {
      const message = await sendMessage(owner, workspace.id, scratchpad.id, `see ${url}`)
      await seedCompletedLinkPreview(pool, { workspaceId: workspace.id, messageId: message.id, url, title: "A page" })
      await LinkFaviconRepository.storeIcon(pool, {
        workspaceId: workspace.id,
        host,
        contentType: "image/png",
        bytes: PNG,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    }

    const served = await answer(owner, workspace.id, "private-notes.example")
    const icon = {
      status: 200,
      contentType: "image/png",
      cacheControl: "private, max-age=604800",
      nosniff: "nosniff",
      csp: "sandbox",
      etag: expect.stringMatching(/./),
    }
    const notFound = { status: 404, cacheControl: "private, max-age=300", body: { error: "Not found" } }

    expect({
      owner: served,
      revalidated: (
        await answer(owner, workspace.id, "private-notes.example", { "If-None-Match": String(served.etag) })
      ).status,
      underscoreHost: (await answer(owner, workspace.id, "under_score.example")).status,
      ipv6Host: (await answer(owner, workspace.id, "[2001:db8::1]:8080")).status,
      memberOutsideTheStream: await answer(member, workspace.id, "private-notes.example"),
      guestOutsideTheStream: await answer(guest, workspace.id, "private-notes.example"),
      memberUnknownHost: await answer(member, workspace.id, "never-linked.example"),
      hostThatWasNeverAKey: (await answer(owner, workspace.id, "\u0000")).status,
    }).toEqual({
      owner: icon,
      revalidated: 304,
      underscoreHost: 200,
      ipv6Host: 200,
      memberOutsideTheStream: notFound,
      guestOutsideTheStream: notFound,
      memberUnknownHost: notFound,
      hostThatWasNeverAKey: 400,
    })
  })
})
