import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AgentToolNames, DEFAULT_USER_PREFERENCES, MemoryModes, StreamTypes } from "@threahq/types"
import { StreamBriefRepository, StreamRepository, type StreamBrief } from "../../streams"
import { MessageRepository } from "../../messaging"
import { UserDeviceContextRepository } from "../../device-context"
import { buildAgentContext } from "./context"
import type { PreparedRecallParams } from "./prepared-recall"
import type { Persona } from "../persona-repository"
import { PersonaAttachmentRepository } from "../persona-attachment-repository"
import { joinSystemPrompt } from "./prompt/system-prompt"
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
      { ...deps, preparedRecall: { recall } as never },
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

    expect({
      query: recall.mock.calls[0]?.[0],
      volatile: context.composeSystemPrompt([], { kind: "catch_up" }).volatile,
      recalled: context.recalledMemos.map((m) => m.id),
    }).toEqual({
      query: expect.objectContaining({ invokingUserId: "usr_1", query: "What should I bring to the picnic?" }),
      volatile: expect.stringMatching(/## Recalled from memory[\s\S]*<memo id="memo_allergy"/),
      recalled: ["memo_allergy"],
    })
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
    spyOn(StreamRepository, "findByIdForWorkspace").mockImplementation(async (_db, streamId) =>
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
