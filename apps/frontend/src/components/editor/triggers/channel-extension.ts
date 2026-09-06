import { PluginKey } from "@tiptap/pm/state"
import { triggerStyles } from "@/lib/markdown/chip-styles"
import { createTriggerExtension, type TriggerExtensionOptions } from "./create-trigger-extension"
import { ChannelLinkView } from "./channel-link-view"
import type { ChannelItem } from "./types"

export const ChannelPluginKey = new PluginKey("channel")

export interface ChannelNodeAttrs {
  id: string
  slug: string
}

export type ChannelOptions = TriggerExtensionOptions<ChannelItem>

/**
 * TipTap extension for #stream links.
 *
 * The node view draws the chip, so a scratchpad reads under its live name and
 * its own glyph rather than the folded slug baked into `attrs`.
 * `getClassName`/`getText` stay the plain-HTML fallback the copy, paste and
 * export paths render through — same neutral channel palette, so the two never
 * disagree about the chip's colour.
 */
export const ChannelExtension = createTriggerExtension<ChannelItem, ChannelNodeAttrs>({
  name: "channelLink",
  pluginKey: ChannelPluginKey,
  char: "#",
  // `##` narrows the list to channels, so the second `#` has to reach the query
  // instead of restarting the match (see `useChannelSuggestion`).
  allowToIncludeChar: true,
  // Stream names are phrases ("CCH - Threa mention scratchpads"), and no single
  // word of one narrows the list to it.
  spacedQuery: true,
  attributes: {
    id: { dataAttr: "data-id" },
    slug: { dataAttr: "data-slug" },
  },
  getClassName: () => triggerStyles.channel,
  getText: (attrs) => `#${attrs.slug}`,
  mapPropsToAttrs: (c) => ({
    id: c.id,
    slug: c.slug,
  }),
  nodeView: ChannelLinkView,
})
