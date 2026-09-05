import { describe, expect, mock, spyOn, test } from "bun:test"
import type { FeatureFlagValue } from "@threa/types"
import { createGetStreamMessagesTool, createSearchMessagesTool, createSearchStreamsTool } from "./search-workspace-tool"
import type { WorkspaceToolDeps } from "./tool-deps"
import { MessageRepository, type Message } from "../../messaging"
import { StreamRepository, type Stream } from "../../streams"
import { UserRepository } from "../../workspaces"
import { PersonaRepository } from "../persona-repository"

function makeTool(searchFlag: FeatureFlagValue<"search">) {
  const search = mock(async () => ({ results: [], conversations: [], excludedE2eStreamCount: 0 }))
  const tool = createSearchMessagesTool({
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "ws_1",
    accessibleStreamIds: ["stream_1"],
    invokingUserId: "usr_1",
    searchFlag,
    searchService: { search } as unknown as WorkspaceToolDeps["searchService"],
    storage: {} as WorkspaceToolDeps["storage"],
    attachmentService: {} as WorkspaceToolDeps["attachmentService"],
    memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
  })
  return { tool, search }
}

function makeDeps(searchFlag: FeatureFlagValue<"search">, searchService?: unknown): WorkspaceToolDeps {
  return {
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "ws_1",
    accessibleStreamIds: ["stream_1", "stream_2"],
    invokingUserId: "usr_1",
    searchFlag,
    searchService: (searchService ?? {
      search: async () => ({ results: [], conversations: [], excludedE2eStreamCount: 0 }),
    }) as WorkspaceToolDeps["searchService"],
    storage: {} as WorkspaceToolDeps["storage"],
    attachmentService: {} as WorkspaceToolDeps["attachmentService"],
    memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
  }
}

describe("search_messages under the search flag", () => {
  test("off: searches without deep, forwards the flag and omits conversations from the output", async () => {
    const { tool, search } = makeTool("off")

    const result = await tool.config.execute({ query: "railway deploy", exact: false }, { toolCallId: "t1" })

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "railway deploy", deep: false, searchFlag: "off" })
    )
    expect(JSON.parse(result.output)).toEqual({
      query: "railway deploy",
      exact: false,
      results: [],
      message: "No matching messages found",
    })
  })

  test("on: searches deep and reports an empty conversations group", async () => {
    const { tool, search } = makeTool("on")

    const result = await tool.config.execute({ query: "railway deploy", exact: false }, { toolCallId: "t1" })

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ deep: true, searchFlag: "on" }))
    expect(JSON.parse(result.output)).toEqual({
      query: "railway deploy",
      exact: false,
      results: [],
      conversations: [],
      message: "No matching messages found",
    })
  })
})

describe("search_messages carries ready-to-use links", () => {
  test("each result includes streamId, authorId, authorType and a message URL; conversations get streamId + URL", async () => {
    const createdAt = new Date("2026-07-01T10:00:00Z")
    const repoSpies = [
      spyOn(StreamRepository, "findByIds").mockResolvedValue([
        { id: "stream_1", type: "channel", displayName: "General", slug: "general" } as Stream,
      ]),
      spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", name: "Kris" } as never]),
      spyOn(PersonaRepository, "findByIds").mockResolvedValue([] as never),
    ]
    const search = mock(async () => ({
      results: [
        {
          id: "msg_1",
          streamId: "stream_1",
          content: "We use Bun",
          authorId: "usr_1",
          authorType: "user",
          createdAt,
        },
      ],
      conversations: [
        {
          id: "conv_1",
          streamId: "stream_1",
          topicSummary: "Bun adoption",
          summary: null,
          messageCount: 3,
          firstMessageId: "msg_1",
          firstMessageAt: createdAt,
          lastMessageAt: createdAt,
        },
      ],
      excludedE2eStreamCount: 0,
    }))
    const tool = createSearchMessagesTool(makeDeps("on", { search }))

    try {
      const result = await tool.config.execute({ query: "bun", exact: false }, { toolCallId: "t1" })
      const output = JSON.parse(result.output)
      expect(output.results[0]).toMatchObject({
        id: "msg_1",
        streamId: "stream_1",
        authorId: "usr_1",
        authorType: "user",
        url: "/w/ws_1/s/stream_1?m=msg_1",
      })
      expect(output.conversations[0]).toMatchObject({
        streamId: "stream_1",
        url: "/w/ws_1/s/stream_1?m=msg_1",
      })
    } finally {
      repoSpies.forEach((spy) => spy.mockRestore())
    }
  })
})

describe("search_streams and get_stream_messages carry URLs", () => {
  test("search_streams results include a stream URL", async () => {
    const searchByName = spyOn(StreamRepository, "searchByName").mockResolvedValue([
      { id: "stream_2", type: "channel", displayName: "Deploys", slug: "deploys", description: null } as Stream,
    ])
    const dmPeers = spyOn(StreamRepository, "listDmPeersForMember").mockResolvedValue([] as never)
    const tool = createSearchStreamsTool(makeDeps("off"))
    try {
      const result = await tool.config.execute({ query: "deploys" }, { toolCallId: "t1" })
      expect(JSON.parse(result.output).results[0]).toMatchObject({
        id: "stream_2",
        url: "/w/ws_1/s/stream_2",
      })
    } finally {
      searchByName.mockRestore()
      dmPeers.mockRestore()
    }
  })

  test("get_stream_messages resolves canonical stream metadata and per-message URLs", async () => {
    const createdAt = new Date("2026-07-01T10:00:00Z")
    const message = {
      id: "msg_1",
      contentMarkdown: "hello",
      authorType: "user",
      authorId: "usr_1",
      createdAt,
    } as unknown as Message
    const list = spyOn(MessageRepository, "list").mockResolvedValue([message])
    const streams = spyOn(StreamRepository, "findByIdsInWorkspace").mockResolvedValue([
      { id: "stream_1", type: "channel", displayName: "General", slug: "general" } as Stream,
    ])
    const users = spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", name: "Kris" } as never])
    const personas = spyOn(PersonaRepository, "findByIds").mockResolvedValue([] as never)
    const tool = createGetStreamMessagesTool(makeDeps("off"))
    try {
      const result = await tool.config.execute({ stream: "stream_1", limit: 10 }, { toolCallId: "t1" })
      const output = JSON.parse(result.output)
      expect(output).toMatchObject({
        stream: "stream_1",
        streamId: "stream_1",
        streamName: "General",
        url: "/w/ws_1/s/stream_1",
      })
      expect(output.messages[0]).toMatchObject({
        id: "msg_1",
        url: "/w/ws_1/s/stream_1?m=msg_1",
      })
    } finally {
      ;[list, streams, users, personas].forEach((spy) => spy.mockRestore())
    }
  })
})
