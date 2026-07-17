import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTestTransaction } from "./setup"
import { LinkPreviewRepository } from "../../src/features/link-previews/repository"
import { escapeLikePattern } from "../../src/features/link-previews/refresh"

/**
 * Regression (Fable adversarial review on #1374): the query's `ESCAPE '\'` in a
 * TS template literal cooked to `ESCAPE ''`, disabling escape processing — so
 * `escapeLikePattern`'s backslashes became literal pattern characters and any
 * repo name containing `_` never matched. This exercises the real Postgres
 * query; every unit-level caller mocks the repo method and can't catch it.
 */
describe("findByNormalizedUrlPrefix escaping", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("matches underscore repo names literally, without wildcard bleed", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, created_at)
         VALUES
           ('lp_underscore', 'ws_esc_test', 'https://github.com/acme/my_repo/pull/7',
            'https://github.com/acme/my_repo/pull/7', 'completed', 'website', NOW()),
           ('lp_wildcard', 'ws_esc_test', 'https://github.com/acme/myxrepo/pull/7',
            'https://github.com/acme/myxrepo/pull/7', 'completed', 'website', NOW())`
      )

      const rows = await LinkPreviewRepository.findByNormalizedUrlPrefix(
        client,
        "ws_esc_test",
        escapeLikePattern("https://github.com/acme/my_repo/pull/7")
      )

      expect(rows.map((r) => r.id)).toEqual(["lp_underscore"])
    })
  })
})

/**
 * Regression (Sol review round 3 on #1374): the webhook-refresh path must not let
 * a slow pre-merge GET blind-overwrite a newer write. The compare-and-set was on
 * `fetched_at`, but Postgres stores TIMESTAMPTZ microseconds while pg maps the
 * column to a millisecond JS `Date` — so a value read back through the repository
 * never equalled the stored one and every uncontended refresh spuriously lost the
 * CAS. `overwriteMetadata` now compares-and-sets on an integer `refresh_version`
 * that every write increments. Exercises the real Postgres predicate — a mock
 * can't prove the WHERE clause actually gates the write.
 */
describe("overwriteMetadata compare-and-set on refresh_version", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("round-trip: a version written by the repo's own NOW() path CAS-writes when read back", async () => {
    // The exact case the old fetched_at CAS failed ~999/1000 times: the row's
    // fetched_at + refresh_version are produced by the repository's own
    // NOW()-writing code (updateMetadata), read back through getById, then passed
    // straight into the CAS. With the integer version this must succeed.
    await withTestTransaction(pool, async (client) => {
      const inserted = await LinkPreviewRepository.insert(client, {
        id: "lp_rt",
        workspaceId: "ws_cas",
        url: "https://github.com/a/b/pull/1",
        normalizedUrl: "https://github.com/a/b/pull/1",
        contentType: "website",
      })
      expect(inserted.refreshVersion).toBe(0)

      // Repo's own NOW()-writing path: sets fetched_at = NOW() and bumps the version.
      await LinkPreviewRepository.updateMetadata(client, "ws_cas", "lp_rt", {
        status: "completed",
        title: "initial",
      })

      const readBack = await LinkPreviewRepository.findById(client, "ws_cas", "lp_rt")
      expect(readBack!.refreshVersion).toBe(1)
      expect(readBack!.fetchedAt).not.toBeNull()

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_rt",
        { status: "completed", title: "fresh" },
        { expectedRefreshVersion: readBack!.refreshVersion }
      )

      expect(updated?.title).toBe("fresh")
      expect(updated!.refreshVersion).toBe(2)
    })
  })

  test("writes when expectedRefreshVersion matches the row's version", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, refresh_version, created_at)
         VALUES ('lp_cas_win', 'ws_cas', 'https://github.com/a/b/pull/1',
                 'https://github.com/a/b/pull/1', 'completed', 'website', 3, NOW())`
      )

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_cas_win",
        { status: "completed", title: "fresh" },
        { expectedRefreshVersion: 3 }
      )

      expect(updated?.title).toBe("fresh")
      expect(updated!.refreshVersion).toBe(4)
    })
  })

  test("does not write when expectedRefreshVersion is stale (CAS loss)", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, title, refresh_version, created_at)
         VALUES ('lp_cas_lose', 'ws_cas', 'https://github.com/a/b/pull/2',
                 'https://github.com/a/b/pull/2', 'completed', 'website', 'winner', 7, NOW())`
      )

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_cas_lose",
        { status: "completed", title: "loser" },
        { expectedRefreshVersion: 5 }
      )

      expect(updated).toBeNull()
      const { rows } = await client.query(`SELECT title, refresh_version FROM link_previews WHERE id = 'lp_cas_lose'`)
      expect(rows[0].title).toBe("winner")
      expect(rows[0].refresh_version).toBe(7)
    })
  })

  test("writes a fresh (version 0) row when expectedRefreshVersion is 0", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, fetched_at, created_at)
         VALUES ('lp_cas_zero', 'ws_cas', 'https://github.com/a/b/pull/3',
                 'https://github.com/a/b/pull/3', 'completed', 'website', NULL, NOW())`
      )

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_cas_zero",
        { status: "completed", title: "first" },
        { expectedRefreshVersion: 0 }
      )

      expect(updated?.title).toBe("first")
      expect(updated!.refreshVersion).toBe(1)
      expect(updated!.fetchedAt).not.toBeNull()
    })
  })
})
