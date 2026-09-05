import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository } from "./repository"
import * as cursorLockModule from "@threa/backend-common"
import { BroadcastHandler } from "./broadcast-handler"
import { SyncLogRepository } from "../../features/sync"
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
  to: (room: string) => MockEmitChain
  emit: ReturnType<typeof mock>
}

function createMockIo() {
  const emitChains: Array<{ room: string; eventType: string; payload: unknown; namespace?: string }> = []

  const makeRoomChain = (room: string, namespace?: string): MockEmitChain => {
    const rooms = [room]
    const chain: MockEmitChain = {
      to(nextRoom: string) {
        rooms.push(nextRoom)
        return chain
      },
      emit: mock((eventType: string, payload: unknown) => {
        for (const target of rooms) emitChains.push({ room: target, eventType, payload, namespace })
      }),
    }
    return chain
  }

  // The handler emits once to the union of rooms (string[]); record one chain
  // entry per room so assertions stay per-room.
  const makeRoomsChain = (rooms: string | string[]): MockEmitChain => {
    const roomList = Array.isArray(rooms) ? rooms : [rooms]
    const chain: MockEmitChain = {
      to(room: string) {
        roomList.push(room)
        return chain
      },
      emit: mock((eventType: string, payload: unknown) => {
        for (const room of roomList) {
          emitChains.push({ room, eventType, payload })
        }
      }),
    }
    return chain
  }

  const namespaceCache = new Map<string, { to: (room: string) => MockEmitChain }>()
  const io = {
    to: mock((rooms: string | string[]): MockEmitChain => makeRoomsChain(rooms)),
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
  beforeEach(() => {
    // The handler sequences each batch into the sync log before emitting;
    // routing tests don't exercise the DB, so resolve with no assigned sync
    // ids (payloads pass through unchanged).
    spyOn(SyncLogRepository, "appendForWorkspace").mockResolvedValue(new Map())
  })

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

  it("should emit activity:read to the target user's room", async () => {
    const event = makeEvent(1n, "activity:read", {
      workspaceId: "ws_1",
      targetUserId: "usr_alice",
      activityIds: ["act_1"],
      streamIds: ["stream_1"],
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_alice",
      eventType: "activity:read",
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
      streamId: "stream_thread",
      deliverToStreamId: "stream_parent",
      stream: { id: "stream_thread", type: "thread", parentAnchorId: "msg_1" },
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

  it("should emit event-anchored stream:created to the parent stream room", async () => {
    const event = makeEvent(1n, "stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_thread",
      deliverToStreamId: "stream_parent",
      stream: { id: "stream_thread", type: "thread", parentAnchorId: "event_call" },
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
      stream: { id: "stream_new", parentAnchorId: null, type: "channel", visibility: "public" },
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
        parentAnchorId: null,
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
        parentAnchorId: null,
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
      stream: { id: "stream_dm", parentAnchorId: null, type: "dm" },
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

  it("fans stream:delegation_created to the stream room AND nudges the workspace runtime room (5.4 push)", async () => {
    const event = makeEvent(1n, "stream:delegation_created", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      event: {
        id: "event_1",
        streamId: "stream_a",
        eventType: "delegation:created",
        payload: { delegationId: "dlg_1", title: "Fix the build", brief: "…", contextRefs: [] },
      },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    // Viewers get the full card event on the stream room, as before.
    expect(emitChains.some((e) => e.room === "ws:ws_1:stream:stream_a")).toBe(true)
    // Every connected runtime in the workspace gets the slim nudge.
    expect(emitChains).toContainEqual({
      room: "bot:ws_1",
      eventType: "delegation:available",
      payload: { workspaceId: "ws_1", streamId: "stream_a", delegationId: "dlg_1", title: "Fix the build" },
      namespace: "/bot",
    })
  })

  it("re-nudges when a delegation status patch reopens it", async () => {
    const event = makeEvent(1n, "stream:delegation_status_changed", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      event: {
        id: "event_1",
        streamId: "stream_a",
        eventType: "delegation:status_changed",
        payload: { delegationId: "dlg_1", status: "open" },
      },
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])
    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))
    expect(emitChains).toContainEqual({
      room: "bot:ws_1",
      eventType: "delegation:available",
      payload: { workspaceId: "ws_1", streamId: "stream_a", delegationId: "dlg_1", title: undefined },
      namespace: "/bot",
    })
  })

  it("does not re-nudge for a non-open delegation status patch", async () => {
    const event = makeEvent(1n, "stream:delegation_status_changed", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      event: {
        id: "event_1",
        streamId: "stream_a",
        eventType: "delegation:status_changed",
        payload: { delegationId: "dlg_1", status: "claimed" },
      },
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])
    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))
    expect(emitChains.some((e) => e.eventType === "delegation:available")).toBe(false)
  })

  it("re-nudges the workspace runtime room when an approved bot_access request carries a delegation (F3)", async () => {
    const event = makeEvent(1n, "stream:bot_access_status_changed", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      event: {
        id: "event_1",
        streamId: "stream_a",
        eventType: "bot_access:status_changed",
        payload: {
          requestId: "bareq_1",
          status: "approved",
          resolvedBy: "usr_kris",
          delegationId: "dlg_1",
          delegationTitle: "Fix the build",
        },
      },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    // Viewers get the full patch event on the stream room.
    expect(emitChains.some((e) => e.room === "ws:ws_1:stream:stream_a")).toBe(true)
    // The granted runtime gets the same nudge shape as delegation:created.
    expect(emitChains).toContainEqual({
      room: "bot:ws_1",
      eventType: "delegation:available",
      payload: { workspaceId: "ws_1", streamId: "stream_a", delegationId: "dlg_1", title: "Fix the build" },
      namespace: "/bot",
    })
  })

  it("does NOT re-nudge on a denied request or an approval without a delegation (F3)", async () => {
    const denied = makeEvent(1n, "stream:bot_access_status_changed", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      event: {
        id: "event_1",
        streamId: "stream_a",
        eventType: "bot_access:status_changed",
        payload: { requestId: "bareq_1", status: "denied", resolvedBy: "usr_kris" },
      },
    })
    const approvedNoDelegation = makeEvent(2n, "stream:bot_access_status_changed", {
      workspaceId: "ws_1",
      streamId: "stream_a",
      event: {
        id: "event_2",
        streamId: "stream_a",
        eventType: "bot_access:status_changed",
        payload: { requestId: "bareq_2", status: "approved", resolvedBy: "usr_kris" },
      },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([denied, approvedNoDelegation])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains.some((e) => e.eventType === "delegation:available")).toBe(false)
  })

  // Bot-scoped events route into the `/bot` namespace using the narrowest room
  // a payload supports — see `BroadcastHandler.dispatchBotEvent`.
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

  it("routes bot:session_restored to the runtime and side-effect-free supervisor room", async () => {
    const event = makeEvent(4n, "bot:session_restored", {
      workspaceId: "ws_1",
      botId: "bot_alice",
      instanceId: "inst_42",
      runtimeSessionId: "sess_99",
      rootStreamId: "stream_pad",
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(emitChains.filter((entry) => entry.eventType === "bot:session_restored").map((entry) => entry.room)).toEqual(
      [
        "bot:ws_1:bot:bot_alice:session:sess_99",
        "bot:ws_1:bot:bot_alice:instance:inst_42",
        "bot:ws_1:bot:bot_alice:supervisor",
      ]
    )
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

  it("routes a label:assigned to the owning actor's user room", async () => {
    const event = makeEvent(1n, "label:assigned", {
      workspaceId: "ws_1",
      targetUserId: "usr_alice",
      assignment: { labelId: "label_1", resourceType: "stream", resourceId: "stream_1", userId: "usr_alice" },
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_alice",
      eventType: "label:assigned",
      payload: event.payload,
    })
  })

  it("routes a label:unassigned to the owning actor's user room", async () => {
    const event = makeEvent(1n, "label:unassigned", {
      workspaceId: "ws_1",
      targetUserId: "usr_bob",
      labelId: "label_1",
      resourceType: "stream",
      resourceId: "stream_1",
      userId: "usr_bob",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(emitChains).toContainEqual({
      room: "ws:ws_1:user:usr_bob",
      eventType: "label:unassigned",
      payload: event.payload,
    })
  })

  it("sequences the batch into the sync log per workspace, in outbox order, before emitting", async () => {
    const event1 = makeEvent(1n, "message:created", { workspaceId: "ws_1", streamId: "stream_1", event: { id: "e1" } })
    const event2 = makeEvent(2n, "message:created", { workspaceId: "ws_2", streamId: "stream_9", event: { id: "e2" } })
    const event3 = makeEvent(3n, "stream:activity", { workspaceId: "ws_1", streamId: "stream_1" })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event1, event2, event3])
    const appendSpy = spyOn(SyncLogRepository, "appendForWorkspace").mockImplementation(
      async (_pool, _workspaceId, entries) => new Map(entries.map((e, i) => [e.outboxEventId, BigInt(100 + i)]))
    )

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    const callsByWorkspace = new Map(appendSpy.mock.calls.map((call) => [call[1], call[2]]))
    expect(callsByWorkspace.get("ws_1")).toEqual([
      { outboxEventId: 1n, eventType: "message:created", groups: ["stream:stream_1"], payload: event1.payload },
      { outboxEventId: 3n, eventType: "stream:activity", groups: ["stream:stream_1"], payload: event3.payload },
    ])
    expect(callsByWorkspace.get("ws_2")).toEqual([
      { outboxEventId: 2n, eventType: "message:created", groups: ["stream:stream_9"], payload: event2.payload },
    ])

    // Emitted payloads carry the assigned sync id as a wire string
    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_1",
      eventType: "message:created",
      payload: { ...event1.payload, syncId: "100" },
    })
    expect(emitChains).toContainEqual({
      room: "ws:ws_1:stream:stream_1",
      eventType: "stream:activity",
      payload: { ...event3.payload, syncId: "101" },
    })
  })

  it("keeps bot-scoped events off the sync log", async () => {
    const event = makeEvent(1n, "bot_invocation:available", {
      workspaceId: "ws_1",
      botId: "bot_1",
      invocationId: "inv_1",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])
    const appendSpy = spyOn(SyncLogRepository, "appendForWorkspace").mockResolvedValue(new Map())

    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(appendSpy.mock.calls).toHaveLength(0)
    expect(emitChains).toContainEqual({
      room: "bot:ws_1:bot:bot_1",
      eventType: "bot_invocation:available",
      payload: event.payload,
      namespace: "/bot",
    })
  })

  it("returns an error without emitting when sequencing fails, so the batch is retried", async () => {
    const event = makeEvent(1n, "message:created", { workspaceId: "ws_1", streamId: "stream_1", event: { id: "e1" } })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event])
    spyOn(SyncLogRepository, "appendForWorkspace").mockRejectedValue(new Error("sync log unavailable"))

    let result: ProcessResult | undefined
    mockCursorLock((r) => {
      result = r
    })

    const { io, emitChains } = createMockIo()
    const botNamespace = io.of("/bot")
    const handler = new BroadcastHandler({} as any, io as any, botNamespace as any)
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(result?.status).toBe("error")
    expect(emitChains).toHaveLength(0)
  })

  it("routes metadata-only invocation controls by session, instance, then bot and drops malformed payloads without stalling the batch", async () => {
    const base = { workspaceId: "ws_1", botId: "bot_1", invocationId: "binv_1", sourceRevision: 2 }
    const events = [
      makeEvent(10n, "bot_invocation:input_updated", {
        ...base,
        targetInstanceId: "inst_1",
        targetRuntimeSessionId: "sess_1",
      }),
      makeEvent(11n, "bot_invocation:input_updated", {
        ...base,
        targetInstanceId: "inst_1",
        targetRuntimeSessionId: null,
      }),
      makeEvent(12n, "bot_invocation:cancelled", {
        ...base,
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        reason: "source_deleted",
      }),
      makeEvent(13n, "bot_invocation:input_updated", {
        ...base,
        sourceRevision: -1,
        promptMarkdown: "must not leak",
        targetInstanceId: null,
        targetRuntimeSessionId: null,
      }),
      makeEvent(14n, "bot_invocation:cancelled", {
        ...base,
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        reason: "invented",
      }),
      makeEvent(15n, "bot_invocation:cancelled", {
        ...base,
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        reason: "input_stale",
      }),
    ]
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue(events)
    const { handler, emitChains } = createHandler()
    handler.handle()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(emitChains.filter((entry) => entry.eventType.startsWith("bot_invocation:"))).toEqual([
      {
        room: "bot:ws_1:bot:bot_1:session:sess_1",
        eventType: "bot_invocation:input_updated",
        payload: events[0]!.payload,
        namespace: "/bot",
      },
      {
        room: "bot:ws_1:bot:bot_1:instance:inst_1",
        eventType: "bot_invocation:input_updated",
        payload: events[1]!.payload,
        namespace: "/bot",
      },
      {
        room: "bot:ws_1:bot:bot_1",
        eventType: "bot_invocation:cancelled",
        payload: events[2]!.payload,
        namespace: "/bot",
      },
      {
        room: "bot:ws_1:bot:bot_1",
        eventType: "bot_invocation:cancelled",
        payload: events[5]!.payload,
        namespace: "/bot",
      },
    ])
    expect(JSON.stringify(emitChains)).not.toContain("must not leak")
  })
})
