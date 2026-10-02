import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "crypto"
import type { Pool } from "pg"
import { BOT_KEY_PREFIX } from "@threahq/types"
import { BotApiKeyService } from "./bot-api-key-service"
import { BotApiKeyRepository, type BotApiKeyRow } from "./bot-api-key-repository"

afterEach(() => mock.restore())

function keyRow(overrides: Partial<BotApiKeyRow>): BotApiKeyRow {
  return {
    id: "bak_other",
    workspaceId: "ws_other",
    botId: "bot_other",
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

describe("BotApiKeyService.validateKey", () => {
  test("should touch last_used_at in the matched key's workspace when another workspace's key shares the prefix", async () => {
    const value = `${BOT_KEY_PREFIX}abcdefgh-secret`
    const matched = keyRow({
      id: "bak_matched",
      workspaceId: "ws_matched",
      botId: "bot_matched",
      keyHash: createHash("sha256").update(value).digest("hex"),
    })
    spyOn(BotApiKeyRepository, "findActiveByPrefix").mockResolvedValue([keyRow({}), matched])
    const touch = spyOn(BotApiKeyRepository, "touchLastUsed").mockResolvedValue(undefined)
    const pool = {} as Pool

    const validated = await new BotApiKeyService(pool).validateKey(value)

    expect({ id: validated?.id, workspaceId: validated?.workspaceId, botId: validated?.botId }).toEqual({
      id: "bak_matched",
      workspaceId: "ws_matched",
      botId: "bot_matched",
    })
    expect(touch.mock.calls).toEqual([[pool, "ws_matched", "bak_matched"]])
  })
})
