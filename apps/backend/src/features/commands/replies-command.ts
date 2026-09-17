import type { Pool } from "pg"
import { RUNTIME_REPLY_MODES, StreamTypes, type RuntimeReplyMode } from "@threahq/types"
import { withTransaction, type Querier } from "../../db"
import { BotRuntimeSessionLinkRepository, resolveLinkedRuntimeRouteTarget } from "../bot-runtimes"
import { StreamRepository, type Stream } from "../streams"
import type { Command, CommandContext, CommandResult } from "./registry"

export const REPLIES_COMMAND = "replies"

export interface RepliesResult {
  replyMode: RuntimeReplyMode
}

/**
 * /replies [thread|flat] — where the session linked to this scratchpad answers
 * messages posted at its root. Bare `/replies` reports the current mode.
 */
export class RepliesCommand implements Command {
  name = REPLIES_COMMAND
  description = "Choose whether the linked session replies in threads or in the scratchpad"
  args = [
    {
      name: "mode",
      required: false,
      description: "Where replies go",
      suggestions: [
        { value: "thread", description: "In a thread on each message" },
        { value: "flat", description: "In the scratchpad" },
      ],
    },
  ]

  constructor(private readonly deps: { pool: Pool }) {}

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const args = ctx.args.trim().toLowerCase()
    if (args && !isReplyMode(args)) {
      return { success: false, error: "Usage: /replies [thread|flat]" }
    }
    const requested = args ? (args as RuntimeReplyMode) : null

    return withTransaction(this.deps.pool, async (db) => {
      const stream = await StreamRepository.findByIdForWorkspace(db, ctx.streamId, ctx.workspaceId)
      const link = stream && isRepliesStream(stream) ? await findRootLink(db, stream) : null
      if (!link) {
        return { success: false, error: "/replies needs a scratchpad with a linked session" }
      }
      if (!requested) return { success: true, result: { replyMode: link.replyMode } satisfies RepliesResult }

      const updated = await BotRuntimeSessionLinkRepository.setReplyMode(db, {
        workspaceId: ctx.workspaceId,
        linkId: link.id,
        replyMode: requested,
      })
      if (!updated) return { success: false, error: "The linked session ended before the change was saved" }
      return { success: true, result: { replyMode: updated.replyMode } satisfies RepliesResult }
    })
  }
}

function isReplyMode(value: string): value is RuntimeReplyMode {
  return (RUNTIME_REPLY_MODES as readonly string[]).includes(value)
}

function isRepliesStream(stream: Stream): boolean {
  return stream.type === StreamTypes.SCRATCHPAD && !stream.rootStreamId
}

async function findRootLink(db: Querier, stream: Stream) {
  const target = await resolveLinkedRuntimeRouteTarget(db, {
    workspaceId: stream.workspaceId,
    rootStreamId: stream.id,
    activeStreamId: stream.id,
  })
  return target?.link ?? null
}

export async function isRepliesAvailableInStream(db: Querier, stream: Stream): Promise<boolean> {
  return isRepliesStream(stream) && (await findRootLink(db, stream)) !== null
}
