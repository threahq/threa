import { PluginKey } from "@tiptap/pm/state"
import { createTriggerExtension, type TriggerExtensionOptions } from "./create-trigger-extension"
import type { ChannelItem } from "./types"

export const ChannelPluginKey = new PluginKey("channel")

export interface ChannelNodeAttrs {
  id: string
  slug: string
}

export type ChannelOptions = TriggerExtensionOptions<ChannelItem>

/**
 * TipTap extension for #stream links.
 * Creates an inline node that renders as a styled channel chip.
 */
export const ChannelExtension = createTriggerExtension<ChannelItem, ChannelNodeAttrs>({
  name: "channelLink",
  pluginKey: ChannelPluginKey,
  char: "#",
  // `##` narrows the list to channels, so the second `#` has to reach the query
  // instead of restarting the match (see `useChannelSuggestion`).
  allowToIncludeChar: true,
  attributes: {
    id: { dataAttr: "data-id" },
    slug: { dataAttr: "data-slug" },
  },
  getClassName: () => "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  getText: (attrs) => `#${attrs.slug}`,
  mapPropsToAttrs: (c) => ({
    id: c.id,
    slug: c.slug,
  }),
})
