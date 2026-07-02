import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { InviteCommand } from "./invite-command"
import { StreamRepository } from "../streams"
import { UserRepository } from "../workspaces"
import { BotRepository } from "../public-api"
import type { CommandContext } from "./registry"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const ACTOR_ID = "usr_actor"

const channel = { id: STREAM_ID, workspaceId: WORKSPACE_ID, type: "channel" } as any
const admin = { id: ACTOR_ID, role: "admin" } as any
const alice = { id: "usr_alice", slug: "alice", name: "Alice" } as any
const testBot = { id: "bot_test", slug: "test-bot", name: "TestBot", archivedAt: null } as any

function makeCommand(streamService: { addMember?: any; addBotToStream?: any } = {}) {
  return new InviteCommand({
    pool: {} as any,
    streamService: {
      addMember: streamService.addMember ?? mock(async () => {}),
      addBotToStream: streamService.addBotToStream ?? mock(async () => {}),
    } as any,
  })
}

function ctx(args: string): CommandContext {
  return { workspaceId: WORKSPACE_ID, streamId: STREAM_ID, userId: ACTOR_ID, args } as CommandContext
}

function setupRepos({ usersById = [], botsById = [], usersBySlug = [], botsBySlug = [] }: any) {
  spyOn(StreamRepository, "findById").mockResolvedValue(channel)
  spyOn(UserRepository, "findById").mockResolvedValue(admin)
  spyOn(UserRepository, "findByIds").mockResolvedValue(usersById)
  spyOn(BotRepository, "findByIds").mockResolvedValue(botsById)
  spyOn(UserRepository, "findBySlugs").mockResolvedValue(usersBySlug)
  spyOn(BotRepository, "findBySlugs").mockResolvedValue(botsBySlug)
}

describe("InviteCommand mention parsing (INV-64)", () => {
  afterEach(() => mock.restore())

  it("invites a bot from the resolved pointer form the composer sends", async () => {
    setupRepos({ botsById: [testBot] })
    const addBotToStream = mock(async () => {})
    const command = makeCommand({ addBotToStream })

    const result = await command.execute(ctx("[@test-bot](bot:bot_test)"))

    expect(result).toEqual({
      success: true,
      result: { invited: [{ name: "TestBot", slug: "test-bot", type: "bot" }] },
    })
    expect(addBotToStream).toHaveBeenCalledWith(STREAM_ID, "bot_test", WORKSPACE_ID, ACTOR_ID)
  })

  it("invites a user from the resolved pointer form by id, not slug", async () => {
    setupRepos({ usersById: [alice] })
    const addMember = mock(async () => {})
    const command = makeCommand({ addMember })

    const result = await command.execute(ctx("[@alice](user:usr_alice)"))

    expect(result).toEqual({
      success: true,
      result: { invited: [{ name: "Alice", slug: "alice", type: "user" }] },
    })
    expect(addMember).toHaveBeenCalledWith(STREAM_ID, "usr_alice", WORKSPACE_ID, ACTOR_ID)
    expect(UserRepository.findBySlugs).not.toHaveBeenCalled()
  })

  it("still accepts bare @slug as lenient input", async () => {
    setupRepos({ usersBySlug: [alice] })
    const command = makeCommand()

    const result = await command.execute(ctx("@alice"))

    expect(result).toEqual({
      success: true,
      result: { invited: [{ name: "Alice", slug: "alice", type: "user" }] },
    })
  })

  it("handles a mix of pointer and bare mentions, deduping the same actor", async () => {
    setupRepos({ usersById: [alice], usersBySlug: [alice], botsById: [testBot] })
    const addMember = mock(async () => {})
    const command = makeCommand({ addMember })

    const result = await command.execute(ctx("[@alice](user:usr_alice) @alice [@test-bot](bot:bot_test)"))

    expect(result.success).toBe(true)
    expect(addMember).toHaveBeenCalledTimes(1)
  })

  it("reports non-invitable pointer kinds (persona, broadcast) as unknown", async () => {
    setupRepos({ usersById: [alice] })
    const command = makeCommand()

    const result = await command.execute(ctx("[@alice](user:usr_alice) [@ariadne](persona:persona_x) [@here](broadcast:here)"))

    expect(result).toEqual({
      success: true,
      result: {
        invited: [{ name: "Alice", slug: "alice", type: "user" }],
        unknown: ["@ariadne", "@here"],
      },
    })
  })

  it("fails with usage when no mentions are present", async () => {
    const command = makeCommand()
    const result = await command.execute(ctx("nobody here"))
    expect(result.success).toBe(false)
  })

  it("treats a pointer to an archived bot as unknown", async () => {
    setupRepos({ usersById: [alice], botsById: [{ ...testBot, archivedAt: new Date() }] })
    const command = makeCommand()

    const result = await command.execute(ctx("[@alice](user:usr_alice) [@test-bot](bot:bot_test)"))

    expect(result).toEqual({
      success: true,
      result: {
        invited: [{ name: "Alice", slug: "alice", type: "user" }],
        unknown: ["@test-bot"],
      },
    })
  })

  it("requires bots:manage for pointer-form bot invites", async () => {
    setupRepos({ botsById: [testBot] })
    spyOn(UserRepository, "findById").mockResolvedValue({ id: ACTOR_ID, role: "member" } as any)
    const command = makeCommand()

    const result = await command.execute(ctx("[@test-bot](bot:bot_test)"))

    expect(result).toEqual({ success: false, error: "Insufficient permissions to invite bots" })
  })
})
