import { useCallback, useMemo, useRef } from "react"
import { useParams } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Editor } from "@tiptap/react"
import { DISCUSS_WITH_ARIADNE_COMMAND, type CommandInfo } from "@threa/types"
import type { CommandItem } from "./types"
import { CommandList } from "./command-list"
import { MEMO_SEARCH_SLASH_ACTION, GIPHY_SLASH_ACTION } from "./command-extension"
import { useWorkspaceMetadata } from "@/stores/workspace-store"
import { streamKeys } from "@/hooks/use-streams"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
import { useSuggestion } from "./use-suggestion"

/**
 * True when the `/` that opened the palette is the only content of the message
 * (ignoring surrounding whitespace) — i.e. the user typed `/<query>` and nothing
 * else. Whole-message commands (`/invite`, `/discuss`) are gated on this so they
 * don't surface when the slash is used mid-sentence.
 */
function slashOpensMessage(editor: Editor | undefined, query: string): boolean {
  if (!editor) return true
  return editor.state.doc.textContent.trim() === `/${query}`
}

/**
 * Filter commands by query string and cursor context.
 *
 * Matches name/description case-insensitively, and drops whole-message commands
 * (anything not `placement: "inline"`) unless the slash opens the message.
 */
export function filterCommands(items: CommandItem[], query: string, editor?: Editor): CommandItem[] {
  const opensMessage = slashOpensMessage(editor, query)
  const lowerQuery = query.toLowerCase()
  return items.filter((item) => {
    if (item.placement !== "inline" && !opensMessage) return false
    if (!lowerQuery) return true
    return item.name.toLowerCase().includes(lowerQuery) || item.description.toLowerCase().includes(lowerQuery)
  })
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
  // Memo embeds drop into prose, so the discovery entry surfaces mid-sentence too.
  placement: "inline",
}

/**
 * Discovery shortcut for the GIF picker. Like the memo entry it inserts no chip;
 * selecting it opens the picker (see the `command` wrapper in `renderList`) and
 * the chosen GIF is attached to the message. Inline placement so it's available
 * everywhere — mid-sentence too — the same way `/memo` is.
 */
const GIPHY_SLASH_ITEM: CommandItem = {
  name: "giphy",
  description: "Search and attach a GIF",
  clientActionId: GIPHY_SLASH_ACTION,
  placement: "inline",
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
export function useCommandSuggestion({
  includeMemoSearch = false,
  includeGiphy = false,
  onOpenGiphy,
}: {
  includeMemoSearch?: boolean
  includeGiphy?: boolean
  onOpenGiphy?: () => void
} = {}) {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  // Held in a ref so the `renderList` callback stays referentially stable (the
  // TipTap extension captures it once) even as the host re-renders.
  const onOpenGiphyRef = useRef(onOpenGiphy)
  onOpenGiphyRef.current = onOpenGiphy
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
    return [
      ...(includeMemoSearch ? [MEMO_SLASH_ITEM] : []),
      ...(includeGiphy ? [GIPHY_SLASH_ITEM] : []),
      ...serverCommands,
    ]
  }, [metadata?.commands, streamBootstrap?.commands, streamId, includeMemoSearch, includeGiphy])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: CommandItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: CommandItem) => void
    }) => {
      // Picking the giphy entry runs the normal command (which removes the typed
      // `/giphy` via the extension's onSelectItem) and then opens the picker. The
      // picker lives in React, so the open has to fire here rather than inside
      // the TipTap extension.
      const command = (item: CommandItem) => {
        props.command(item)
        if (item.clientActionId === GIPHY_SLASH_ACTION) onOpenGiphyRef.current?.()
      }
      return <CommandList ref={props.ref} items={props.items} clientRect={props.clientRect} command={command} />
    },
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
