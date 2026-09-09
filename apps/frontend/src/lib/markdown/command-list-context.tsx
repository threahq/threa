import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { CommandArgumentInfo, CommandInfo } from "@threahq/types"

/** What a command answers to, for rendering its arguments in a posted message. */
export interface CommandArgNames {
  /** Flag names without the leading `/`: `model`, `thinking`. */
  flags: ReadonlySet<string>
  /** The values its leading positional argument advertises: `claude`, `pi`. */
  values: ReadonlySet<string>
}

interface CommandListContextValue {
  isKnownCommand: (name: string) => boolean
  commandArgs: (name: string) => CommandArgNames
}

const CommandListContext = createContext<CommandListContextValue | null>(null)

export const NO_ARGS: CommandArgNames = { flags: new Set(), values: new Set() }

interface CommandListProviderProps {
  commands: readonly CommandInfo[]
  children: ReactNode
}

/**
 * Every flag a command answers to, including the ones a positional value carries
 * (`/spawn`'s runtimes each declare their own `/model`), plus the values its
 * positional arguments advertise. Only advertised values are collected: a
 * command's free text (a session name, a steer) is prose, not an argument.
 */
function argNames(args: readonly CommandArgumentInfo[] | undefined): CommandArgNames {
  const flags = new Set<string>()
  const values = new Set<string>()
  const collect = (list: readonly CommandArgumentInfo[] | undefined) => {
    for (const arg of list ?? []) {
      const isFlag = arg.name.startsWith("/")
      if (isFlag) flags.add(arg.name.slice(1).toLowerCase())
      for (const suggestion of arg.suggestions ?? []) {
        if (!isFlag) values.add(suggestion.value.toLowerCase())
        collect(suggestion.args)
      }
    }
  }
  collect(args)
  return { flags, values }
}

/**
 * Provides the registered slash commands for rendering.
 *
 * Rendered text like "/foo" is only styled as a command chip when `foo` is a
 * real command — matching how mentions, channels, and emojis only render as
 * chips when they resolve to real entities. Without a provider, no text is
 * treated as a command.
 */
export function CommandListProvider({ commands, children }: CommandListProviderProps) {
  const value = useMemo<CommandListContextValue>(() => {
    const byName = new Map(commands.map((command) => [command.name.toLowerCase(), command]))
    const argsByName = new Map<string, CommandArgNames>()
    return {
      isKnownCommand: (name) => byName.has(name.toLowerCase()),
      commandArgs: (name) => {
        const key = name.toLowerCase()
        const cached = argsByName.get(key)
        if (cached) return cached
        const command = byName.get(key)
        if (!command) return NO_ARGS
        const names = argNames(command.args)
        argsByName.set(key, names)
        return names
      },
    }
  }, [commands])

  return <CommandListContext.Provider value={value}>{children}</CommandListContext.Provider>
}

/**
 * Returns a predicate that reports whether a slash command name is known.
 * Defaults to returning false when no provider is mounted, so untrusted text
 * never renders as a command chip.
 */
export function useIsKnownCommand(): (name: string) => boolean {
  const context = useContext(CommandListContext)
  return context?.isKnownCommand ?? (() => false)
}

/**
 * Returns a lookup of the arguments a command declares, so a message that opens
 * with that command renders `/model opus` as its arguments rather than as prose.
 */
export function useCommandArgs(): (name: string) => CommandArgNames {
  const context = useContext(CommandListContext)
  return context?.commandArgs ?? (() => NO_ARGS)
}
