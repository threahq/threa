import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as memosModule from "../../memos"
import { AgentToolNames, DEFAULT_USER_PREFERENCES, MemoryModes, StreamTypes, Visibilities } from "@threahq/types"
import { StreamBriefRepository, StreamMemberRepository, StreamRepository, type StreamBrief } from "../../streams"
import { MessageRepository } from "../../messaging"
import { UserDeviceContextRepository } from "../../device-context"
import { UserRepository } from "../../workspaces"
import { buildAgentContext } from "./context"
import type { PreparedRecallParams } from "./prepared-recall"
import type { Persona } from "../persona-repository"
import { PersonaAttachmentRepository } from "../persona-attachment-repository"
import { AgentSessionRepository } from "../session-repository"
import { SearchRepository } from "../../search"
import { joinSystemPrompt } from "./prompt/system-prompt"
import * as episodeSummaries from "./episode-summaries"
import * as turnDigests from "./turn-digests"
import * as contextBuilder from "../context-builder"

const persona: Persona = {
  id: "persona_1",
  workspaceId: null,
  slug: "ariadne",
  name: "Ariadne",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  systemPrompt: "Base system prompt",
  model: "openrouter:anthropic/claude-sonnet-4.6",
  escalationModel: null,
  temperature: 0,
  maxTokens: null,
  enabledTools: [],
  tonePreset: null,
  brevityPreset: null,
  tonePrompt: null,
  brevityPrompt: null,
  managedBy: "system",
  ownerUserId: null,
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}

/** Every unstubbed repository read sees an empty database. */
const emptyDb = { query: async () => ({ rows: [], rowCount: 0 }) } as never

beforeEach(() => {
  spyOn(memosModule, "audienceBrowses").mockResolvedValue(true)
})

const deps = {
  db: emptyDb,
  userPreferencesService: { getPreferences: mock(async () => undefined) } as never,
  conversationSummaryService: { updateForContext: mock(async () => null) } as never,
  preparedRecall: { recall: mock(async () => ({ outcome: "nothing_relevant", memos: [] })) } as never,
}

function fakeBrief(streamId: string): StreamBrief {
  return {
    id: "sbrf_01",
    workspaceId: "ws_1",
    streamId,
    content: "Root brief: prefer Bun over Node",
    version: 2,
    updatedByKind: "user",
    updatedById: "usr_1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-05T00:00:00Z"),
  }
}

describe("buildAgentContext stream brief (roadmap 4.1)", () => {
  afterEach(() => mock.restore())

  it("loads a thread turn's brief off the ROOT stream and injects it into the system prompt (INV-62 thread → root)", async () => {
    const findByStreamId = spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(fakeBrief("stream_root"))

    const thread = {
      id: "stream_thread",
      workspaceId: "ws_1",
      type: StreamTypes.THREAD,
      rootStreamId: "stream_root",
      parentStreamId: "stream_root",
      displayName: "A thread",
      createdBy: "usr_1",
    } as never

    const context = await buildAgentContext(deps, {
      workspaceId: "ws_1",
      streamId: "stream_thread",
      stream: thread,
      messageId: "msg_1",
      persona,
      purpose: { kind: "catch_up" },
      policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
    })

    expect(findByStreamId.mock.calls.at(-1)?.slice(1)).toEqual(["ws_1", "stream_root"])

    const prompt = joinSystemPrompt(context.composeSystemPrompt([], { kind: "catch_up" }))
    expect(prompt).toContain("## Stream Brief")
    expect(prompt).toContain("Root brief: prefer Bun over Node")
  })

  it("omits the section when the stream has no brief", async () => {
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(null)

    const scratchpad = {
      id: "stream_pad",
      workspaceId: "ws_1",
      type: StreamTypes.SCRATCHPAD,
      rootStreamId: null,
      parentStreamId: null,
      displayName: "Pad",
      createdBy: "usr_1",
    } as never

    const context = await buildAgentContext(deps, {
      workspaceId: "ws_1",
      streamId: "stream_pad",
      stream: scratchpad,
      messageId: "msg_1",
      persona,
      purpose: { kind: "catch_up" },
      policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
    })

    expect(joinSystemPrompt(context.composeSystemPrompt([], { kind: "catch_up" }))).not.toContain("## Stream Brief")
  })
})

describe("buildAgentContext prepared recall", () => {
  afterEach(() => mock.restore())

  it("recalls against the invoking user's message and puts the memos the window doesn't carry in the volatile prompt", async () => {
    const trigger = {
      id: "msg_1",
      streamId: "stream_pad",
      authorType: "user",
      authorId: "usr_1",
      contentMarkdown: "What should I bring to the picnic?",
      contentJson: { type: "doc", content: [] },
      createdAt: new Date("2026-10-01T10:00:00Z"),
      reactions: {},
    }
    spyOn(MessageRepository, "findById").mockResolvedValue(trigger as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Alice Ek", timezone: "America/New_York" } as never)
    const buildStreamContext = contextBuilder.buildStreamContext
    spyOn(contextBuilder, "buildStreamContext").mockImplementation(async (...args) => ({
      ...(await buildStreamContext(...args)),
      conversationHistory: [trigger as never],
    }))
    const memo = (id: string, sourceMessageId: string) => ({
      id,
      title: id,
      abstract: `${id} abstract`,
      knowledgeType: "context" as const,
      sourceMessageIds: [sourceMessageId],
      createdAt: new Date("2026-09-30T10:00:00Z"),
      score: 1,
    })
    const recall = mock(async (_params: PreparedRecallParams) => ({
      outcome: "recalled" as const,
      memos: [memo("memo_allergy", "msg_elsewhere"), memo("memo_picnic", "msg_1")],
    }))

    const context = await buildAgentContext(
      {
        ...deps,
        preparedRecall: { recall } as never,
        userPreferencesService: { getPreferences: async () => ({ timezone: "Europe/Stockholm" }) } as never,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_pad",
        stream: {
          id: "stream_pad",
          workspaceId: "ws_1",
          type: StreamTypes.SCRATCHPAD,
          rootStreamId: null,
          parentStreamId: null,
          displayName: "Pad",
          createdBy: "usr_1",
        } as never,
        messageId: "msg_1",
        currentTime: new Date("2026-10-08T09:00:00Z"),
        persona,
        purpose: { kind: "catch_up" },
        policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
      }
    )

    expect({
      query: recall.mock.calls[0]?.[0],
      volatile: context.composeSystemPrompt([], { kind: "catch_up" }).volatile,
      recalled: context.recalledMemos.map((m) => m.id),
    }).toEqual({
      query: expect.objectContaining({
        invokingUserId: "usr_1",
        query: "What should I bring to the picnic?",
        asker: { name: "Alice Ek", askedAt: new Date("2026-10-08T09:00:00Z"), timezone: "America/New_York" },
      }),
      volatile: expect.stringMatching(/## Recalled from memory[\s\S]*<memo id="memo_allergy"/),
      recalled: ["memo_allergy"],
    })
  })
})

describe("buildAgentContext prepared recall audience", () => {
  afterEach(() => mock.restore())

  it("should recall for the audience the stream's access spec names when the turn runs in an aside, a DM or a channel", async () => {
    const trigger = {
      id: "msg_1",
      streamId: "stream_x",
      authorType: "user",
      authorId: "usr_1",
      contentMarkdown: "What did we decide?",
      contentJson: { type: "doc", content: [] },
      createdAt: new Date("2026-10-01T10:00:00Z"),
      reactions: {},
    }
    spyOn(MessageRepository, "findById").mockResolvedValue(trigger as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Alice Ek", timezone: null } as never)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([{ memberId: "usr_1" }, { memberId: "usr_2" }] as never)

    const recalledAudienceIn = async (stream: { id: string; type: string; visibility: string }) => {
      const recall = mock(async (_params: PreparedRecallParams) => ({
        outcome: "nothing_relevant" as const,
        memos: [],
      }))
      await buildAgentContext(
        { ...deps, preparedRecall: { recall } as never },
        {
          workspaceId: "ws_1",
          streamId: stream.id,
          stream: {
            ...stream,
            workspaceId: "ws_1",
            rootStreamId: null,
            parentStreamId: null,
            createdBy: "usr_1",
          } as never,
          messageId: "msg_1",
          persona,
          purpose: { kind: "catch_up" },
          policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
        }
      )
      return recall.mock.calls[0]?.[0].memoAudience
    }

    expect({
      aside: await recalledAudienceIn({
        id: "stream_aside",
        type: StreamTypes.ASIDE,
        visibility: Visibilities.PRIVATE,
      }),
      dm: await recalledAudienceIn({ id: "stream_dm", type: StreamTypes.DM, visibility: Visibilities.PRIVATE }),
      channel: await recalledAudienceIn({
        id: "stream_channel",
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
      }),
    }).toEqual({
      aside: { kind: "users", userIds: ["usr_1"] },
      dm: { kind: "users", userIds: ["usr_1", "usr_2"] },
      channel: { kind: "room", roomStreamId: "stream_channel" },
    })
  })
})

describe("buildAgentContext memo browse flag", () => {
  afterEach(() => mock.restore())

  const buildFor = (streamId: string, rootStreamId: string | null, audienceBrowses: boolean, carryDigests: boolean) => {
    const audienceBrowsesSpy = spyOn(memosModule, "audienceBrowses").mockResolvedValue(audienceBrowses)
    const stream = {
      id: streamId,
      workspaceId: "ws_1",
      type: rootStreamId ? StreamTypes.THREAD : StreamTypes.CHANNEL,
      rootStreamId,
      parentStreamId: rootStreamId,
      displayName: "Room",
      createdBy: "usr_1",
    }
    return {
      audienceBrowsesSpy,
      build: () =>
        buildAgentContext(deps, {
          workspaceId: "ws_1",
          streamId,
          stream: stream as never,
          messageId: "msg_1",
          persona,
          purpose: { kind: "catch_up" },
          policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests },
        }),
    }
  }

  it("should measure the room's reach, the thread's root for a thread, when no one invoked the turn", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_root", rootStreamId: null } as never)
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(null)

    const measure = async (streamId: string, rootStreamId: string | null) => {
      const { audienceBrowsesSpy, build } = buildFor(streamId, rootStreamId, false, false)
      audienceBrowsesSpy.mockClear()
      const context = await build()
      return {
        calls: audienceBrowsesSpy.mock.calls.map(([, workspaceId, audience]) => ({ workspaceId, audience })),
        context: { browses: context.memoAudienceBrowses, audience: context.memoBrowseAudience },
      }
    }

    expect({
      channel: await measure("stream_channel", null),
      thread: await measure("stream_thread", "stream_root"),
    }).toEqual({
      channel: {
        calls: [{ workspaceId: "ws_1", audience: { kind: "room", roomStreamId: "stream_channel" } }],
        context: { browses: false, audience: { kind: "room", roomStreamId: "stream_channel" } },
      },
      thread: {
        calls: [{ workspaceId: "ws_1", audience: { kind: "room", roomStreamId: "stream_root" } }],
        context: { browses: false, audience: { kind: "room", roomStreamId: "stream_root" } },
      },
    })
  })

  it("should hand the measured flag, not a constant, to the episode summary and turn digest loaders", async () => {
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(null)
    const loaded = { text: null, sourceStreamIds: [] }
    const summaries = spyOn(episodeSummaries, "loadEpisodeSummaryPromptBlock").mockResolvedValue(loaded)
    const digests = spyOn(turnDigests, "loadTurnDigestPromptBlock").mockResolvedValue(loaded)

    const flagsFor = async (audienceBrowses: boolean) => {
      summaries.mockClear()
      digests.mockClear()
      await buildFor("stream_channel", null, audienceBrowses, true).build()
      return {
        summaries: summaries.mock.calls.map(([, params]) => params.memoAudienceBrowses),
        digests: digests.mock.calls.map(([, params]) => params.memoAudienceBrowses),
      }
    }

    expect({ browsing: await flagsFor(true), notBrowsing: await flagsFor(false) }).toEqual({
      browsing: { summaries: [true], digests: [true] },
      notBrowsing: { summaries: [false], digests: [false] },
    })
  })
})

describe("buildAgentContext carried source streams", () => {
  afterEach(() => mock.restore())

  it("should report the source streams of the summaries, and of the digests only, when the policy carries digests", async () => {
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_pad",
      authorType: "user",
      authorId: "usr_1",
      contentMarkdown: "Continue",
      contentJson: { type: "doc", content: [] },
      createdAt: new Date("2026-10-01T10:00:00Z"),
      reactions: {},
    } as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Alice Ek", timezone: "Europe/Stockholm" } as never)
    spyOn(SearchRepository, "getAccessibleStreamsForAgent").mockResolvedValue([
      "stream_pad",
      "stream_summary",
      "stream_digest",
    ])
    const digestContent = (sourceStreamIds: string[]) =>
      JSON.stringify({ findings: "f", toolsCalled: [], sources: [], sourceStreamIds })
    spyOn(AgentSessionRepository, "findRecentEpisodeSummariesByStream").mockResolvedValue([
      {
        summary: "Read the summary stream.",
        sessionCreatedAt: new Date("2026-10-01T09:00:00Z"),
        sessionCompletedAt: null,
        turnDigests: [digestContent(["stream_summary"])],
      },
      {
        summary: "Read a stream the viewer lost.",
        sessionCreatedAt: new Date("2026-10-01T08:00:00Z"),
        sessionCompletedAt: null,
        turnDigests: [digestContent(["stream_revoked"])],
      },
    ])
    spyOn(AgentSessionRepository, "findRecentDigestStepsByStream").mockResolvedValue([
      {
        step: { content: digestContent(["stream_digest"]) } as never,
        sessionCreatedAt: new Date("2026-10-01T09:00:00Z"),
        sessionCompletedAt: null,
      },
    ])

    const build = (carryDigests: boolean) =>
      buildAgentContext(deps, {
        workspaceId: "ws_1",
        streamId: "stream_pad",
        stream: {
          id: "stream_pad",
          workspaceId: "ws_1",
          type: StreamTypes.SCRATCHPAD,
          rootStreamId: null,
          parentStreamId: null,
          displayName: "Pad",
          createdBy: "usr_1",
        } as never,
        messageId: "msg_1",
        persona,
        purpose: { kind: "catch_up" },
        policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests },
      })

    expect({
      carried: (await build(true)).carriedSourceStreamIds.sort(),
      withoutDigests: (await build(false)).carriedSourceStreamIds,
    }).toEqual({ carried: ["stream_digest", "stream_summary"], withoutDigests: ["stream_summary"] })
  })
})

describe("buildAgentContext device context", () => {
  afterEach(() => mock.restore())

  const phone = { layout: "mobile", os: "android", installed: true } as const

  async function volatilePrompt(shareDeviceWithAgents: boolean) {
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_pad",
      authorType: "user",
      authorId: "usr_1",
      contentMarkdown: "Where do I change my theme?",
      contentJson: { type: "doc", content: [] },
      createdAt: new Date("2026-10-01T10:00:00Z"),
      reactions: {},
    } as never)
    const getPreferences = mock(async () => ({ ...DEFAULT_USER_PREFERENCES, shareDeviceWithAgents }) as never)
    const context = await buildAgentContext(
      { ...deps, userPreferencesService: { getPreferences } as never },
      {
        workspaceId: "ws_1",
        streamId: "stream_pad",
        stream: {
          id: "stream_pad",
          workspaceId: "ws_1",
          type: StreamTypes.SCRATCHPAD,
          rootStreamId: null,
          parentStreamId: null,
          displayName: "Pad",
          createdBy: "usr_1",
        } as never,
        messageId: "msg_1",
        persona,
        purpose: { kind: "catch_up" },
        policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
      }
    )
    return context.composeSystemPrompt([], { kind: "catch_up" }).volatile
  }

  it("tells the model the invoking user's layout, OS and install state when they share it", async () => {
    const find = spyOn(UserDeviceContextRepository, "find").mockResolvedValue(phone)

    const volatile = await volatilePrompt(true)

    expect(find.mock.calls.at(-1)?.slice(1)).toEqual(["ws_1", "usr_1"])
    expect(volatile).toContain("using Threa's mobile layout on Android, as an installed app")
  })

  it("neither reads nor renders the device once sharing is off", async () => {
    const find = spyOn(UserDeviceContextRepository, "find").mockResolvedValue(phone)

    const volatile = await volatilePrompt(false)

    expect(find).not.toHaveBeenCalled()
    expect(volatile).not.toContain("## Device")
  })

  it("omits the section when the user has reported no device", async () => {
    spyOn(UserDeviceContextRepository, "find").mockResolvedValue(null)

    expect(await volatilePrompt(true)).not.toContain("## Device")
  })
})

describe("buildAgentContext people viewer", () => {
  afterEach(() => mock.restore())

  it("should scope people reads to the invoker in a solo private scratchpad and to the room in a channel", async () => {
    const viewerIn = async (stream: { id: string; type: string; visibility: string }) => {
      const context = await buildAgentContext(deps, {
        workspaceId: "ws_1",
        streamId: stream.id,
        stream: {
          ...stream,
          workspaceId: "ws_1",
          rootStreamId: null,
          parentStreamId: null,
          createdBy: "usr_1",
        } as never,
        messageId: "msg_1",
        invokingUserOverride: "usr_1",
        persona,
        purpose: { kind: "catch_up" },
        policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
      })
      return context.peopleViewer
    }

    expect({
      soloScratchpad: await viewerIn({
        id: "stream_pad",
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
      }),
      channel: await viewerIn({ id: "stream_channel", type: StreamTypes.CHANNEL, visibility: Visibilities.PUBLIC }),
    }).toEqual({
      soloScratchpad: { kind: "user", userId: "usr_1" },
      channel: { kind: "room", roomStreamId: "stream_channel" },
    })
  })
})

describe("buildAgentContext persona knowledge (context attachments, decision 7)", () => {
  afterEach(() => mock.restore())

  const scratchpad = {
    id: "stream_pad",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    rootStreamId: null,
    parentStreamId: null,
    displayName: "Pad",
    createdBy: "usr_1",
  } as never

  it("skips the attachment query entirely for a built-in persona (managed_by system → zero reads)", async () => {
    const listWithContent = spyOn(PersonaAttachmentRepository, "listForPersonaWithContent")

    const context = await buildAgentContext(deps, {
      workspaceId: "ws_1",
      streamId: "stream_pad",
      stream: scratchpad,
      messageId: "msg_1",
      persona, // managedBy: "system"
      purpose: { kind: "catch_up" },
      policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
    })

    expect(listWithContent).not.toHaveBeenCalled()
    expect(joinSystemPrompt(context.composeSystemPrompt([], { kind: "catch_up" }))).not.toContain("## Knowledge")
  })

  it("injects the persona's attachments in position order, resolving them by the persona id", async () => {
    const listWithContent = spyOn(PersonaAttachmentRepository, "listForPersonaWithContent").mockResolvedValue([
      {
        attachmentId: "att_1",
        filename: "guide.md",
        position: 0,
        fullText: "GUIDE CONTENT",
        summary: null,
        processingStatus: "completed",
        hasExtraction: true,
      },
      {
        attachmentId: "att_2",
        filename: "spec.txt",
        position: 1,
        fullText: null,
        summary: "SPEC SUMMARY",
        processingStatus: "completed",
        hasExtraction: true,
      },
    ])

    const customPersona: Persona = { ...persona, id: "persona_custom", managedBy: "workspace", workspaceId: "ws_1" }

    const context = await buildAgentContext(deps, {
      workspaceId: "ws_1",
      streamId: "stream_pad",
      stream: scratchpad,
      messageId: "msg_1",
      persona: customPersona,
      purpose: { kind: "catch_up" },
      policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
    })

    // A draft-test turn shares the SAVED persona id, so loading by persona.id
    // here resolves the saved attachments with no special-casing (decision 7).
    expect(listWithContent.mock.calls.at(-1)?.slice(1)).toEqual(["ws_1", "persona_custom"])

    const prompt = joinSystemPrompt(context.composeSystemPrompt([], { kind: "catch_up" }))
    expect(prompt).toContain("## Knowledge")
    expect(prompt).toContain("### guide.md\n\nGUIDE CONTENT")
    expect(prompt).toContain("### spec.txt\n\nSPEC SUMMARY")
    expect(prompt.indexOf("### guide.md")).toBeLessThan(prompt.indexOf("### spec.txt"))
  })

  it("should leave the persona's attachments home when another workspace reads the room", async () => {
    const listWithContent = spyOn(PersonaAttachmentRepository, "listForPersonaWithContent")
    const sharedRoomDb = {
      query: async (config: { text: string }) =>
        config.text.includes("AS shared") ? { rows: [{ shared: true }], rowCount: 1 } : { rows: [], rowCount: 0 },
    } as never
    const sharedChannel = {
      id: "stream_shared",
      workspaceId: "ws_1",
      type: StreamTypes.CHANNEL,
      visibility: Visibilities.PUBLIC,
      rootStreamId: null,
      parentStreamId: null,
      displayName: "Launch",
      createdBy: "usr_1",
    } as never

    const context = await buildAgentContext(
      { ...deps, db: sharedRoomDb },
      {
        workspaceId: "ws_1",
        streamId: "stream_shared",
        stream: sharedChannel,
        messageId: "msg_1",
        persona: { ...persona, id: "persona_custom", managedBy: "workspace", workspaceId: "ws_1" },
        purpose: { kind: "catch_up" },
        policy: { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false },
      }
    )

    expect({
      roomShared: context.roomShared,
      attachmentsListed: listWithContent.mock.calls.length,
      knowledgeInPrompt: joinSystemPrompt(context.composeSystemPrompt([], { kind: "catch_up" })).includes(
        "## Knowledge"
      ),
    }).toEqual({ roomShared: true, attachmentsListed: 0, knowledgeInPrompt: false })
  })
})

describe("buildAgentContext How You Work card", () => {
  afterEach(() => mock.restore())

  const policy = { episode: { kind: "stream" }, maxMessages: 10, maxChars: 10_000, carryDigests: false } as const
  const thread = {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: StreamTypes.THREAD,
    rootStreamId: "stream_root",
    parentStreamId: "stream_root",
    displayName: "A thread",
    createdBy: "usr_1",
  }

  it("should follow the root's memory mode and the delegated model when a thread turn has no trigger", async () => {
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(null)
    spyOn(StreamRepository, "findById").mockImplementation(async (_db, _workspaceId, streamId) =>
      streamId === "stream_root"
        ? ({ id: "stream_root", rootStreamId: null, memoryMode: MemoryModes.OFF } as never)
        : (thread as never)
    )

    const context = await buildAgentContext(deps, {
      workspaceId: "ws_1",
      streamId: "stream_thread",
      stream: thread as never,
      messageId: "msg_1",
      persona,
      purpose: { kind: "catch_up" },
      policy,
      subagentModel: "openrouter:anthropic/claude-opus-5-5",
    })

    const prompt = joinSystemPrompt(context.composeSystemPrompt([], { kind: "catch_up" }))
    expect(prompt).toContain("In this thread you run on `openrouter:anthropic/claude-opus-5-5`")
    expect(prompt).toContain("No one triggered this turn")
    expect(prompt).toContain("Memory capture is off here")
  })

  it("should list the capabilities of the toolset the turn was composed with", async () => {
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(null)
    const scratchpad = {
      ...thread,
      id: "stream_pad",
      type: StreamTypes.SCRATCHPAD,
      rootStreamId: null,
      parentStreamId: null,
    }

    const context = await buildAgentContext(deps, {
      workspaceId: "ws_1",
      streamId: "stream_pad",
      stream: scratchpad as never,
      messageId: "msg_1",
      persona,
      purpose: { kind: "catch_up" },
      policy,
    })

    const prompt = joinSystemPrompt(
      context.composeSystemPrompt([{ name: AgentToolNames.WEB_SEARCH, config: {} }] as never, { kind: "catch_up" })
    )
    expect(prompt).toContain("What you can do:\n- Search the web.\n\n")
  })
})
