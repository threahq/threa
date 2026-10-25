import { mergeAttributes } from "@tiptap/core"
import type { DOMOutputSpec } from "@tiptap/pm/model"

/** Adds editor-only classes to a shared schema node's `[tag, attrs, ...children]` output. */
export function withClassName(spec: DOMOutputSpec, className: string): DOMOutputSpec {
  const [tag, attrs, ...children] = spec as [string, Record<string, unknown>, ...DOMOutputSpec[]]
  return [tag, mergeAttributes(attrs, { class: className }), ...children]
}
