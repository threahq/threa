import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"
import { StreamRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import { UserE2eKeysRepository } from "../user-e2e-keys"
import { EnclaveClient, type EnclaveInvokeRequest, type EnclaveInvokeResponse } from "./enclave-client"
import { EnclaveDispatcher } from "./enclave-dispatcher"
import type { EnclaveRuntime } from "../enclave-runtimes"

const PERSONA_ID = "persona_system_ariadne"
const WORKSPACE_ID = "wsp_1"
const STREAM_ID = "stream_e2e"
const TRIGGER_USER_ID = "usr_1"
const TRIGGER_MESSAGE_ID = "msg_user_in"

const ownerUik = {
  id: "uek_1",
  workspaceId: WORKSPACE_ID,
  userId: "usr_owner",
  keyId: "uik_owner_1",
  publicKey: new Uint8Array(32).fill(7),
  algorithm: "x25519",
  createdAt: new Date(),
  revokedAt: null,
}

const liveRuntime: EnclaveRuntime = {
  id: "elr_1",
  instanceId: "enci_a",
  keyId: "eik_a",
  publicKey: new Uint8Array(32).fill(9),
  instanceUrl: "http://enclave-a.local:3011",
  registeredAt: new Date(),
  lastSeenAt: new Date(),
  revokedAt: null,
}

function makeInvokeResponse(overrides?: Partial<EnclaveInvokeResponse>): EnclaveInvokeResponse {
  return {
    reply: {
      ciphertext: Buffer.from("ciphertext-bytes").toString("base64"),
      envelope: { v: 1, iv: "iv", aad: "aad", ciphertext: "ct", recipients: [] },
      e2eVersion: 1,
    },
    sidecar: {
      modelName: "claude-sonnet-4.6",
      providerName: "anthropic",
      latencyMs: 2222,
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
      costUsd: 0.0067,
    },
    ...overrides,
  }
}

function makeStreamRow(): any {
  return {
    id: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    type: "scratchpad",
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "on",
    companionPersonaId: PERSONA_ID,
    createdBy: "usr_owner",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
  }
}

function makeE2eRow(overrides?: Record<string, unknown>): any {
  return {
    streamId: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: "usr_owner",
    ownerUserKeyId: ownerUik.keyId,
    invitedAgentKind: "enclave",
    invitedAgentKeyId: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeMessageRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: "msg_1",
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    authorId: "usr_owner",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
    ciphertext: Buffer.from("encrypted-user-message"),
    envelope: { v: 1, iv: "iv", aad: "aad", ciphertext: "ct", recipients: [] },
    e2eVersion: 1,
    sequence: 1n,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    editedAt: null,
    threadStreamId: null,
    attachmentIds: [],
    sources: [],
    metadata: {},
    sessionId: null,
    sentVia: null,
    isCompanion: false,
    reactions: [],
    ...overrides,
  }
}

function makeJob(overrides?: Partial<Record<string, string>>) {
  return {
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    messageId: TRIGGER_MESSAGE_ID,
    personaId: PERSONA_ID,
    triggeredBy: TRIGGER_USER_ID,
    ...overrides,
  }
}

describe("EnclaveDispatcher", () => {
  beforeEach(() => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(makeStreamRow())
    spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue(makeE2eRow())
    spyOn(UserE2eKeysRepository, "getByKeyId").mockResolvedValue(ownerUik as any)
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessageRow()])
  })

  afterEach(() => {
    mock.restore()
  })

  function makeDeps(
    invokeImpl: (instanceUrl: string, request: any) => Promise<EnclaveInvokeResponse>,
    runtimes: EnclaveRuntime[] = [liveRuntime]
  ) {
    const enclaveClient = new EnclaveClient("test-bearer")
    spyOn(EnclaveClient.prototype, "invoke").mockImplementation(invokeImpl)

    const enclaveRuntimesService = {
      listLive: mock(async () => runtimes),
    } as any

    const messageEventService = {
      createMessage: mock(async () => ({ id: "msg_reply" })),
    } as any

    const aiCostService = {
      recordUsage: mock(async () => {}),
    } as any

    return {
      deps: {
        pool: {} as any,
        enclaveClient,
        enclaveRuntimesService,
        messageEventService,
        aiCostService,
        pickInstance: (rs: EnclaveRuntime[]) => rs[0]!,
      },
      messageEventService,
      aiCostService,
    }
  }

  it("dispatches invoke, persists ciphertext via EventService, records usage via AICostService", async () => {
    const response = makeInvokeResponse()
    let captured: { instanceUrl: string; request: EnclaveInvokeRequest } | undefined
    const invokeMock = mock(async (instanceUrl: string, request: EnclaveInvokeRequest) => {
      captured = { instanceUrl, request }
      return response
    })
    const { deps, messageEventService, aiCostService } = makeDeps(invokeMock)

    const dispatcher = new EnclaveDispatcher(deps)
    await dispatcher.runJob(makeJob())

    expect(invokeMock).toHaveBeenCalledTimes(1)
    const { instanceUrl, request } = captured!
    expect(instanceUrl).toBe(liveRuntime.instanceUrl)
    expect(request.persona.id).toBe(PERSONA_ID)
    expect(request.recipients).toEqual([
      { recipientKeyId: ownerUik.keyId, publicKey: Buffer.from(ownerUik.publicKey).toString("base64") },
      { recipientKeyId: liveRuntime.keyId, publicKey: Buffer.from(liveRuntime.publicKey).toString("base64") },
    ])
    expect(request.history).toHaveLength(1)
    expect(request.history[0]!.e2eVersion).toBe(1)

    expect(messageEventService.createMessage).toHaveBeenCalledTimes(1)
    const createMessageArgs = messageEventService.createMessage.mock.calls[0]![0]
    expect(createMessageArgs.workspaceId).toBe(WORKSPACE_ID)
    expect(createMessageArgs.streamId).toBe(STREAM_ID)
    expect(createMessageArgs.authorId).toBe(PERSONA_ID)
    expect(createMessageArgs.authorType).toBe("persona")
    expect(createMessageArgs.contentMarkdown).toBe(E2E_PLACEHOLDER_CONTENT_MARKDOWN)
    expect(createMessageArgs.ciphertext).toBeInstanceOf(Buffer)
    expect(createMessageArgs.envelope).toEqual(response.reply.envelope)
    expect(createMessageArgs.e2eVersion).toBe(1)

    expect(aiCostService.recordUsage).toHaveBeenCalledTimes(1)
    const recordArgs = aiCostService.recordUsage.mock.calls[0]![0]
    expect(recordArgs.workspaceId).toBe(WORKSPACE_ID)
    expect(recordArgs.functionId).toBe("enclave-persona-agent")
    expect(recordArgs.provider).toBe("anthropic")
    expect(recordArgs.usage.totalTokens).toBe(46)
    expect(recordArgs.usage.cost).toBeCloseTo(0.0067)
  })

  it("falls back to a second live runtime when the primary instance fails", async () => {
    const secondRuntime: EnclaveRuntime = {
      ...liveRuntime,
      id: "elr_2",
      instanceId: "enci_b",
      keyId: "eik_b",
      instanceUrl: "http://enclave-b.local:3011",
      publicKey: new Uint8Array(32).fill(11),
    }
    const response = makeInvokeResponse()
    let call = 0
    const invokeMock = mock(async (instanceUrl: string) => {
      call += 1
      if (call === 1) {
        throw new Error("primary down")
      }
      expect(instanceUrl).toBe(secondRuntime.instanceUrl)
      return response
    })
    const { deps, messageEventService } = makeDeps(invokeMock, [liveRuntime, secondRuntime])

    const dispatcher = new EnclaveDispatcher(deps)
    await dispatcher.runJob(makeJob())

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(messageEventService.createMessage).toHaveBeenCalledTimes(1)
  })

  it("aborts cleanly when no live enclave runtimes are available", async () => {
    const invokeMock = mock(async () => makeInvokeResponse())
    const { deps, messageEventService, aiCostService } = makeDeps(invokeMock, [])

    const dispatcher = new EnclaveDispatcher(deps)
    await expect(dispatcher.runJob(makeJob())).rejects.toThrow(/no live enclave runtimes/)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(messageEventService.createMessage).not.toHaveBeenCalled()
    expect(aiCostService.recordUsage).not.toHaveBeenCalled()
  })

  it("skips silently when the stream no longer has enclave invited", async () => {
    spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue(makeE2eRow({ invitedAgentKind: "none" }))
    const invokeMock = mock(async () => makeInvokeResponse())
    const { deps, messageEventService } = makeDeps(invokeMock)

    const dispatcher = new EnclaveDispatcher(deps)
    await dispatcher.runJob(makeJob())

    expect(invokeMock).not.toHaveBeenCalled()
    expect(messageEventService.createMessage).not.toHaveBeenCalled()
  })

  it("never reads contentMarkdown from history rows", async () => {
    // Confirm that even if the history contains plaintext columns, the
    // dispatcher's invoke payload only carries ciphertext/envelope/e2eVersion.
    spyOn(MessageRepository, "list").mockResolvedValue([
      makeMessageRow({
        contentMarkdown: "PLAINTEXT THAT MUST NEVER LEAVE THE BACKEND",
        contentJson: { type: "doc", content: [{ type: "text", text: "leaked" }] },
      }),
    ])
    const response = makeInvokeResponse()
    let captured: { request: EnclaveInvokeRequest } | undefined
    const invokeMock = mock(async (_instanceUrl: string, request: EnclaveInvokeRequest) => {
      captured = { request }
      return response
    })
    const { deps } = makeDeps(invokeMock)

    const dispatcher = new EnclaveDispatcher(deps)
    await dispatcher.runJob(makeJob())

    const { request } = captured!
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain("PLAINTEXT")
    expect(serialized).not.toContain("leaked")
    expect(request.history[0]).toEqual({
      id: "msg_1",
      authorId: "usr_owner",
      authorType: "user",
      createdAt: expect.any(String),
      ciphertext: Buffer.from("encrypted-user-message").toString("base64"),
      envelope: { v: 1, iv: "iv", aad: "aad", ciphertext: "ct", recipients: [] },
      e2eVersion: 1,
      sequence: "1",
    })
  })
})
