import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AuthorTypes, CompanionModes, StreamTypes } from "@threa/types"
import type { ProcessResult } from "@threa/backend-common"
import * as cursorLockModule from "@threa/backend-common"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { CompanionHandler } from "./companion-outbox-handler"
import { PersonaRepository } from "./persona-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { AgentSessionRepository } from "./session-repository"
import { SubagentRunRepository } from "../subagents"

function makeFakeCursorLock(onRun?: (result: ProcessResult) => void) {
  return () => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      const result = await processor(0n, [])
      onRun?.(result)
    }),
  })
}

function mockCursorLock(onRun?: (result: ProcessResult) => void) {
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(makeFakeCursorLock(onRun))
}

function makeStream(overrides: Partial<Record<string, any>>): any {
  return {
    id: "stream_x",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    ...overrides,
  }
}

const activePersona = {
  id: "persona_scratchpad",
  status: "active",
} as any

function mockUserMessageEvent(streamId: string, metadata: Record<string, string> = {}) {
  spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
    {
      id: 1n,
      eventType: "message:created",
      payload: {
        workspaceId: "ws_1",
        streamId,
        event: {
          actorId: "usr_author",
          actorType: AuthorTypes.USER,
          sequence: 5,
          payload: {
            messageId: "msg_1",
            metadata,
          },
        },
      },
      createdAt: new Date("2026-02-19T12:00:00.000Z"),
    } as any,
  ])
}

function createHandler() {
  mockCursorLock()

  const jobQueue = {
    send: mock(async () => "queue_1"),
  } as any

  const handler = new CompanionHandler({} as any, jobQueue)
  return { handler, jobQueue }
}

async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/** A thread hanging off a channel — a surface with no companion mode of its own. */
function makeChannelThread() {
  const thread = makeStream({
    id: "stream_subagent_thread",
    type: StreamTypes.THREAD,
    parentStreamId: "stream_channel_root",
    rootStreamId: "stream_channel_root",
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
  })
  const channel = makeStream({
    id: "stream_channel_root",
    type: StreamTypes.CHANNEL,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
  })
  spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
    if (id === "stream_subagent_thread") return thread
    if (id === "stream_channel_root") return channel
    return null
  })
}

describe("CompanionHandler", () => {
  beforeEach(() => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    // Default: no stream is a draft test stream. Overridden in the draft-test case.
    spyOn(PersonaConfigDraftRepository, "findByTestStreamId").mockResolvedValue(null)
    // Default: no thread hosts a live subagent, so companion mode decides.
    // Overridden in the subagent-wake cases.
    spyOn(SubagentRunRepository, "findActiveByThreadStreamId").mockResolvedValue(null)
  })

  afterEach(() => {
    mock.restore()
  })

  it("dispatches persona agent for messages in a thread whose root is a scratchpad with companion on", async () => {
    mockUserMessageEvent("stream_thread_nested")

    const thread = makeStream({
      id: "stream_thread_nested",
      type: StreamTypes.THREAD,
      parentStreamId: "stream_scratchpad_root",
      parentMessageId: "msg_parent",
      rootStreamId: "stream_scratchpad_root",
      companionMode: CompanionModes.OFF,
      companionPersonaId: null,
    })
    const rootScratchpad = makeStream({
      id: "stream_scratchpad_root",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: "persona_scratchpad",
    })

    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
      if (id === "stream_thread_nested") return thread
      if (id === "stream_scratchpad_root") return rootScratchpad
      return null
    })
    spyOn(PersonaRepository, "findById").mockResolvedValue(activePersona)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).toHaveBeenCalledWith("persona.agent", {
      workspaceId: "ws_1",
      streamId: "stream_thread_nested",
      messageId: "msg_1",
      personaId: "persona_scratchpad",
      triggeredBy: "usr_author",
    })
  })

  it("ignores the message a slash command was persisted as", async () => {
    mockUserMessageEvent("stream_scratchpad_root", { "threa.command": "spawn" })

    const rootScratchpad = makeStream({
      id: "stream_scratchpad_root",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: "persona_scratchpad",
    })
    const findById = spyOn(StreamRepository, "findById").mockResolvedValue(rootScratchpad)
    spyOn(PersonaRepository, "findById").mockResolvedValue(activePersona)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect({ streamLookups: findById.mock.calls.length, dispatches: jobQueue.send.mock.calls.length }).toEqual({
      streamLookups: 0,
      dispatches: 0,
    })
  })

  it("dispatches for deeply nested threads under a scratchpad (thread of thread of scratchpad)", async () => {
    // rootStreamId on threads always points to the non-thread ancestor, so a
    // two-level-deep thread still resolves directly to the scratchpad root.
    mockUserMessageEvent("stream_thread_deep")

    const deepThread = makeStream({
      id: "stream_thread_deep",
      type: StreamTypes.THREAD,
      parentStreamId: "stream_thread_mid",
      parentMessageId: "msg_mid",
      rootStreamId: "stream_scratchpad_root",
      companionMode: CompanionModes.OFF,
    })
    const rootScratchpad = makeStream({
      id: "stream_scratchpad_root",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: "persona_scratchpad",
    })

    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
      if (id === "stream_thread_deep") return deepThread
      if (id === "stream_scratchpad_root") return rootScratchpad
      return null
    })
    spyOn(PersonaRepository, "findById").mockResolvedValue(activePersona)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      expect.objectContaining({
        streamId: "stream_thread_deep",
        personaId: "persona_scratchpad",
      })
    )
  })

  it("does not dispatch for threads whose root is a channel", async () => {
    mockUserMessageEvent("stream_thread_channel")

    const thread = makeStream({
      id: "stream_thread_channel",
      type: StreamTypes.THREAD,
      parentStreamId: "stream_channel_root",
      parentMessageId: "msg_parent",
      rootStreamId: "stream_channel_root",
      companionMode: CompanionModes.OFF,
    })
    const rootChannel = makeStream({
      id: "stream_channel_root",
      type: StreamTypes.CHANNEL,
      companionMode: CompanionModes.ON, // even if on, channel threads must not auto-invoke
      companionPersonaId: "persona_channel",
    })

    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
      if (id === "stream_thread_channel") return thread
      if (id === "stream_channel_root") return rootChannel
      return null
    })
    const personaSpy = spyOn(PersonaRepository, "findById").mockResolvedValue(activePersona)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
    expect(personaSpy).not.toHaveBeenCalled()
  })

  it("does not dispatch for messages on end-to-end encrypted streams", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    mockUserMessageEvent("stream_e2e")

    const streamSpy = spyOn(StreamRepository, "findById").mockResolvedValue(
      makeStream({ id: "stream_e2e", companionMode: CompanionModes.ON, companionPersonaId: "persona_scratchpad" })
    )

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(streamSpy).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("carries personaDraftId when the message lands in a bound test scratchpad", async () => {
    mockUserMessageEvent("stream_test")

    const testScratchpad = makeStream({
      id: "stream_test",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: "persona_system_ariadne",
    })
    spyOn(StreamRepository, "findById").mockResolvedValue(testScratchpad)
    spyOn(PersonaRepository, "findById").mockResolvedValue({ id: "persona_system_ariadne", status: "active" } as any)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByTestStreamId").mockResolvedValue({
      id: "pcd_1",
      workspaceId: "ws_1",
      agentId: "persona_system_ariadne",
    })

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      expect.objectContaining({
        streamId: "stream_test",
        personaId: "persona_system_ariadne",
        personaDraftId: "pcd_1",
      })
    )
  })

  it("falls back to the built-in default (never the user/workspace default) for a legacy NULL pointer", async () => {
    mockUserMessageEvent("stream_unpinned")

    const scratchpad = makeStream({
      id: "stream_unpinned",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: null,
      createdBy: "usr_creator",
    })
    spyOn(StreamRepository, "findById").mockResolvedValue(scratchpad)
    const findById = spyOn(PersonaRepository, "findById")
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault").mockResolvedValue({
      id: "persona_system_ariadne",
      status: "active",
    } as any)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    // Defaults resolve at CREATE and pin; dispatch never re-resolves them —
    // a legacy NULL pointer degrades to the built-in only.
    expect(findById).not.toHaveBeenCalled()
    expect(systemDefault).toHaveBeenCalledWith({}, "ws_1")
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      expect.objectContaining({
        streamId: "stream_unpinned",
        personaId: "persona_system_ariadne",
      })
    )
  })

  it("falls back to the built-in default for an unpinned nested thread via its root scratchpad", async () => {
    mockUserMessageEvent("stream_thread_unpinned")

    const thread = makeStream({
      id: "stream_thread_unpinned",
      type: StreamTypes.THREAD,
      parentStreamId: "stream_root_unpinned",
      parentMessageId: "msg_parent",
      rootStreamId: "stream_root_unpinned",
      companionMode: CompanionModes.OFF,
      companionPersonaId: null,
      createdBy: "usr_thread_author",
    })
    const rootScratchpad = makeStream({
      id: "stream_root_unpinned",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: null,
      createdBy: "usr_root_owner",
    })
    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
      if (id === "stream_thread_unpinned") return thread
      if (id === "stream_root_unpinned") return rootScratchpad
      return null
    })
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault").mockResolvedValue({
      id: "persona_system_ariadne",
      status: "active",
    } as any)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(systemDefault).toHaveBeenCalledWith({}, "ws_1")
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      expect.objectContaining({
        streamId: "stream_thread_unpinned",
        personaId: "persona_system_ariadne",
      })
    )
  })

  it("uses the pinned persona directly when the scratchpad has an active explicit pick", async () => {
    mockUserMessageEvent("stream_pinned")

    const scratchpad = makeStream({
      id: "stream_pinned",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.ON,
      companionPersonaId: "persona_pinned",
    })
    spyOn(StreamRepository, "findById").mockResolvedValue(scratchpad)
    spyOn(PersonaRepository, "findById").mockResolvedValue({ id: "persona_pinned", status: "active" } as any)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault")

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(systemDefault).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      expect.objectContaining({ streamId: "stream_pinned", personaId: "persona_pinned" })
    )
  })

  it("does not dispatch for threads under a scratchpad whose companion mode is off", async () => {
    mockUserMessageEvent("stream_thread_off")

    const thread = makeStream({
      id: "stream_thread_off",
      type: StreamTypes.THREAD,
      parentStreamId: "stream_scratchpad_off",
      parentMessageId: "msg_parent",
      rootStreamId: "stream_scratchpad_off",
      companionMode: CompanionModes.OFF,
    })
    const rootScratchpad = makeStream({
      id: "stream_scratchpad_off",
      type: StreamTypes.SCRATCHPAD,
      companionMode: CompanionModes.OFF,
    })

    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
      if (id === "stream_thread_off") return thread
      if (id === "stream_scratchpad_off") return rootScratchpad
      return null
    })
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
  })
  it("wakes the run's persona in a subagent thread under a channel, which has no companion mode", async () => {
    mockUserMessageEvent("stream_subagent_thread")
    makeChannelThread()
    spyOn(SubagentRunRepository, "findActiveByThreadStreamId").mockResolvedValue({
      id: "subagent_1",
      personaId: "persona_delegated",
      status: "active",
    } as any)
    spyOn(PersonaRepository, "findById").mockResolvedValue({ id: "persona_delegated", status: "active" } as any)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).toHaveBeenCalledWith("persona.agent", {
      workspaceId: "ws_1",
      streamId: "stream_subagent_thread",
      messageId: "msg_1",
      personaId: "persona_delegated",
      triggeredBy: "usr_author",
    })
  })

  it("stops waking a subagent thread once the run is terminal", async () => {
    mockUserMessageEvent("stream_subagent_thread")
    makeChannelThread()
    // A settled run is not returned by the active lookup, so the thread falls
    // back to its root's companion mode — off, for a channel.
    spyOn(SubagentRunRepository, "findActiveByThreadStreamId").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("skips the run lookup entirely for a non-thread stream", async () => {
    mockUserMessageEvent("stream_plain_channel")
    spyOn(StreamRepository, "findById").mockResolvedValue(
      makeStream({ id: "stream_plain_channel", type: StreamTypes.CHANNEL, companionMode: CompanionModes.OFF })
    )
    const lookup = spyOn(SubagentRunRepository, "findActiveByThreadStreamId").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)

    const { handler } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(lookup).not.toHaveBeenCalled()
  })
})
