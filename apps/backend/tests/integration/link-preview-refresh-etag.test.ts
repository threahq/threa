import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTestTransaction } from "./setup"
import { LinkPreviewRepository } from "../../src/features/link-previews/repository"

/**
 * Real-Postgres coverage for the conditional-refresh persistence pieces
 * (INV-66 rule: the compared version must be produced by the repository's own
 * NOW()-writing path and read back through the repository, never hand-crafted).
 */
describe("touchRefreshCheck (304 gate answer)", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("round-trip: touches fetched_at and bumps the version read back from the repo's own write", async () => {
    await withTestTransaction(pool, async (client) => {
      await LinkPreviewRepository.insert(client, {
        id: "lp_touch",
        workspaceId: "ws_etag",
        url: "https://github.com/a/b/pull/1",
        normalizedUrl: "https://github.com/a/b/pull/1",
        contentType: "website",
      })
      await LinkPreviewRepository.updateMetadata(client, "ws_etag", "lp_touch", {
        status: "completed",
        title: "initial",
      })
      const before = await LinkPreviewRepository.findById(client, "ws_etag", "lp_touch")

      const touched = await LinkPreviewRepository.touchRefreshCheck(
        client,
        "ws_etag",
        "lp_touch",
        before!.refreshVersion
      )
      expect(touched).toBe(true)

      const after = await LinkPreviewRepository.findById(client, "ws_etag", "lp_touch")
      expect(after!.refreshVersion).toBe(before!.refreshVersion + 1)
      expect(after!.fetchedAt!.getTime()).toBeGreaterThanOrEqual(before!.fetchedAt!.getTime())
      // Touch must not disturb the rendered metadata.
      expect(after!.title).toBe("initial")
    })
  })

  test("loses the CAS against a concurrent write without touching the row", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, refresh_version, fetched_at, created_at)
         VALUES ('lp_touch_lose', 'ws_etag', 'https://github.com/a/b/pull/2',
                 'https://github.com/a/b/pull/2', 'completed', 'website', 9, NOW(), NOW())`
      )

      const touched = await LinkPreviewRepository.touchRefreshCheck(client, "ws_etag", "lp_touch_lose", 5)

      expect(touched).toBe(false)
      const { rows } = await client.query(`SELECT refresh_version FROM link_previews WHERE id = 'lp_touch_lose'`)
      expect(rows[0].refresh_version).toBe(9)
    })
  })
})

describe("refresh_etag write semantics on overwriteMetadata", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a params key present overwrites, absent preserves, explicit null clears", async () => {
    await withTestTransaction(pool, async (client) => {
      await LinkPreviewRepository.insert(client, {
        id: "lp_etag",
        workspaceId: "ws_etag",
        url: "https://github.com/a/b/pull/3",
        normalizedUrl: "https://github.com/a/b/pull/3",
        contentType: "website",
      })

      const withEtag = await LinkPreviewRepository.overwriteMetadata(client, "ws_etag", "lp_etag", {
        status: "completed",
        title: "v1",
        refreshEtag: '"abc"',
      })
      expect(withEtag!.refreshEtag).toBe('"abc"')

      // Key absent (the unconditional webhook path): stored validator survives.
      const preserved = await LinkPreviewRepository.overwriteMetadata(client, "ws_etag", "lp_etag", {
        status: "completed",
        title: "v2",
      })
      expect(preserved!.refreshEtag).toBe('"abc"')
      expect(preserved!.title).toBe("v2")

      // Explicit null (a gate answer that carried no validator): cleared.
      const cleared = await LinkPreviewRepository.overwriteMetadata(client, "ws_etag", "lp_etag", {
        status: "completed",
        title: "v3",
        refreshEtag: null,
      })
      expect(cleared!.refreshEtag).toBeNull()
    })
  })
})
