import { PluginKey } from "@tiptap/pm/state"
import { SlashCommandNode } from "@threahq/prosemirror/schema"
import { commandChipStyle } from "@/lib/markdown/chip-styles"
import { createTriggerExtension, type TriggerExtensionOptions } from "./create-trigger-extension"
import type { CommandItem } from "./types"

export const CommandPluginKey = new PluginKey("slashCommand")

/** The command node's own type size; the argument decorations share it so their boxes line up with the node's. */
export const commandNodeTextSize = "text-sm"

/**
 * Client-action id for the synthetic "memos" slash entry. Selecting it doesn't
 * insert a command chip — it types `/memos ` so the separate memo-search trigger
 * takes over. Frontend-only: this id is consumed at pick time and never reaches
 * the backend (no chip is created).
 */
export const MEMO_SEARCH_SLASH_ACTION = "memo-search"

/** Client-action id for the synthetic "docs" slash entry: like the memos entry, it types `/docs ` to hand off to the doc-search trigger. */
export const DOC_SEARCH_SLASH_ACTION = "doc-search"

/** Client-action id for the synthetic "doc" slash entry: it types `/doc ` to hand off to the doc-create trigger. */
export const DOC_CREATE_SLASH_ACTION = "doc-create"

/** The inline trigger each hand-off entry types in place of its `/name`, the space included so the trigger opens. */
const HANDOFF_TRIGGERS: Record<string, string> = {
  [MEMO_SEARCH_SLASH_ACTION]: "/memos ",
  [DOC_SEARCH_SLASH_ACTION]: "/docs ",
  [DOC_CREATE_SLASH_ACTION]: "/doc ",
}

/**
 * Client-action id for the synthetic "giphy" slash entry. Like the memo entry it
 * inserts no command chip — selecting it removes the typed `/giphy` and the
 * React layer (see `useCommandSuggestion`) opens the GIF picker. The chosen GIF
 * is attached to the message as an upload, so nothing reaches the backend
 * command pipeline. Frontend-only.
 */
export const GIPHY_SLASH_ACTION = "giphy"

/**
 * Client-action id for the synthetic "snippet" slash entry. Inserts no chip —
 * selecting it removes the typed `/snippet` and the React layer (see
 * `useCommandSuggestion`) opens the snippet editor. The saved snippet becomes a
 * file attachment, so nothing reaches the backend command pipeline. Frontend-only.
 */
export const SNIPPET_SLASH_ACTION = "snippet"

/**
 * Client-action id for the synthetic "attachment" slash entry. Inserts no chip —
 * selecting it removes the typed `/attachment` and the React layer (see
 * `useCommandSuggestion`) opens the attachment picker, which inserts a reference
 * to a tray file (or a freshly uploaded one) at the caret. Frontend-only.
 */
export const ATTACHMENT_SLASH_ACTION = "attachment"

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
 * (`placement: "message"`, the default — e.g. `/invite`, `/aside`)
 * only show when the `/` opens the message, while inline commands
 * (`placement: "inline"` — e.g. the memos embed) show anywhere.
 */
export const CommandExtension = createTriggerExtension<CommandItem, CommandNodeAttrs>({
  node: SlashCommandNode,
  pluginKey: CommandPluginKey,
  char: "/",
  startOfLine: false,
  getClassName: () => `${commandChipStyle} ${commandNodeTextSize}`,
  mapPropsToAttrs: (c) => ({
    name: c.name,
    clientActionId: c.clientActionId ?? null,
  }),
  onSelectItem: ({ editor, range, item }) => {
    // The memos, docs and doc entries are discovery shortcuts into their inline
    // triggers: replace the typed `/name` with the trigger so its picker opens.
    const handoff = item.clientActionId ? HANDOFF_TRIGGERS[item.clientActionId] : undefined
    if (handoff) {
      editor.chain().focus().deleteRange(range).insertContent(handoff).run()
      return true
    }
    // The "giphy", "snippet" and "attachment" entries insert no chip — drop the
    // typed slash here; the React command wrapper opens the picker/editor once
    // handled.
    if (
      item.clientActionId === GIPHY_SLASH_ACTION ||
      item.clientActionId === SNIPPET_SLASH_ACTION ||
      item.clientActionId === ATTACHMENT_SLASH_ACTION
    ) {
      editor.chain().focus().deleteRange(range).run()
      return true
    }
    return false
  },
})
