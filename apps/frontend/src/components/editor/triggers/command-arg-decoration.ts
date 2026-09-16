import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { commandFlagChipStyle, commandValueStyle } from "@/lib/markdown/chip-styles"
import { commandNodeTextSize } from "./command-extension"
import { pillBaseClassName } from "./create-trigger-extension"
import { leadingValueSpan, scanCommandArgs } from "@/lib/markdown/command-args"
import type { CommandArgNames } from "@/lib/markdown/command-list-context"

export interface CommandArgDecorationOptions {
  /** The arguments a command in the composer declares, or null when it declares none. */
  commandArgsFor: (name: string) => CommandArgNames | null
}

export const CommandArgDecorationPluginKey = new PluginKey("commandArgDecoration")

/**
 * Draws the arguments of the leading `/command` as the same chips a posted
 * message renders (`mention-renderer`), so the composer shows what it will send.
 *
 * View-only inline decorations, never nodes or marks: the argument picker reads
 * the argument region as plain text out of the doc (`resolveArgSession`), so
 * anything that changed the document here would break picking the next value.
 */
export const CommandArgDecoration = Extension.create<CommandArgDecorationOptions>({
  name: "commandArgDecoration",

  addOptions() {
    return { commandArgsFor: () => null }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: CommandArgDecorationPluginKey,
        props: {
          decorations(state) {
            const block = state.doc.firstChild
            const chip = block?.firstChild
            if (!block || !chip || block.type.name !== "paragraph" || chip.type.name !== "slashCommand") return null
            const args = options.commandArgsFor(String(chip.attrs.name ?? ""))
            if (!args) return null
            const anchorPos = 1 + chip.nodeSize
            // Every inline leaf (a mention, a channel, an emoji, an attachment
            // reference) is one position wide, so it must contribute exactly one
            // character or every span after it decorates the wrong range.
            const raw = state.doc.textBetween(anchorPos, 1 + block.content.size, "\n", (leaf) =>
              leaf.type.name === "hardBreak" ? "\n" : "￼"
            )
            const breakAt = raw.indexOf("\n")
            const text = breakAt === -1 ? raw : raw.slice(0, breakAt)

            const decorations: Decoration[] = []
            // ProseMirror splits a range at every decoration boundary, so a
            // value cannot nest inside its flag's span: the pair sits adjacent
            // and drops padding and rounding at the seam to read as one chip.
            // The node's own box (`pillBaseClassName` + its type size), not the
            // message renderer's `chipBase`: a shorter value box against the
            // command node shows a step at the seam instead of one chip.
            const box = `${pillBaseClassName} ${commandNodeTextSize}`
            const valueClass = `${box} bg-muted font-mono ${commandValueStyle}`
            // The leading positional value joins the command's own chip, space
            // included, the way `mention-renderer` draws `/spawn pi` as one block.
            const lead = leadingValueSpan(text, args)
            if (lead) {
              decorations.push(Decoration.node(1, anchorPos, { class: "pr-0 rounded-r-none" }))
              decorations.push(Decoration.inline(anchorPos, anchorPos + lead.to, { class: `${valueClass} pl-0 rounded-l-none` }))
            }
            for (const span of scanCommandArgs(text, args)) {
              const valueStart = anchorPos + span.to - (span.value?.length ?? 0)
              decorations.push(
                Decoration.inline(anchorPos + span.from, valueStart, {
                  class: `${box} ${commandFlagChipStyle}${span.value ? " pr-0 rounded-r-none" : ""}`,
                })
              )
              if (span.value) {
                decorations.push(
                  Decoration.inline(valueStart, anchorPos + span.to, {
                    class: `${valueClass} pl-0 rounded-l-none`,
                  })
                )
              }
            }
            return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null
          },
        },
      }),
    ]
  },
})
