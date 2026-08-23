import { useCallback, useMemo, useRef } from "react"
import { useParams } from "react-router-dom"
import type { Editor } from "@tiptap/react"
import { ASIDE_COMMAND } from "@threa/types"
import type { CommandItem } from "./types"
import { CommandList } from "./command-list"
import {
  MEMO_SEARCH_SLASH_ACTION,
  GIPHY_SLASH_ACTION,
  SNIPPET_SLASH_ACTION,
  ATTACHMENT_SLASH_ACTION,
} from "./command-extension"
import { rankMatches } from "@/lib/match-score"
import { useStreamCommands } from "@/hooks/use-stream-commands"
import { useSuggestion } from "./use-suggestion"

/**
 * True when the `/` that opened the palette is the only content of the message
 * (ignoring surrounding whitespace) — i.e. the user typed `/<query>` and nothing
 * else. Whole-message commands (`/invite`, `/aside`) are gated on this so they
 * don't surface when the slash is used mid-sentence.
 */
function slashOpensMessage(editor: Editor | undefined, query: string): boolean {
  if (!editor) return true
  return editor.state.doc.textContent.trim() === `/${query}`
}

/**
 * Filter commands by query string and cursor context.
 *
 * Drops whole-message commands (anything not `placement: "inline"`) unless the
 * slash opens the message, then ranks by match location: the command name is
 * the visible label, the description a hidden alias a tier below, so
 * name matches always sort above description-only matches.
 */
export function filterCommands(items: CommandItem[], query: string, editor?: Editor): CommandItem[] {
  const opensMessage = slashOpensMessage(editor, query)
  const placed = items.filter((item) => item.placement === "inline" || opensMessage)
  return rankMatches(placed, query, (item) => ({ labels: [item.name], keywords: [item.description] }))
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
 * Discovery shortcut for creating a snippet attachment. Like the memo/giphy
 * entries it inserts no chip — selecting it removes the typed `/snippet` and the
 * React layer (see `renderList`) opens the snippet editor. Inline placement so
 * it's reachable mid-message too.
 */
const SNIPPET_SLASH_ITEM: CommandItem = {
  name: "snippet",
  description: "Attach a block of text or code",
  clientActionId: SNIPPET_SLASH_ACTION,
  placement: "inline",
}

/**
 * Discovery shortcut for placing an attachment at the caret. Inserts no chip —
 * selecting it removes the typed `/attachment` and the React layer (see
 * `renderList`) opens the attachment picker. Inline placement: a reference
 * belongs mid-sentence, the same way `/memo` does.
 */
const ATTACHMENT_SLASH_ITEM: CommandItem = {
  name: "attachment",
  description: "Place an attached file at the cursor",
  clientActionId: ATTACHMENT_SLASH_ACTION,
  placement: "inline",
}

/**
 * Client-action commands (e.g. `/aside`) still insert a chip
 * into the composer via the normal suggestion flow; routing to the client
 * handler happens at composer-send time (`message-input.tsx`) so the user
 * gets the familiar "type command, press send" UX rather than an action
 * firing the moment they pick from the autocomplete.
 */
export function useCommandSuggestion({
  includeMemoSearch = false,
  includeGiphy = false,
  includeSnippet = false,
  includeAttachment = false,
  onOpenGiphy,
  onOpenSnippet,
  onOpenAttachment,
  onCommandPicked,
  commandStreamId,
  includeStreamCommands = true,
}: {
  includeMemoSearch?: boolean
  includeGiphy?: boolean
  includeSnippet?: boolean
  includeAttachment?: boolean
  onOpenGiphy?: () => void
  onOpenSnippet?: () => void
  onOpenAttachment?: () => void
  /**
   * Fired after a command is inserted into the composer (post chip insertion).
   * The host uses it to open the argument option picker for commands that
   * advertise `args[].suggestions` (e.g. `/model`).
   */
  onCommandPicked?: (item: CommandItem) => void
  /**
   * Scopes the palette to a stream the route can't name — the conversation panel
   * is a `?panel=conv:` overlay, so its commands come from the conversation's own
   * stream, not the host route's. Supplying the prop AT ALL (even as `null`,
   * meaning "no stream yet") takes the route param out of play: a panel opened
   * over an unrelated stream must never inherit that stream's runtime commands.
   */
  commandStreamId?: string | null
  /**
   * False leaves only the editor's own `/` items (memo search, giphy, snippet,
   * attachment): no workspace, stream or runtime command — for an editor whose
   * content is never sent from where it is written, so a dispatch would land
   * elsewhere.
   */
  includeStreamCommands?: boolean
} = {}) {
  const { workspaceId, streamId: routeStreamId } = useParams<{ workspaceId: string; streamId: string }>()
  const streamId = commandStreamId !== undefined ? (commandStreamId ?? undefined) : routeStreamId
  // Held in a ref so the `renderList` callback stays referentially stable (the
  // TipTap extension captures it once) even as the host re-renders.
  const onOpenGiphyRef = useRef(onOpenGiphy)
  onOpenGiphyRef.current = onOpenGiphy
  const onOpenSnippetRef = useRef(onOpenSnippet)
  onOpenSnippetRef.current = onOpenSnippet
  const onOpenAttachmentRef = useRef(onOpenAttachment)
  onOpenAttachmentRef.current = onOpenAttachment
  const onCommandPickedRef = useRef(onCommandPicked)
  onCommandPickedRef.current = onCommandPicked
  const streamCommands = useStreamCommands(workspaceId, streamId)
  const effectiveCommands = includeStreamCommands ? streamCommands : []

  const commands = useMemo<CommandItem[]>(() => {
    const serverCommands = effectiveCommands
      .filter((cmd) => {
        // Gate the client actions that reference this stream on there being one.
        if (cmd.clientActionId === ASIDE_COMMAND) return !!streamId
        return true
      })
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        kind: cmd.kind,
        scope: cmd.scope,
        args: cmd.args,
        clientActionId: cmd.clientActionId,
        ...(cmd.name === "steer" && { placement: "inline" as const }),
      }))
    return [
      ...(includeMemoSearch ? [MEMO_SLASH_ITEM] : []),
      ...(includeGiphy ? [GIPHY_SLASH_ITEM] : []),
      ...(includeSnippet ? [SNIPPET_SLASH_ITEM] : []),
      ...(includeAttachment ? [ATTACHMENT_SLASH_ITEM] : []),
      ...serverCommands,
    ]
  }, [effectiveCommands, streamId, includeMemoSearch, includeGiphy, includeSnippet, includeAttachment])

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
        if (item.clientActionId === SNIPPET_SLASH_ACTION) onOpenSnippetRef.current?.()
        if (item.clientActionId === ATTACHMENT_SLASH_ACTION) onOpenAttachmentRef.current?.()
        onCommandPickedRef.current?.(item)
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

  // Predicate over the editor's effective command set, for the markdown parser
  // on paste: a pasted `/cmd` only becomes a command node when it's real.
  const isKnownCommand = useCallback(
    (name: string) => {
      const lower = name.toLowerCase()
      return commands.some((cmd) => cmd.name.toLowerCase() === lower)
    },
    [commands]
  )

  return {
    suggestionConfig,
    renderCommandList: renderSuggestionList,
    isActive,
    isKnownCommand,
  }
}
