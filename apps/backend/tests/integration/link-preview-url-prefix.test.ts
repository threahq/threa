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
