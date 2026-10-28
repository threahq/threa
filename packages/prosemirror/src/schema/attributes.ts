import type { ContentRange } from "@threahq/types"

export type Attrs = Record<string, unknown>

export interface DataAttributeSpec {
  default: unknown
  parseHTML: (element: HTMLElement) => unknown
  renderHTML: (attrs: Attrs) => Record<string, unknown>
}

export function dataAttr(attr: string, dataName: string, defaultValue: unknown): DataAttributeSpec {
  return {
    default: defaultValue,
    parseHTML: (element) => element.getAttribute(dataName),
    renderHTML: (attrs) => ({ [dataName]: attrs[attr] }),
  }
}

export function optionalDataAttr(attr: string, dataName: string): DataAttributeSpec {
  return {
    default: null,
    parseHTML: (element) => element.getAttribute(dataName),
    renderHTML: (attrs) => (attrs[attr] ? { [dataName]: attrs[attr] } : {}),
  }
}

function parseRangeAttribute(raw: string | null): ContentRange | null {
  const match = raw?.match(/^(\d+)-(\d+)$/)
  if (!match) return null
  const from = Number(match[1])
  const to = Number(match[2])
  return to > from ? { from, to } : null
}

/**
 * The reference pin both pointer nodes carry: which revision of the source the
 * node points at (`version`), and which span of that revision (`range`). Shared
 * between `quoteReply` and `sharedMessage` so a copy-paste round-trip through
 * HTML reads the pin the same way for both.
 */
export const referencePinAttributes = {
  version: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const parsed = Number(element.getAttribute("data-version"))
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    },
    renderHTML: (attrs: Attrs) => (attrs.version == null ? {} : { "data-version": String(attrs.version) }),
  },
  range: {
    default: null,
    parseHTML: (element: HTMLElement) => parseRangeAttribute(element.getAttribute("data-range")),
    renderHTML: (attrs: Attrs) => {
      const range = attrs.range as ContentRange | null
      return range ? { "data-range": `${range.from}-${range.to}` } : {}
    },
  },
}

export const BLOCK_ID_NODE_TYPES: readonly string[] = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "table",
  "horizontalRule",
  "agentBlock",
  "quoteReply",
  "sharedMessage",
]
