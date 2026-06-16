/**
 * TipTap extension for #channels in search mode.
 * Shows channel suggestions when user types #.
 *
 * Unlike the regular ChannelExtension, this inserts plain text, not a styled node.
 * This is used in the search editor where channel references are search terms, not rich formatting.
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { ChannelItem } from "./types"

export const SearchChannelPluginKey = new PluginKey("searchChannel")

export interface SearchChannelOptions {
  suggestion: {
    items: (props: { query: string }) => ChannelItem[] | Promise<ChannelItem[]>
    render: () => {
      onStart: (props: SuggestionProps<ChannelItem>) => void
      onUpdate: (props: SuggestionProps<ChannelItem>) => void
      onExit: (props: SuggestionProps<ChannelItem>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

export const SearchChannelExtension = Extension.create<SearchChannelOptions>({
  name: "searchChannel",

  addOptions() {
    return {
      suggestion: {
        items: () => [],
        render: () => ({
          onStart: () => {},
          onUpdate: () => {},
          onExit: () => {},
          onKeyDown: () => false,
        }),
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: SearchChannelPluginKey,
        char: "#",
        allowSpaces: false,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as ChannelItem
          editor.chain().focus().deleteRange(range).insertContent(`#${item.slug} `).run()
        },
      }),
    ]
  },
})
