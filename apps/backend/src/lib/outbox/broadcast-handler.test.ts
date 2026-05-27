import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository } from "./repository"
import * as cursorLockModule from "@threa/backend-common"
import { BroadcastHandler } from "./broadcast-handler"
import type { ProcessResult } from "@threa/backend-common"
import type { OutboxEvent } from "./repository"

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

interface MockEmitChain {
  emit: ReturnType<typeof mock>
}

function createMockIo() {
  const emitChains: Array<{ room: string; eventType: string; payload: unknown; namespace?: string }> = []

  const makeRoomChain = (room: string, namespace?: string): MockEmitChain => ({
    emit: mock((eventType: string, payload: unknown) => {
      emitChains.push({ room, eventType, payload, namespace })
    }),
  })

  const namespaceCache = new Map<string, { to: (room: string) => MockEmitChain }>()
  const io = {
    to: mock((room: string): MockEmitChain => makeRoomChain(room)),
    of: mock((namespace: string) => {
      let ns = namespaceCache.get(namespace)
      if (!ns) {
        ns = { to: (room: string) => makeRoomChain(room, namespace) }
        namespaceCache.set(namespace, ns)
      }
      return ns
    }),
  }

  return { io, emitChains }
}

function createHandler() {
  mockCursorLock()
  const { io, emitChains } = createMockIo()
  const botNamespace = io.of("/bot")
  const handler = new BroadcastHandler({} as any, io as any, botNamespace as any)
  return { handler, io, emitChains }
}

function makeEvent(id: bigint, eventType: string, payload: Record<string, unknown>): OutboxEvent {
  return { id, eventType, payload, createdAt: new Date() } as unknown as OutboxEvent
}

describe("BroadcastHandler", () => {
  afterEach(() => {
    mock.restore()
  })

  it("should emit user-scoped event to user room", async () => {
    const event = makeEvent(1n, "activity:created", {
      workspaceId: "ws_1",
      targetUserId: "usr_alice",
      activity: { id: "act_1" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_alice",
      eventType: "activity:created",
      payload: event.payload,
    })
  })

  it("should emit command event to stream room", async () => {
    const event = makeEvent(1n, "command:dispatched", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_bob",
      event: { id: "evt_1" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_1",
      eventType: "command:dispatched",
      payload: event.payload,
    })
  })

  it("should emit stream:read to author user room", async () => {
    const event = makeEvent(1n, "stream:read", {
      workspaceId: "ws_1",
      authorId: "usr_carol",
      streamId: "stream_1",
      lastReadEventId: "evt_5",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_carol",
      eventType: "stream:read",
      payload: event.payload,
    })
  })

  it("should emit stream:member_added to both stream room and user room", async () => {
    const event = makeEvent(1n, "stream:member_added", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_dave",
      stream: { id: "stream_1" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_1",
      eventType: "stream:member_added",
      payload: event.payload,
    })
    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_dave",
      eventType: "stream:member_added",
      payload: event.payload,
    })
  })

  it("should emit stream-scoped event to stream room", async () => {
    const event = makeEvent(1n, "message:created", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      event: { id: "evt_1" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_1",
      eventType: "message:created",
      payload: event.payload,
    })
  })

  it("should emit workspace-scoped event to workspace room", async () => {
    const event = makeEvent(1n, "stream:updated", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      stream: { id: "stream_1" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1",
      eventType: "stream:updated",
      payload: event.payload,
    })
  })

  it("should emit stream:created thread to parent stream room", async () => {
    const event = makeEvent(1n, "stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_parent",
      stream: { id: "stream_thread", parentMessageId: "msg_1" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_parent",
      eventType: "stream:created",
      payload: event.payload,
    })
  })

  it("should emit stream:created public channel to workspace room", async () => {
    const event = makeEvent(1n, "stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_new",
      stream: { id: "stream_new", parentMessageId: null, type: "channel", visibility: "public" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1",
      eventType: "stream:created",
      payload: event.payload,
    })
  })

  it("should emit stream:created private stream to creator user room only", async () => {
    const event = makeEvent(1n, "stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_sp",
      stream: {
        id: "stream_sp",
        parentMessageId: null,
        type: "scratchpad",
        visibility: "private",
        createdBy: "usr_alice",
      },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_alice",
      eventType: "stream:created",
      payload: event.payload,
    })
    expect(emitChains.some((chain) => chain.room === "ws:ws_1")).toBe(false)
  })

  it("should emit stream:created private channel to creator user room only", async () => {
    const event = makeEvent(1n, "stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_priv_ch",
      stream: {
        id: "stream_priv_ch",
        parentMessageId: null,
        type: "channel",
        visibility: "private",
        createdBy: "usr_bob",
      },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_bob",
      eventType: "stream:created",
      payload: event.payload,
    })
    expect(emitChains.some((chain) => chain.room === "ws:ws_1")).toBe(false)
  })

  it("should emit stream:created DM to user rooms", async () => {
    const event = makeEvent(1n, "stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_dm",
      stream: { id: "stream_dm", parentMessageId: null, type: "dm" },
      dmUserIds: ["usr_alice", "usr_bob"],
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_alice",
      eventType: "stream:created",
      payload: event.payload,
    })
    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_bob",
      eventType: "stream:created",
      payload: event.payload,
    })
    expect(emitChains.some((chain) => chain.room === "ws:ws_1")).toBe(false)
  })

  it("should emit stream:display_name_updated for public stream to workspace room", async () => {
    const event = makeEvent(1n, "stream:display_name_updated", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      displayName: "general",
      visibility: "public",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1",
      eventType: "stream:display_name_updated",
      payload: event.payload,
    })
  })

  it("should emit stream:display_name_updated for private stream to stream room", async () => {
    const event = makeEvent(1n, "stream:display_name_updated", {
      workspaceId: "ws_1",
      streamId: "stream_dm",
      displayName: "DM with Alice",
      visibility: "private",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_dm",
      eventType: "stream:display_name_updated",
      payload: event.payload,
    })
  })

  it("should continue processing when individual event broadcast throws", async () => {
    const event1 = makeEvent(1n, "message:created", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      event: { id: "evt_1" },
    })
    // Malformed: missing workspaceId — broadcastEvent will still work since
    // io.to().emit() is fire-and-forget, but test verifies the loop continues
    const event2 = makeEvent(2n, "message:created", {
      workspaceId: "ws_1",
      streamId: "stream_2",
      event: { id: "evt_2" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event1, event2])

    let result: ProcessResult | undefined
    mockCursorLock((r) => {
      result = r
    })

    const { io } = createMockIo()
    const botNamespace = io.of("/bot")
    const handler = new BroadcastHandler({} as any, io as any, botNamespace as any)
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(result).toEqual({ status: "processed", processedIds: [1n, 2n] })
  })

  it("should emit conversation event to stream and parent stream rooms", async () => {
    const event = makeEvent(1n, "conversation:created", {
      workspaceId: "ws_1",
      streamId: "stream_thread",
      conversationId: "conv_1",
      parentStreamId: "stream_parent",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_thread",
      eventType: "conversation:created",
      payload: event.payload,
    })
    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_parent",
      eventType: "conversation:created",
      payload: event.payload,
    })
  })

  it("should emit conversation:message_assigned to stream and parent stream rooms", async () => {
    const event = makeEvent(1n, "conversation:message_assigned", {
      workspaceId: "ws_1",
      streamId: "stream_thread",
      parentStreamId: "stream_parent",
      messageId: "msg_1",
      conversationId: "conv_1",
      isPrimary: true,
      reason: "initial",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_thread",
      eventType: "conversation:message_assigned",
      payload: event.payload,
    })
    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_parent",
      eventType: "conversation:message_assigned",
      payload: event.payload,
    })
  })

  it("should emit conversation:message_reassigned to its stream room only", async () => {
    const event = makeEvent(1n, "conversation:message_reassigned", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      messageId: "msg_1",
      fromConversationId: "conv_from",
      toConversationId: "conv_to",
      reason: "late-reveal",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_a",
      eventType: "conversation:message_reassigned",
      payload: event.payload,
      namespace: undefined,
    })
    // No parentStreamId on this payload → no parent-room emit
    expect(emitChains.filter((e) => e.eventType === "conversation:message_reassigned")).toHaveLength(1)
  })

  // ===========================================================================
  // Bot-scoped events route into the `/bot` namespace using the narrowest room
  // a payload supports — see `BroadcastHandler.dispatchBotEvent`.
  // ===========================================================================
  it("routes bot_invocation:available with no steering to the per-bot room", async () => {
    const event = makeEvent(1n, "bot_invocation:available", {
      workspaceId: "ws_1",
      botId: "bot_alice",
      invocationId: "inv_1",
      requiredCapability: "active-scratchpad",
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      createdAt: new Date().toISOString(),
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "bot:ws_1:bot:bot_alice",
      eventType: "bot_invocation:available",
      payload: event.payload,
      namespace: "/bot",
    })
  })

  it("routes bot_invocation:available with targetInstanceId to the per-instance room", async () => {
    const event = makeEvent(2n, "bot_invocation:available", {
      workspaceId: "ws_1",
      botId: "bot_alice",
      invocationId: "inv_2",
      requiredCapability: "active-scratchpad",
      targetInstanceId: "inst_42",
      targetRuntimeSessionId: null,
      createdAt: new Date().toISOString(),
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "bot:ws_1:bot:bot_alice:instance:inst_42",
      eventType: "bot_invocation:available",
      payload: event.payload,
      namespace: "/bot",
    })
  })

  it("routes bot_invocation:available with targetRuntimeSessionId to the per-session room", async () => {
    const event = makeEvent(3n, "bot_invocation:available", {
      workspaceId: "ws_1",
      botId: "bot_alice",
      invocationId: "inv_3",
      requiredCapability: "active-scratchpad",
      targetInstanceId: "inst_42",
      targetRuntimeSessionId: "sess_99",
      createdAt: new Date().toISOString(),
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    // Session room wins — the instance room is intentionally skipped because
    // the per-session subscriber is a strict subset of the per-instance set
    // and re-emitting would deliver duplicates to the session socket.
    expect(emitChains).toContainEqual({
      room: "bot:ws_1:bot:bot_alice:session:sess_99",
      eventType: "bot_invocation:available",
      payload: event.payload,
      namespace: "/bot",
    })
    // Instance room must not also receive it — the per-session subscriber is a
    // strict subset of the per-instance set, so a second emit would deliver
    // duplicates to the session socket.
    expect(
      emitChains.some(
        (e) =>
          e.eventType === "bot_invocation:available" &&
          e.room === "bot:ws_1:bot:bot_alice:instance:inst_42" &&
          e.namespace === "/bot"
      )
    ).toBe(false)
  })

  it("fans bot:active_actor_changed to every affected bot room", async () => {
    const event = makeEvent(4n, "bot:active_actor_changed", {
      workspaceId: "ws_1",
      rootStreamId: "stream_pad",
      previousActorType: "bot",
      previousActorId: "bot_old",
      newActorType: "bot",
      newActorId: "bot_new",
      affectedBotIds: ["bot_old", "bot_new"],
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    const rooms = emitChains
      .filter((e) => e.eventType === "bot:active_actor_changed")
      .map((e) => e.room)
      .sort()
    expect(rooms).toEqual(["bot:ws_1:bot:bot_new", "bot:ws_1:bot:bot_old"])
  })

  it("narrows bot:resync routing by the most-specific target", async () => {
    const events = [
      makeEvent(5n, "bot:resync", {
        workspaceId: "ws_1",
        botId: null,
        instanceId: null,
        reason: "admin",
      }),
      makeEvent(6n, "bot:resync", {
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: null,
        reason: "key_rotated",
      }),
      makeEvent(7n, "bot:resync", {
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        reason: "instance_kicked",
      }),
    ]

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue(events)

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    const resyncEmits = emitChains.filter((e) => e.eventType === "bot:resync")
    expect(resyncEmits.map((e) => e.room)).toEqual([
      "bot:ws_1",
      "bot:ws_1:bot:bot_alice",
      "bot:ws_1:bot:bot_alice:instance:inst_42",
    ])
    expect(resyncEmits.every((e) => e.namespace === "/bot")).toBe(true)
  })
})
