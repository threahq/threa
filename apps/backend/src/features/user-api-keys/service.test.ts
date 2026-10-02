import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "crypto"
import type { Pool } from "pg"
import { UserApiKeyService } from "./service"
import { UserApiKeyRepository, type UserApiKeyRow } from "./repository"

afterEach(() => mock.restore())

function keyRow(overrides: Partial<UserApiKeyRow>): UserApiKeyRow {
  return {
    id: "uak_other",
    workspaceId: "ws_other",
    userId: "usr_other",
    name: "key",
    keyHash: "00".repeat(32),
    keyPrefix: "abcdefgh",
    scopes: ["messages:read"],
    apiVersion: null,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  }
}

describe("UserApiKeyService.validateKey", () => {
  test("should touch last_used_at in the matched key's workspace when another workspace's key shares the prefix", async () => {
    const value = "threa_uk_abcdefgh-secret"
    const matched = keyRow({
      id: "uak_matched",
      workspaceId: "ws_matched",
      userId: "usr_matched",
      keyHash: createHash("sha256").update(value).digest("hex"),
    })
    spyOn(UserApiKeyRepository, "findActiveByPrefix").mockResolvedValue([keyRow({}), matched])
    const touch = spyOn(UserApiKeyRepository, "touchLastUsed").mockResolvedValue(undefined)
    const pool = {} as Pool

    const validated = await new UserApiKeyService(pool).validateKey(value)

    expect({ id: validated?.id, workspaceId: validated?.workspaceId, userId: validated?.userId }).toEqual({
      id: "uak_matched",
      workspaceId: "ws_matched",
      userId: "usr_matched",
    })
    expect(touch.mock.calls).toEqual([[pool, "ws_matched", "uak_matched"]])
  })
})
