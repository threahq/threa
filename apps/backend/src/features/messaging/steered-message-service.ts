import { HttpError } from "@threa/backend-common"
import { CommandKinds, MessageErrorCodes } from "@threa/types"
import type { Querier } from "../../db"
import { commandId as generateCommandId } from "../../lib/id"
import type { BotRuntimeService } from "../bot-runtimes"
import {
  insertCommandDispatchedEvent,
  resolveRuntimeInvocationRouting,
  type CommandAvailabilityService,
} from "../commands"
import type { Message } from "./repository"

export class SteeredMessageService {
  constructor(
    private readonly deps: {
      commandAvailabilityService: CommandAvailabilityService
      botRuntimeService: BotRuntimeService
    }
  ) {}

  async dispatchInTransaction(
    db: Querier,
    params: { workspaceId: string; streamId: string; userId: string; message: Message }
  ): Promise<void> {
    const resolved = await this.deps.commandAvailabilityService.resolveCommandInTransaction(db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      streamId: params.streamId,
      name: "steer",
    })
    if (!resolved || resolved.executionKind !== CommandKinds.BOT_RUNTIME) {
      throw new HttpError("Steer is not available in this stream", {
        status: 409,
        code: MessageErrorCodes.STEER_UNAVAILABLE,
      })
    }

    const target = resolved.runtime
    await this.deps.botRuntimeService.createInvocationInTransaction(db, {
      workspaceId: params.workspaceId,
      rootStreamId: target.rootStreamId,
      activeStreamId: target.activeStreamId,
      sourceMessageId: params.message.id,
      responseStreamId: target.responseStreamId,
      actorId: target.botId,
      trigger: "active-scratchpad",
      requiredCapability: "active-scratchpad",
      promptMarkdown: params.message.contentMarkdown,
      authorUserId: params.userId,
      targetInstanceId: target.targetInstanceId,
      targetRuntimeSessionId: target.targetRuntimeSessionId,
      metadata: {},
    })

    const commandId = generateCommandId()
    await insertCommandDispatchedEvent(db, {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      userId: params.userId,
      commandId,
      name: "steer",
      args: "",
      executionKind: CommandKinds.BOT_RUNTIME,
    })

    const routing = resolveRuntimeInvocationRouting("steer", target.runtimeKind)
    await this.deps.botRuntimeService.createInvocationInTransaction(db, {
      workspaceId: params.workspaceId,
      rootStreamId: target.rootStreamId,
      activeStreamId: target.activeStreamId,
      sourceMessageId: params.message.id,
      responseStreamId: target.responseStreamId,
      actorId: target.botId,
      trigger: routing.trigger,
      requiredCapability: routing.requiredCapability,
      promptMarkdown: "/steer",
      authorUserId: params.userId,
      targetInstanceId: target.targetInstanceId,
      targetRuntimeSessionId: target.targetRuntimeSessionId,
      metadata: {
        command: {
          id: commandId,
          name: "steer",
          args: "",
          executionKind: CommandKinds.BOT_RUNTIME,
        },
      },
    })
  }
}
