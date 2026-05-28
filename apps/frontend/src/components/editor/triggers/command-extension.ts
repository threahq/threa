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
 */
export const CommandExtension = createTriggerExtension<CommandItem, CommandNodeAttrs>({
  name: "slashCommand",
  pluginKey: CommandPluginKey,
  char: "/",
  startOfLine: true,
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
    if (item.clientActionId !== MEMO_SEARCH_SLASH_ACTION) return false
    editor.chain().focus().deleteRange(range).insertContent("/memo ").run()
    return true
  },
})
