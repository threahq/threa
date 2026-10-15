import { HttpError } from "@threahq/backend-common"
import { CommandKinds, ENQUEUE_COMMAND, MessageErrorCodes } from "@threahq/types"
import type { Querier } from "../../db"
import type { BotRuntimeService } from "../bot-runtimes"
import type { CommandAvailabilityService } from "../commands"
import type { Message } from "./repository"

export class EnqueuedMessageService {
  constructor(
    private readonly deps: {
      commandAvailabilityService: CommandAvailabilityService
      botRuntimeService: BotRuntimeService
    }
  ) {}

  async enqueueInTransaction(
    db: Querier,
    params: { workspaceId: string; streamId: string; userId: string; message: Message }
  ): Promise<void> {
    const resolved = await this.deps.commandAvailabilityService.resolveCommandInTransaction(db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      streamId: params.streamId,
      name: ENQUEUE_COMMAND,
    })
    const enqueued =
      resolved?.executionKind === CommandKinds.BOT_RUNTIME &&
      (await this.deps.botRuntimeService.enqueueMessageInTransaction(db, {
        workspaceId: params.workspaceId,
        sourceMessageId: params.message.id,
        botId: resolved.runtime.botId,
      }))
    if (!enqueued) {
      throw new HttpError("Enqueue is not available for this message", {
        status: 409,
        code: MessageErrorCodes.ENQUEUE_UNAVAILABLE,
      })
    }
  }
}
