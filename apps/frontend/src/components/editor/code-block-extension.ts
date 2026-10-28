import CodeBlock from "@tiptap/extension-code-block"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { codeBlockOptions } from "@threahq/prosemirror/schema"
import { codeBlockHighlightPlugin } from "./code-block-highlight"
import { CodeBlockView } from "./code-block-view"

export const CodeBlockExtension = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView)
  },

  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), codeBlockHighlightPlugin(this.name)]
  },
}).configure(codeBlockOptions)
