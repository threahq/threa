import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool, PoolClient } from "pg"
import { CommandKinds } from "@threa/types"
import { createCommandHandlers } from "./handlers"
import { CommandDispatchRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "../streams"
import * as streamsModule from "../streams"

function makePool(): Pool {
  const client = {
    query: mock(async () => ({ rows: [], rowCount: 0 })),
    release: mock(() => undefined),
  } as unknown as PoolClient
  return { connect: mock(async () => client) } as unknown as Pool
}

function makeResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
  return response as typeof response & Response
}

describe("command dispatch idempotency", () => {
  beforeEach(() => {
    spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([])
  })

  afterEach(() => {
    mock.restore()
  })

  const event = {
    id: "evt_existing",
    streamId: "stream_1",
    sequence: 7n,
    broadcastSequence: null,
    eventType: "command_dispatched" as const,
    payload: {
      commandId: "cmd_existing",
      name: "stop",
      args: "",
      status: "dispatched" as const,
      executionKind: CommandKinds.BOT_RUNTIME,
    },
    actorId: "usr_1",
    actorType: "user" as const,
    createdAt: new Date("2026-07-20T20:00:00.000Z"),
  }

  it("replays a committed dispatch before rechecking runtime availability", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    spyOn(CommandDispatchRepository, "findByClientId").mockResolvedValue({
      commandId: "cmd_existing",
      eventId: event.id,
    })
    spyOn(StreamEventRepository, "findById").mockResolvedValue(event)
    const resolveCommand = mock(async () => null)
    const handlers = createCommandHandlers({
      pool: makePool(),
      commandAvailabilityService: {
        resolveCommandForDispatch: resolveCommand,
        listStreamCommands: mock(async () => []),
        listWorkspaceCommands: mock(() => []),
      } as never,
      botRuntimeService: {} as never,
    })
    const req = {
      user: { id: "usr_1" },
      workspaceId: "ws_1",
      body: { streamId: "stream_1", command: "/stop", clientCommandId: "temp_cmd_1" },
    } as Request
    const res = makeResponse()

    await handlers.dispatch(req, res)

    expect({ status: res.statusCode, body: res.body, availabilityCalls: resolveCommand.mock.calls.length }).toEqual({
      status: 202,
      body: {
        success: true,
        commandId: "cmd_existing",
        command: "stop",
        args: "",
        event: { ...event, sequence: "7" },
      },
      availabilityCalls: 0,
    })
  })

  it("refuses replay after stream access is revoked", async () => {
    spyOn(streamsModule, "resolveLockedStreamAuthorities").mockRejectedValue(
      Object.assign(new Error("Stream not found"), { status: 404, code: "STREAM_NOT_FOUND" })
    )
    const findReplay = spyOn(CommandDispatchRepository, "findByClientId")
    const handlers = createCommandHandlers({
      pool: makePool(),
      commandAvailabilityService: {} as never,
      botRuntimeService: {} as never,
    })
    const req = {
      user: { id: "usr_1" },
      workspaceId: "ws_1",
      body: { streamId: "stream_1", command: "/stop", clientCommandId: "temp_cmd_1" },
    } as Request
    const res = makeResponse()

    await expect(handlers.dispatch(req, res)).rejects.toMatchObject({ status: 404, code: "STREAM_NOT_FOUND" })
    expect(findReplay).not.toHaveBeenCalled()
  })

  for (const executionKind of [CommandKinds.SERVER, CommandKinds.BOT_RUNTIME] as const) {
    it(`replays a committed work command under final locked read-only state for ${executionKind}`, async () => {
      const workEvent = {
        ...event,
        payload: { ...event.payload, name: "steer", executionKind },
      }
      spyOn(streamsModule, "resolveLockedStreamAuthorities").mockResolvedValue([
        { state: { readOnly: true, readOnlyReason: "archived" } } as never,
      ])
      spyOn(CommandDispatchRepository, "findByClientId")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ commandId: "cmd_existing", eventId: event.id })
      spyOn(StreamEventRepository, "findById").mockResolvedValue(workEvent)
      const insert = spyOn(StreamEventRepository, "insert")
      const createInvocation = mock(async () => undefined)
      const resolveInTransaction = mock(async () => null)
      const handlers = createCommandHandlers({
        pool: makePool(),
        commandAvailabilityService: {
          resolveCommandForDispatch: mock(async () => ({ executionKind, info: {} })),
          resolveCommandInTransaction: resolveInTransaction,
          listStreamCommands: mock(async () => []),
          listWorkspaceCommands: mock(() => []),
        } as never,
        botRuntimeService: { createInvocationInTransaction: createInvocation } as never,
      })
      const req = {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { streamId: "stream_1", command: "/steer continue", clientCommandId: "temp_cmd_1" },
      } as Request
      const res = makeResponse()

      await handlers.dispatch(req, res)

      expect({
        status: res.statusCode,
        commandId: (res.body as { commandId: string }).commandId,
        inserts: insert.mock.calls.length,
        invocations: createInvocation.mock.calls.length,
        transactionAvailabilityCalls: resolveInTransaction.mock.calls.length,
      }).toEqual({
        status: 202,
        commandId: "cmd_existing",
        inserts: 0,
        invocations: 0,
        transactionAvailabilityCalls: 0,
      })
    })
  }

  it("replays the winner when a concurrent request wins the idempotency claim", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    spyOn(CommandDispatchRepository, "findByClientId")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ commandId: "cmd_existing", eventId: event.id })
    spyOn(CommandDispatchRepository, "claim").mockResolvedValue(false)
    spyOn(StreamEventRepository, "findById").mockResolvedValue(event)
    const handlers = createCommandHandlers({
      pool: makePool(),
      commandAvailabilityService: {
        resolveCommandForDispatch: mock(async () => ({ executionKind: CommandKinds.SERVER, info: {} })),
        resolveCommandInTransaction: mock(async () => ({ executionKind: CommandKinds.SERVER, info: {} })),
        listStreamCommands: mock(async () => []),
        listWorkspaceCommands: mock(() => []),
      } as never,
      botRuntimeService: {} as never,
    })
    const req = {
      user: { id: "usr_1" },
      workspaceId: "ws_1",
      body: { streamId: "stream_1", command: "/stop", clientCommandId: "temp_cmd_1" },
    } as Request
    const res = makeResponse()

    await handlers.dispatch(req, res)

    expect({ status: res.statusCode, commandId: (res.body as { commandId: string }).commandId }).toEqual({
      status: 202,
      commandId: "cmd_existing",
    })
  })
  it("stamps the dispatching conversation onto a fresh server-command event", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    spyOn(CommandDispatchRepository, "findByClientId").mockResolvedValue(null)
    spyOn(CommandDispatchRepository, "claim").mockResolvedValue(true)
    const insert = spyOn(StreamEventRepository, "insert").mockResolvedValue(event)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const handlers = createCommandHandlers({
      pool: makePool(),
      commandAvailabilityService: {
        resolveCommandForDispatch: mock(async () => ({ executionKind: CommandKinds.SERVER, info: {} })),
        resolveCommandInTransaction: mock(async () => ({ executionKind: CommandKinds.SERVER, info: {} })),
        listStreamCommands: mock(async () => []),
        listWorkspaceCommands: mock(() => []),
      } as never,
      botRuntimeService: {} as never,
    })
    const req = {
      user: { id: "usr_1" },
      workspaceId: "ws_1",
      body: {
        streamId: "stream_1",
        command: "/stop",
        clientCommandId: "temp_cmd_1",
        conversationId: "conv_1",
      },
    } as Request
    const res = makeResponse()

    await handlers.dispatch(req, res)

    expect((insert.mock.calls[0][1].payload as { conversationId?: string }).conversationId).toBe("conv_1")
  })
})
