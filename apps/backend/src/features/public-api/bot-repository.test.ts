import { describe, expect, test, mock } from "bun:test"
import { BotRepository, serializeBot, type Bot } from "./bot-repository"
import type { Querier } from "../../db"

function makeCapturingDb(rows: Record<string, unknown>[] = []) {
  const query = mock((_config: unknown) => Promise.resolve({ rows, rowCount: rows.length }))
  return { db: { query } as unknown as Querier, query }
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot_1",
    workspaceId: "ws_1",
    apiKeyId: null,
    type: "personal",
    ownerUserId: "usr_owner",
    readsAsOwner: false,
    traits: [],
    slug: "helper",
    name: "Helper",
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    archivedAt: null,
    createdAt: new Date("2026-07-13T10:00:00Z"),
    updatedAt: new Date("2026-07-13T11:00:00Z"),
    ...overrides,
  } as Bot
}

describe("serializeBot", () => {
  test("serializes a personal bot with ISO dates and its owner", () => {
    expect(serializeBot(makeBot())).toEqual({
      id: "bot_1",
      workspaceId: "ws_1",
      type: "personal",
      ownerUserId: "usr_owner",
      readsAsOwner: false,
      traits: [],
      slug: "helper",
      name: "Helper",
      description: null,
      avatarEmoji: null,
      avatarUrl: null,
      archivedAt: null,
      createdAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T11:00:00.000Z",
    })
  })

  test("serializes a shared bot with a null owner", () => {
    const bot = makeBot({ type: "shared", ownerUserId: null } as Partial<Bot>)
    expect(serializeBot(bot)).toMatchObject({ type: "shared", ownerUserId: null })
  })
})

// Visibility and invocability are deliberately different rules (Kris's
// ruling, 2026-07-13): anyone who can read a stream SEES a granted personal
// bot, but only its owner INVOKES it — personal bots execute on the owner's
// machine. These are smoke tests over the emitted SQL, not Postgres
// evaluation (no live DB in this suite).
describe("BotRepository.listVisibleTo", () => {
  test("admits personal bots via stream grants the viewer can read", async () => {
    const { db, query } = makeCapturingDb()
    await BotRepository.listVisibleTo(db, "ws_1", "usr_viewer")

    const config = query.mock.calls[0]?.[0] as { text: string; values: unknown[] }
    expect(config.text).toContain("owner_user_id =")
    expect(config.text).toContain("bot_channel_access")
    // The grant leg routes through the canonical INV-62 access predicate
    // (thread → root, public root readable without membership).
    expect(config.text).toContain("stream_members")
    expect(config.values).toContain("usr_viewer")
  })
})

describe("BotRepository.findInvocableByIds", () => {
  test("gates on ownership only — a stream grant must never widen who can invoke", async () => {
    const { db, query } = makeCapturingDb()
    await BotRepository.findInvocableByIds(db, "ws_1", "usr_author", ["bot_1"])

    const config = query.mock.calls[0]?.[0] as { text: string; values: unknown[] }
    expect(config.text).toContain("owner_user_id =")
    expect(config.text).not.toContain("bot_channel_access")
    expect(config.values).toContain("usr_author")
  })
})
