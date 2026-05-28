import { useCallback, useMemo } from "react"
import { useParams } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { DISCUSS_WITH_ARIADNE_COMMAND, type CommandInfo } from "@threa/types"
import type { CommandItem } from "./types"
import { CommandList } from "./command-list"
import { MEMO_SEARCH_SLASH_ACTION } from "./command-extension"
import { useWorkspaceMetadata } from "@/stores/workspace-store"
import { streamKeys } from "@/hooks/use-streams"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
import { useSuggestion } from "./use-suggestion"

/**
 * Filter commands by query string.
 * Matches against name and description, case-insensitive.
 */
function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  if (!query) return items

  const lowerQuery = query.toLowerCase()
  return items.filter(
    (item) => item.name.toLowerCase().includes(lowerQuery) || item.description.toLowerCase().includes(lowerQuery)
  )
}

export function resolveEffectiveCommandInfos(
  workspaceCommands: readonly CommandInfo[] | undefined,
  streamCommands: readonly CommandInfo[] | undefined
): readonly CommandInfo[] {
  return streamCommands ?? workspaceCommands ?? []
}

/**
 * Discovery shortcut surfaced in the `/` menu when memo embeds are enabled.
 * Picking it doesn't insert a chip — `CommandExtension.onSelectItem` types
 * `/memo ` to hand off to the memo-search trigger.
 */
const MEMO_SLASH_ITEM: CommandItem = {
  name: "memo",
  description: "Search and embed a memo",
  clientActionId: MEMO_SEARCH_SLASH_ACTION,
}

/**
 * Hook that manages the command suggestion state and provides render callbacks.
 * Returns configuration for the CommandExtension and a render function for the popup.
 *
 * Client-action commands (e.g. `/discuss-with-ariadne`) still insert a chip
 * into the composer via the normal suggestion flow; routing to the client
 * handler happens at composer-send time (`message-input.tsx`) so the user
 * gets the familiar "type command, press send" UX rather than an action
 * firing the moment they pick from the autocomplete.
 */
export function useCommandSuggestion({ includeMemoSearch = false }: { includeMemoSearch?: boolean } = {}) {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const metadata = useWorkspaceMetadata(workspaceId)
  const queryClient = useQueryClient()
  const streamBootstrapKey = workspaceId && streamId ? streamKeys.bootstrap(workspaceId, streamId) : null
  const { data: streamBootstrap } = useQuery({
    queryKey: streamBootstrapKey ?? ["streams", "bootstrap", workspaceId ?? "", ""],
    queryFn: () =>
      streamBootstrapKey ? (queryClient.getQueryData<CachedStreamBootstrap>(streamBootstrapKey) ?? null) : null,
    enabled: false,
    staleTime: Infinity,
  })

  const commands = useMemo<CommandItem[]>(() => {
    const effective = resolveEffectiveCommandInfos(metadata?.commands, streamBootstrap?.commands)
    const serverCommands = effective
      .filter((cmd) => {
        // Gate discuss-with-ariadne on there being a source stream to reference.
        if (cmd.clientActionId === DISCUSS_WITH_ARIADNE_COMMAND) return !!streamId
        return true
      })
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        kind: cmd.kind,
        scope: cmd.scope,
        args: cmd.args,
        clientActionId: cmd.clientActionId,
      }))
    return includeMemoSearch ? [MEMO_SLASH_ITEM, ...serverCommands] : serverCommands
  }, [metadata?.commands, streamBootstrap?.commands, streamId, includeMemoSearch])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: CommandItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: CommandItem) => void
    }) => <CommandList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive } = useSuggestion<CommandItem>({
    extensionName: "slashCommand",
    getItems: () => commands,
    filterItems: filterCommands,
    renderList,
  })

  return {
    suggestionConfig,
    renderCommandList: renderSuggestionList,
    isActive,
  }
}
