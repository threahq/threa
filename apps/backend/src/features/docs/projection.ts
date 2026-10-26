import { collectDocEmbedIds, serializeToMarkdown } from "@threahq/prosemirror"
import type { DocSection, JSONContent } from "@threahq/types"

/** A block of a doc embedding another doc, projected on every write. */
export interface DocReference {
  blockId: string
  refType: "doc"
  refId: string
}

export interface DocProjection {
  bodyMarkdown: string
  bodyJson: JSONContent
  sections: DocSection[]
  references: DocReference[]
}

/** Expects a doc already stamped by `ensureBlockIds`; an id-less top-level block is a caller bug. */
export function projectDoc(json: JSONContent, docId: string): DocProjection {
  const sections = (json.content ?? []).map((block, position): DocSection => {
    const blockId = block.attrs?.blockId
    if (typeof blockId !== "string") {
      throw new Error(`Top-level ${block.type} block at position ${position} has no blockId`)
    }
    if (!block.type) throw new Error(`Top-level block ${blockId} at position ${position} has no type`)
    return {
      blockId,
      position,
      kind: block.type,
      markdown: serializeToMarkdown({ type: "doc", content: [block] }),
      contentJson: block,
    }
  })
  const references = sections.flatMap((section) =>
    collectDocEmbedIds(section.contentJson)
      .filter((refId) => refId !== docId)
      .map((refId): DocReference => ({ blockId: section.blockId, refType: "doc", refId }))
  )
  return { bodyMarkdown: serializeToMarkdown(json), bodyJson: json, sections, references }
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
