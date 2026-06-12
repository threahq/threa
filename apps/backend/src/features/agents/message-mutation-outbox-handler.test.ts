import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AuthorTypes } from "@threa/types"
import * as dbModule from "../../db"
import type { ProcessResult } from "@threa/backend-common"
import * as cursorLockModule from "@threa/backend-common"
import { OutboxRepository } from "../../lib/outbox"
import { MessageVersionRepository } from "../messaging"
import { StreamEventRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { AgentMessageMutationHandler } from "./message-mutation-outbox-handler"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"

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

function createHandler() {
  mockCursorLock()
  spyOn(MessageVersionRepository, "findLatestByMessageId").mockResolvedValue(null)

  const eventService = {
    deleteMessage: mock(async () => null),
  } as any

  const jobQueue = {
    send: mock(async () => "queue_1"),
  } as any

  const handler = new AgentMessageMutationHandler({} as any, jobQueue, eventService)

  return { handler, eventService, jobQueue }
}

async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

describe("AgentMessageMutationHandler", () => {
  beforeEach(() => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  })

  afterEach(() => {
    mock.restore()
  })

  it("supersedes completed invoking session on message edit and dispatches rerun", async () => {
    const editedAt = new Date("2026-02-19T12:00:00.000Z")

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: editedAt,
      } as any,
    ])

    spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(3)
    spyOn(StreamEventRepository, "listMessageIdsBySession").mockResolvedValue([])

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_old",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_1",
      error: null,
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1", "msg_agent_2"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T11:59:00.000Z"),
    })

    spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({
      id: "session_old",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.SUPERSEDED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_1",
      error: "Superseded by invoking message edit",
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1", "msg_agent_2"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T12:01:00.000Z"),
    })
    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(AgentSessionRepository.updateStatus).toHaveBeenCalledWith(
      {},
      "session_old",
      SessionStatuses.SUPERSEDED,
      expect.objectContaining({ error: "Superseded by invoking message edit" })
    )
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      {
        workspaceId: "ws_1",
        streamId: "stream_thread_1",
        messageId: "msg_invoke_1",
        personaId: "persona_1",
        triggeredBy: "usr_editor",
        supersedesSessionId: "session_old",
        rerunContext: expect.objectContaining({
          cause: "invoking_message_edited",
          editedMessageId: "msg_invoke_1",
        }),
      },
      {
        messageId: "queue_rerun_session_old",
      }
    )
  })

  it("does not dispatch rerun when concurrent supersede already won terminal transition", async () => {
    const editedAt = new Date("2026-02-19T12:00:00.000Z")

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: editedAt,
      } as any,
    ])

    spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(3)
    spyOn(StreamEventRepository, "listMessageIdsBySession").mockResolvedValue([])

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_old",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_1",
      error: null,
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T11:59:00.000Z"),
    })

    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(updateStatusSpy).toHaveBeenCalledWith(
      {},
      "session_old",
      SessionStatuses.SUPERSEDED,
      expect.objectContaining({
        error: "Superseded by invoking message edit",
        onlyIfStatusIn: [SessionStatuses.COMPLETED, SessionStatuses.FAILED],
      })
    )
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("dispatches idempotent rerun send for superseded session replays", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:00:00.000Z"),
      } as any,
    ])

    spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(3)
    spyOn(StreamEventRepository, "listMessageIdsBySession").mockResolvedValue([])
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_old",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.SUPERSEDED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_1",
      error: "Superseded by invoking message edit",
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T11:59:00.000Z"),
    })
    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      expect.objectContaining({
        supersedesSessionId: "session_old",
      }),
      {
        messageId: "queue_rerun_session_old",
      }
    )
    expect(updateStatusSpy).not.toHaveBeenCalled()
  })

  it("re-dispatches rerun for superseded session replay when no successor exists", async () => {
    const editedAt = new Date("2026-02-19T12:00:00.000Z")

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: editedAt,
      } as any,
    ])

    spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(4)
    spyOn(StreamEventRepository, "listMessageIdsBySession").mockResolvedValue([])
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_old",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 3,
      supersedesSessionId: null,
      status: SessionStatuses.SUPERSEDED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_1",
      error: "Superseded by invoking message edit",
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T12:02:00.000Z"),
    })
    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      {
        workspaceId: "ws_1",
        streamId: "stream_thread_1",
        messageId: "msg_invoke_1",
        personaId: "persona_1",
        triggeredBy: "usr_editor",
        supersedesSessionId: "session_old",
        rerunContext: expect.objectContaining({
          cause: "invoking_message_edited",
          editedMessageId: "msg_invoke_1",
        }),
      },
      {
        messageId: "queue_rerun_session_old",
      }
    )
  })

  it("supersedes failed invoking session on message edit and dispatches rerun", async () => {
    const editedAt = new Date("2026-02-19T12:00:00.000Z")

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: editedAt,
      } as any,
    ])

    spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(4)
    spyOn(StreamEventRepository, "listMessageIdsBySession").mockResolvedValue([])

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_failed",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.FAILED,
      currentStep: 3,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: null,
      error: "Agent loop completed without sending a message",
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T11:59:00.000Z"),
    })

    spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({
      id: "session_failed",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.SUPERSEDED,
      currentStep: 3,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: null,
      error: "Superseded by invoking message edit",
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:30:00.000Z"),
      completedAt: new Date("2026-02-19T12:01:00.000Z"),
    })
    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(AgentSessionRepository.updateStatus).toHaveBeenCalledWith(
      {},
      "session_failed",
      SessionStatuses.SUPERSEDED,
      expect.objectContaining({ error: "Superseded by invoking message edit" })
    )
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      {
        workspaceId: "ws_1",
        streamId: "stream_thread_1",
        messageId: "msg_invoke_1",
        personaId: "persona_1",
        triggeredBy: "usr_editor",
        supersedesSessionId: "session_failed",
        rerunContext: expect.objectContaining({
          cause: "invoking_message_edited",
          editedMessageId: "msg_invoke_1",
        }),
      },
      {
        messageId: "queue_rerun_session_failed",
      }
    )
  })

  it("does not rerun when edit happened before session completed", async () => {
    const editedAt = new Date("2026-02-19T12:00:00.000Z")
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: editedAt,
      } as any,
    ])

    const getRevisionSpy = spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(99)
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_old",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 2,
      supersedesSessionId: null,
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_1",
      error: null,
      lastSeenSequence: 10n,
      sentMessageIds: ["msg_agent_1"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:00:00.000Z"),
      completedAt: new Date("2026-02-19T12:05:00.000Z"),
    })

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(getRevisionSpy).not.toHaveBeenCalled()
    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("does not rerun when latest session already has current invoking revision", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:10:00.000Z"),
      } as any,
    ])

    spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(3)
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_newest",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: 3,
      supersedesSessionId: "session_old",
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_3",
      error: null,
      lastSeenSequence: 15n,
      sentMessageIds: ["msg_agent_3"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T12:01:00.000Z"),
      completedAt: new Date("2026-02-19T12:08:00.000Z"),
    })

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("supersedes latest stream session when referenced message within context is edited and dispatches rerun", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_thread_1",
          event: {
            actorId: "usr_editor",
            actorType: AuthorTypes.USER,
            sequence: "15",
            payload: {
              messageId: "msg_referenced_1",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:10:00.000Z"),
      } as any,
    ])

    const getRevisionSpy = spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(7)
    spyOn(StreamEventRepository, "listMessageIdsBySession").mockResolvedValue([])
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue({
      id: "session_latest",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_latest",
      triggerMessageRevision: 4,
      supersedesSessionId: null,
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_latest",
      error: null,
      lastSeenSequence: 20n,
      sentMessageIds: ["msg_agent_latest"],
      contextMessageIds: ["msg_invoke_latest", "msg_referenced_1", "msg_other_1"],
      createdAt: new Date("2026-02-19T11:00:00.000Z"),
      completedAt: new Date("2026-02-19T12:00:00.000Z"),
    })

    spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({
      id: "session_latest",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_latest",
      triggerMessageRevision: 4,
      supersedesSessionId: null,
      status: SessionStatuses.SUPERSEDED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_latest",
      error: "Superseded by referenced message edit",
      lastSeenSequence: 20n,
      sentMessageIds: ["msg_agent_latest"],
      contextMessageIds: ["msg_invoke_latest", "msg_referenced_1", "msg_other_1"],
      createdAt: new Date("2026-02-19T11:00:00.000Z"),
      completedAt: new Date("2026-02-19T12:11:00.000Z"),
    })
    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(getRevisionSpy).not.toHaveBeenCalled()
    expect(AgentSessionRepository.updateStatus).toHaveBeenCalledWith(
      {},
      "session_latest",
      SessionStatuses.SUPERSEDED,
      expect.objectContaining({ error: "Superseded by referenced message edit" })
    )
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledWith(
      "persona.agent",
      {
        workspaceId: "ws_1",
        streamId: "stream_thread_1",
        messageId: "msg_invoke_latest",
        personaId: "persona_1",
        triggeredBy: "usr_editor",
        supersedesSessionId: "session_latest",
        rerunContext: expect.objectContaining({
          cause: "referenced_message_edited",
          editedMessageId: "msg_referenced_1",
        }),
      },
      {
        messageId: "queue_rerun_session_latest",
      }
    )
  })

  it("does not rerun for referenced edit outside agent context window", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_thread_1",
          event: {
            actorId: "usr_editor",
            actorType: AuthorTypes.USER,
            sequence: "5",
            payload: {
              messageId: "msg_old_from_weeks_ago",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:10:00.000Z"),
      } as any,
    ])

    const getRevisionSpy = spyOn(MessageVersionRepository, "getCurrentRevision").mockResolvedValue(7)
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue({
      id: "session_latest",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_latest",
      triggerMessageRevision: 4,
      supersedesSessionId: null,
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_latest",
      error: null,
      lastSeenSequence: 20n,
      sentMessageIds: ["msg_agent_latest"],
      contextMessageIds: ["msg_invoke_latest", "msg_recent_1", "msg_recent_2"],
      createdAt: new Date("2026-02-19T11:00:00.000Z"),
      completedAt: new Date("2026-02-19T12:00:00.000Z"),
    })

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(getRevisionSpy).not.toHaveBeenCalled()
    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("falls back to sequence check for pre-migration sessions without contextMessageIds", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_thread_1",
          event: {
            actorId: "usr_editor",
            actorType: AuthorTypes.USER,
            sequence: "25",
            payload: {
              messageId: "msg_after_session",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:10:00.000Z"),
      } as any,
    ])

    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue({
      id: "session_legacy",
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_latest",
      triggerMessageRevision: 4,
      supersedesSessionId: null,
      status: SessionStatuses.COMPLETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: "msg_agent_latest",
      error: null,
      lastSeenSequence: 20n,
      sentMessageIds: ["msg_agent_latest"],
      contextMessageIds: [],
      createdAt: new Date("2026-02-19T11:00:00.000Z"),
      completedAt: new Date("2026-02-19T12:00:00.000Z"),
    })

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("does not rerun when edited message event is authored by persona", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_thread_1",
          event: {
            actorId: "persona_1",
            actorType: AuthorTypes.PERSONA,
            sequence: "21",
            payload: {
              messageId: "msg_referenced_1",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:10:00.000Z"),
      } as any,
    ])

    const findByTriggerSpy = spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    const findLatestByStreamSpy = spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(findByTriggerSpy).not.toHaveBeenCalled()
    expect(findLatestByStreamSpy).not.toHaveBeenCalled()
    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("short-circuits message:edited on end-to-end encrypted streams without inspecting sessions", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_e2e",
          event: {
            actorId: "usr_editor",
            payload: {
              messageId: "msg_invoke_1",
            },
          },
        },
        createdAt: new Date("2026-02-19T12:00:00.000Z"),
      } as any,
    ])

    const findByTriggerSpy = spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
    const findLatestByStreamSpy = spyOn(AgentSessionRepository, "findLatestByStream").mockResolvedValue(null)
    const updateStatusSpy = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

    const { handler, eventService, jobQueue } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(findByTriggerSpy).not.toHaveBeenCalled()
    expect(findLatestByStreamSpy).not.toHaveBeenCalled()
    expect(updateStatusSpy).not.toHaveBeenCalled()
    expect(eventService.deleteMessage).not.toHaveBeenCalled()
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("deletes invoking sessions and cascades deletion for stored and event-sourced session messages", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:deleted",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          messageId: "msg_invoke_1",
          deletedAt: new Date().toISOString(),
        },
        createdAt: new Date(),
      } as any,
    ])

    spyOn(AgentSessionRepository, "listByTriggerMessage").mockResolvedValue([
      {
        id: "session_1",
        streamId: "stream_thread_1",
        personaId: "persona_1",
        triggerMessageId: "msg_invoke_1",
        triggerMessageRevision: 3,
        supersedesSessionId: null,
        status: SessionStatuses.RUNNING,
        currentStep: 1,
        currentStepType: "thinking",
        serverId: "server_1",
        callbackToken: null,
        replyKeyGeneration: null,
        heartbeatAt: new Date(),
        responseMessageId: null,
        error: null,
        lastSeenSequence: 11n,
        sentMessageIds: [],
        contextMessageIds: [],
        createdAt: new Date(),
        completedAt: null,
      },
      {
        id: "session_2",
        streamId: "stream_thread_1",
        personaId: "persona_1",
        triggerMessageId: "msg_invoke_1",
        triggerMessageRevision: 2,
        supersedesSessionId: null,
        status: SessionStatuses.DELETED,
        currentStep: 2,
        currentStepType: null,
        serverId: null,
        callbackToken: null,
        replyKeyGeneration: null,
        heartbeatAt: null,
        responseMessageId: "msg_agent_2",
        error: "Invoking message deleted",
        lastSeenSequence: 9n,
        sentMessageIds: ["msg_agent_2"],
        contextMessageIds: [],
        createdAt: new Date(),
        completedAt: new Date("2026-02-19T11:55:00.000Z"),
      },
    ])

    spyOn(AgentSessionRepository, "updateStatus").mockImplementation(async (_db, id) => ({
      id,
      streamId: "stream_thread_1",
      personaId: "persona_1",
      triggerMessageId: "msg_invoke_1",
      triggerMessageRevision: null,
      supersedesSessionId: null,
      status: SessionStatuses.DELETED,
      currentStep: 0,
      currentStepType: null,
      serverId: null,
      callbackToken: null,
      replyKeyGeneration: null,
      heartbeatAt: null,
      responseMessageId: null,
      error: "Invoking message deleted",
      lastSeenSequence: null,
      sentMessageIds: [],
      contextMessageIds: [],
      createdAt: new Date(),
      completedAt: new Date("2026-02-19T12:00:00.000Z"),
    }))

    spyOn(StreamEventRepository, "listMessageIdsBySession").mockImplementation(async (_db, _streamId, sessionId) => {
      if (sessionId === "session_1") return ["msg_agent_live_1"]
      return []
    })

    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_1",
      streamId: "stream_thread_1",
      sequence: 100n,
      eventType: "agent_session:deleted",
      payload: { sessionId: "session_1", deletedAt: "2026-02-19T12:00:00.000Z" },
      actorId: "persona_1",
      actorType: AuthorTypes.PERSONA,
      createdAt: new Date(),
    } as any)

    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => callback({} as any))

    const { handler, eventService } = createHandler()
    handler.handle()

    await waitForDebounce()

    expect(AgentSessionRepository.updateStatus).toHaveBeenCalledWith(
      expect.anything(),
      "session_1",
      SessionStatuses.DELETED,
      expect.objectContaining({
        error: "Invoking message deleted",
      })
    )
    expect(StreamEventRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "agent_session:deleted",
        payload: expect.objectContaining({
          sessionId: "session_1",
          deletedAt: "2026-02-19T12:00:00.000Z",
        }),
      })
    )
    expect(OutboxRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      "agent_session:deleted",
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_thread_1",
      })
    )
    expect(eventService.deleteMessage).toHaveBeenCalledTimes(2)
    expect(eventService.deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg_agent_live_1",
      })
    )
    expect(eventService.deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg_agent_2",
      })
    )
  })
})
