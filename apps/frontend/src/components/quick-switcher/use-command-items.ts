import { useMemo } from "react"
import { isDraftId } from "@/hooks"
import { commands, type Command, type CommandContext } from "./commands"
import { draftStreamCommands, streamCommands } from "./stream-commands"
import type { ModeResult, QuickSwitcherItem } from "./types"

interface UseCommandItemsParams {
  query: string
  commandContext: CommandContext
}

export function useCommandItems({ query, commandContext }: UseCommandItemsParams): ModeResult {
  const items = useMemo(() => {
    const { currentStreamId, currentStreamName } = commandContext
    const lowerQuery = query.toLowerCase()

    const matchesQuery = (command: Command) => {
      if (!query) return true
      const searchValue = [command.id, command.label, ...(command.keywords ?? [])].join(" ").toLowerCase()
      return searchValue.includes(lowerQuery)
    }

    const toItem = (command: Command, group: string): QuickSwitcherItem => ({
      id: command.id,
      label: command.label,
      icon: command.icon,
      group,
      onSelect: () => {
        command.action(commandContext)
      },
    })

    // Contextual commands act on the stream in view. The section header names
    // the stream so it stays clear these are stream-specific even while the
    // list is filtered down by a query. Draft scratchpads have no server-side
    // settings/files/labels, so they only get a delete command.
    let contextualCommands: Command[] = []
    if (currentStreamId) {
      contextualCommands = isDraftId(currentStreamId) ? draftStreamCommands : streamCommands
    }
    const contextualGroup = currentStreamName ? `This stream — ${currentStreamName}` : "This stream"
    const contextualItems = contextualCommands.filter(matchesQuery).map((c) => toItem(c, contextualGroup))

    const globalItems = commands.filter(matchesQuery).map((c) => toItem(c, "Commands"))

    return [...contextualItems, ...globalItems]
  }, [query, commandContext])

  return {
    items,
    emptyMessage: "No commands found.",
  }
}
