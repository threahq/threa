import { PluginKey } from "@tiptap/pm/state"
import { createTriggerExtension, type TriggerExtensionOptions } from "./create-trigger-extension"
import type { CommandItem } from "./types"

export const CommandPluginKey = new PluginKey("slashCommand")

/**
 * Client-action id for the synthetic "memo" slash entry. Selecting it doesn't
 * insert a command chip — it types `/memo ` so the separate memo-search trigger
 * takes over. Frontend-only: this id is consumed at pick time and never reaches
 * the backend (no chip is created).
 */
export const MEMO_SEARCH_SLASH_ACTION = "memo-search"

/**
 * Client-action id for the synthetic "giphy" slash entry. Like the memo entry it
 * inserts no command chip — selecting it removes the typed `/giphy` and the
 * React layer (see `useCommandSuggestion`) opens the GIF picker. The chosen GIF
 * is attached to the message as an upload, so nothing reaches the backend
 * command pipeline. Frontend-only.
 */
export const GIPHY_SLASH_ACTION = "giphy"

export interface CommandNodeAttrs {
  name: string
  /**
   * Opaque discriminator for client-action commands — routed locally by the
   * composer instead of dispatched to the backend `commandsApi`. `null` for
   * regular server-side commands. Stored on the node so the composer-side
   * send handler can branch on `clientActionId` rather than hardcoding
   * per-command `name === "…"` checks. Stays in sync with `CommandInfo`
   * from the workspace bootstrap metadata.
   */
  clientActionId: string | null
}

export type CommandOptions = TriggerExtensionOptions<CommandItem>

/**
 * TipTap extension for /slash commands.
 * Creates an inline node that renders as a styled command chip.
 *
 * The palette triggers mid-sentence (`startOfLine: false`), not just at the
 * start of a block. Which commands surface is decided per-item by the
 * suggestion list's filter (see `useCommandSuggestion`): whole-message commands
 * (`placement: "message"`, the default — e.g. `/invite`, `/discuss-with-ariadne`)
 * only show when the `/` opens the message, while inline commands
 * (`placement: "inline"` — e.g. the memo embed) show anywhere.
 */
export const CommandExtension = createTriggerExtension<CommandItem, CommandNodeAttrs>({
  name: "slashCommand",
  pluginKey: CommandPluginKey,
  char: "/",
  startOfLine: false,
  attributes: {
    name: { dataAttr: "data-name" },
    clientActionId: { dataAttr: "data-client-action-id", default: null },
  },
  getClassName: () => "font-mono font-bold bg-muted text-primary text-sm",
  getText: (attrs) => `/${attrs.name}`,
  mapPropsToAttrs: (c) => ({
    name: c.name,
    clientActionId: c.clientActionId ?? null,
  }),
  onSelectItem: ({ editor, range, item }) => {
    // The "memo" entry is a discovery shortcut into the memo-search trigger:
    // replace the typed `/memo` with `/memo ` so MemoSearchExtension activates.
    if (item.clientActionId === MEMO_SEARCH_SLASH_ACTION) {
      editor.chain().focus().deleteRange(range).insertContent("/memo ").run()
      return true
    }
    // The "giphy" entry inserts no chip — drop the typed `/giphy` here; the
    // React command wrapper opens the picker once the pick is handled.
    if (item.clientActionId === GIPHY_SLASH_ACTION) {
      editor.chain().focus().deleteRange(range).run()
      return true
    }
    return false
  },
})
