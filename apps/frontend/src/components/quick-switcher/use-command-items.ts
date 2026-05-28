import { useMemo } from "react"
import { commands, type CommandContext } from "./commands"
import type { ModeResult, QuickSwitcherItem } from "./types"

interface UseCommandItemsParams {
  query: string
  commandContext: CommandContext
}

export function useCommandItems({ query, commandContext }: UseCommandItemsParams): ModeResult {
  const items = useMemo(() => {
    const lowerQuery = query.toLowerCase()

    const filteredCommands = query
      ? commands.filter((command) => {
          const searchValue = [command.id, command.label, ...(command.keywords ?? [])].join(" ").toLowerCase()
          return searchValue.includes(lowerQuery)
        })
      : commands

    return filteredCommands.map(
      (command): QuickSwitcherItem => ({
        id: command.id,
        label: command.label,
        icon: command.icon,
        group: "Commands",
        onSelect: () => {
          command.action(commandContext)
        },
      })
    )
  }, [query, commandContext])

  return {
    items,
    emptyMessage: "No commands found.",
  }
}
