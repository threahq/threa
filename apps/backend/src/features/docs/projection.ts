import { collectDocEmbedIds, collectExternalLinkOrigins, serializeToMarkdown } from "@threahq/prosemirror"
import type { DocSection, JSONContent } from "@threahq/types"

/**
 * What a doc block points at, projected on every write: `doc` = an embedded doc's id,
 * `link_origin` = the origin (`https://host[:port]`) of an external link, keying favicon access and hydration.
 */
export const DocReferenceTypes = { DOC: "doc", LINK_ORIGIN: "link_origin" } as const
type DocReferenceType = (typeof DocReferenceTypes)[keyof typeof DocReferenceTypes]

export interface DocReference {
  blockId: string
  refType: DocReferenceType
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
  const references = sections.flatMap((section): DocReference[] => [
    ...collectDocEmbedIds(section.contentJson)
      .filter((refId) => refId !== docId)
      .map((refId): DocReference => ({ blockId: section.blockId, refType: DocReferenceTypes.DOC, refId })),
    ...collectExternalLinkOrigins(section.contentJson).map(
      (refId): DocReference => ({ blockId: section.blockId, refType: DocReferenceTypes.LINK_ORIGIN, refId })
    ),
  ])
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
