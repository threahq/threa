import { serializeBigInt } from "@threa/backend-common"
import {
  AuthorTypes,
  CommandKinds,
  type CommandCompletedPayload,
  type CommandDispatchedPayload,
  type CommandFailedPayload,
} from "@threa/types"
import type { Querier } from "../../db"
import { eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository, type StreamEvent } from "../streams"

export interface RuntimeCommandInvocationMetadata {
  command: {
    id: string
    name: string
    args: string
    executionKind: typeof CommandKinds.BOT_RUNTIME
  }
}

export function buildRuntimeCommandInvocationMetadata(params: {
  commandId: string
  name: string
  args: string
}): RuntimeCommandInvocationMetadata {
  return {
    command: {
      id: params.commandId,
      name: params.name,
      args: params.args,
      executionKind: CommandKinds.BOT_RUNTIME,
    },
  }
}

export function parseRuntimeCommandInvocationMetadata(
  metadata: Record<string, unknown>
): RuntimeCommandInvocationMetadata["command"] | null {
  const command = metadata.command
  if (!command || typeof command !== "object") return null
  const value = command as Record<string, unknown>
  if (value.executionKind !== CommandKinds.BOT_RUNTIME) return null
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.args !== "string") return null
  return { id: value.id, name: value.name, args: value.args, executionKind: CommandKinds.BOT_RUNTIME }
}

export async function insertCommandDispatchedEvent(
  db: Querier,
  params: {
    workspaceId: string
    streamId: string
    userId: string
    commandId: string
    name: string
    args: string
    executionKind?: "server" | "bot-runtime"
  }
): Promise<StreamEvent> {
  const evt = await StreamEventRepository.insert(db, {
    id: eventId(),
    streamId: params.streamId,
    eventType: "command_dispatched",
    payload: {
      commandId: params.commandId,
      name: params.name,
      args: params.args,
      status: "dispatched",
      ...(params.executionKind && { executionKind: params.executionKind }),
    } satisfies CommandDispatchedPayload,
    actorId: params.userId,
    actorType: AuthorTypes.USER,
  })

  await OutboxRepository.insert(db, "command:dispatched", {
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    event: serializeBigInt(evt),
    authorId: params.userId,
  })

  return evt
}

export async function insertCommandCompletedEvent(
  db: Querier,
  params: { workspaceId: string; streamId: string; userId: string; commandId: string; result?: unknown }
): Promise<StreamEvent> {
  const evt = await StreamEventRepository.insert(db, {
    id: eventId(),
    streamId: params.streamId,
    eventType: "command_completed",
    payload: { commandId: params.commandId, result: params.result } satisfies CommandCompletedPayload,
    actorId: params.userId,
    actorType: AuthorTypes.USER,
  })

  await OutboxRepository.insert(db, "command:completed", {
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    authorId: params.userId,
    event: serializeBigInt(evt),
  })

  return evt
}

export async function insertCommandFailedEvent(
  db: Querier,
  params: { workspaceId: string; streamId: string; userId: string; commandId: string; error: string }
): Promise<StreamEvent> {
  const evt = await StreamEventRepository.insert(db, {
    id: eventId(),
    streamId: params.streamId,
    eventType: "command_failed",
    payload: { commandId: params.commandId, error: params.error } satisfies CommandFailedPayload,
    actorId: params.userId,
    actorType: AuthorTypes.USER,
  })

  await OutboxRepository.insert(db, "command:failed", {
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    authorId: params.userId,
    event: serializeBigInt(evt),
  })

  return evt
}
