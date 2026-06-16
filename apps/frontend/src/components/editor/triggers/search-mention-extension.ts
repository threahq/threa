/**
 * TipTap extension for @mentions in search mode.
 * Shows user/persona suggestions when user types @.
 *
 * Unlike the regular MentionExtension, this inserts plain text, not a styled node.
 * This is used in the search editor where mentions are search terms, not rich formatting.
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Mentionable } from "./types"

export const SearchMentionPluginKey = new PluginKey("searchMention")

export interface SearchMentionOptions {
  suggestion: {
    items: (props: { query: string }) => Mentionable[] | Promise<Mentionable[]>
    render: () => {
      onStart: (props: SuggestionProps<Mentionable>) => void
      onUpdate: (props: SuggestionProps<Mentionable>) => void
      onExit: (props: SuggestionProps<Mentionable>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

export const SearchMentionExtension = Extension.create<SearchMentionOptions>({
  name: "searchMention",

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
        pluginKey: SearchMentionPluginKey,
        char: "@",
        allowSpaces: false,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as Mentionable
          editor.chain().focus().deleteRange(range).insertContent(`@${item.slug} `).run()
        },
      }),
    ]
  },
})
