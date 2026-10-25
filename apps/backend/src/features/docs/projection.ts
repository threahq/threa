import { serializeToMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"

export interface DocSection {
  blockId: string
  position: number
  /** The top-level node type. */
  kind: string
  markdown: string
  contentJson: JSONContent
}

export interface DocProjection {
  bodyMarkdown: string
  bodyJson: JSONContent
  sections: DocSection[]
}

/** Expects a doc already stamped by `ensureBlockIds`; an id-less top-level block is a caller bug. */
export function projectDoc(json: JSONContent): DocProjection {
  const sections = (json.content ?? []).map((block, position): DocSection => {
    const blockId = block.attrs?.blockId
    if (typeof blockId !== "string") {
      throw new Error(`Top-level ${block.type} block at position ${position} has no blockId`)
    }
    return {
      blockId,
      position,
      kind: block.type ?? "",
      markdown: serializeToMarkdown({ type: "doc", content: [block] }),
      contentJson: block,
    }
  })
  return { bodyMarkdown: serializeToMarkdown(json), bodyJson: json, sections }
}

type SectionText = Pick<DocSection, "blockId" | "markdown">

/** Added, changed (by markdown), then removed block ids; a pure move is not a touch. */
export function diffSections(previous: readonly SectionText[], next: readonly SectionText[]): string[] {
  const previousMarkdown = new Map(previous.map((section) => [section.blockId, section.markdown]))
  const nextIds = new Set(next.map((section) => section.blockId))
  const touched = next
    .filter((section) => previousMarkdown.get(section.blockId) !== section.markdown)
    .map((section) => section.blockId)
  const removed = previous.filter((section) => !nextIds.has(section.blockId)).map((section) => section.blockId)
  return [...touched, ...removed]
}
