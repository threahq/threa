import { useMemo } from "react"
import { isDraftId } from "@/hooks"
import { rankMatches } from "@/lib/match-score"
import { commands, type Command, type CommandContext } from "./commands"
import { draftStreamCommands, streamCommands } from "./stream-commands"
import type { ModeResult, QuickSwitcherItem } from "./types"

interface UseCommandItemsParams {
  query: string
  commandContext: CommandContext
}

/**
 * Filter and rank palette commands for a query. The visible label is the
 * primary match target; id and keywords are hidden aliases scored a tier
 * below, so a command whose label matches always outranks one that only
 * matches on an alias, regardless of definition order. Ties keep the curated
 * array order.
 */
export function rankCommands(candidates: Command[], query: string): Command[] {
  return rankMatches(candidates, query, (command) => ({
    labels: [command.label],
    keywords: [command.id, ...(command.keywords ?? [])],
  }))
}

export function useCommandItems({ query, commandContext }: UseCommandItemsParams): ModeResult {
  const items = useMemo(() => {
    const { currentStreamId, currentStreamName } = commandContext

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
    // Each group is ranked independently — the list renders grouped, so
    // cross-group ordering is the section order, not match quality.
    const contextualItems = rankCommands(contextualCommands, query).map((c) => toItem(c, contextualGroup))

    const globalItems = rankCommands(commands, query).map((c) => toItem(c, "Commands"))

    return [...contextualItems, ...globalItems]
  }, [query, commandContext])

  return {
    items,
    emptyMessage: "No commands found.",
  }
}
