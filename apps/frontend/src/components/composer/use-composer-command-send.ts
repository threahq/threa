import { useCallback, useMemo } from "react"
import { ASIDE_COMMAND, type CommandInfo, type JSONContent } from "@threa/types"
import { serializeToMarkdown } from "@threa/prosemirror"
import { extractCommandNode, extractCommandFromRawText, extractSteerDirective } from "@/lib/commands"
import { useCommandDispatchQueue } from "@/hooks/use-command-dispatch-queue"
import { useOpenAside } from "@/hooks/use-open-aside"
import { useStreamCommands } from "@/hooks/use-stream-commands"

/** A send that resolved to a slash command rather than a message. */
export interface ComposerCommandPlan {
  kind: "command"
  commandName: string
  clientActionId: string | null
  commandMarkdown: string
}

/** `/steer` embedded in authored content: stays on the message path, flagged. */
export interface ComposerSteerMessagePlan {
  kind: "steer-message"
  content: JSONContent
}

export type ComposerSendPlan = ComposerCommandPlan | ComposerSteerMessagePlan | null

/**
 * Send-time command routing, shared by every composer that can dispatch (the
 * timeline input and the board/panel conversation composers). Command detection
 * reads the SAME effective list the `/` palette does ({@link useStreamCommands}),
 * so a command the palette just offered is always dispatchable and nothing the
 * palette doesn't know is intercepted — unknown `/text` still sends as text.
 */
export function useComposerCommandSend(
  workspaceId: string,
  streamId: string | undefined,
  /**
   * The conversation this composer writes into, stamped on the dispatch so the
   * card can draw the chip. Absent for a stream-level composer (the timeline),
   * whose commands stay off the board.
   */
  conversationId?: string
) {
  const availableCommands = useStreamCommands(workspaceId, streamId)
  const openAside = useOpenAside(workspaceId)
  const { queueCommand } = useCommandDispatchQueue(workspaceId, streamId ?? "")

  const availableCommandByName = useMemo(() => {
    const map = new Map<string, CommandInfo>()
    for (const cmd of availableCommands) map.set(cmd.name.toLowerCase(), cmd)
    return map
  }, [availableCommands])

  /**
   * Classify a composed doc: a command dispatch, a steer-flagged message, or
   * `null` for an ordinary message. Dispatch covers both a materialized
   * `slashCommand` node and raw text matching an available command (e.g.
   * `/model ` typed with a trailing space, which never became a node).
   */
  const planSend = useCallback(
    (content: JSONContent): ComposerSendPlan => {
      const steerDirective = availableCommandByName.has("steer") ? extractSteerDirective(content) : null
      if (steerDirective?.hasMessageContent) return { kind: "steer-message", content: steerDirective.content }
      if (steerDirective) {
        return { kind: "command", commandName: "steer", clientActionId: null, commandMarkdown: "/steer" }
      }

      const commandNode = extractCommandNode(content)
      const rawTextCommand = commandNode === null ? extractCommandFromRawText(content) : null
      const resolved =
        commandNode ?? (rawTextCommand ? (availableCommandByName.get(rawTextCommand.name) ?? null) : null)
      if (resolved === null) return null

      const commandName = commandNode?.name ?? rawTextCommand!.name
      return {
        kind: "command",
        commandName,
        clientActionId: commandNode?.clientActionId ?? resolved.clientActionId ?? null,
        commandMarkdown: rawTextCommand
          ? `/${commandName}${rawTextCommand.args ? ` ${rawTextCommand.args}` : ""}`
          : serializeToMarkdown(content).trim(),
      }
    },
    [availableCommandByName]
  )

  /**
   * Run a planned command. Client-action commands route locally (`/aside`
   * opens an aside beside this surface) and swallow their failure — the hook
   * already toasts, so a second inline error would render the same failure
   * twice. A runtime dispatch throws, leaving the surface to report.
   */
  const dispatchCommand = useCallback(
    async (plan: ComposerCommandPlan) => {
      if (plan.clientActionId === ASIDE_COMMAND) {
        if (!streamId) return
        try {
          await openAside(
            conversationId
              ? { kind: "conversation", hostStreamId: streamId, conversationId }
              : { kind: "stream", hostStreamId: streamId }
          )
        } catch {
          /* hook already toasted; composer stays clean */
        }
        return
      }
      await queueCommand({
        commandMarkdown: plan.commandMarkdown,
        commandName: plan.commandName,
        ...(conversationId && { conversationId }),
      })
    },
    [conversationId, queueCommand, openAside, streamId]
  )

  return { availableCommands, planSend, dispatchCommand }
}
