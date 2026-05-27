import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AuthorTypes, CompanionModes, StreamTypes } from "@threa/types"
import type { ProcessResult } from "@threa/backend-common"
import * as cursorLockModule from "@threa/backend-common"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { CompanionHandler } from "./companion-outbox-handler"
import { PersonaRepository } from "./persona-repository"
import { AgentSessionRepository } from "./session-repository"

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
    parentMessageId: null,
    rootStreamId: null,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

const activePersona = {
  id: "persona_scratchpad",
  status: "active",
} as any

function mockUserMessageEvent(streamId: string) {
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

describe("CompanionHandler", () => {
  beforeEach(() => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
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
})
