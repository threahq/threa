import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { StreamTypes } from "@threa/types"
import { StreamBriefRepository, type StreamBrief } from "../../streams"
import { buildAgentContext } from "./context"
import type { Persona } from "../persona-repository"

const persona: Persona = {
  id: "persona_1",
  workspaceId: null,
  slug: "ariadne",
  name: "Ariadne",
  description: null,
  avatarEmoji: null,
  systemPrompt: "Base system prompt",
  model: "openrouter:anthropic/claude-sonnet-4.6",
  escalationModel: null,
  temperature: 0,
  maxTokens: null,
  enabledTools: [],
  managedBy: "system",
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

    const prompt = context.composeSystemPrompt([], { kind: "catch_up" })
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

    expect(context.composeSystemPrompt([], { kind: "catch_up" })).not.toContain("## Stream Brief")
  })
})
