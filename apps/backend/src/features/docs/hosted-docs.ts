import { markdownLines, StreamTypes, streamTypeCapabilities, type StreamType } from "@threahq/types"
import type { Querier } from "../../db"
import { truncateCodePoints } from "../../lib/truncate"
import { StreamRepository, listAccessibleStreamIds, resolveBriefStreamId, type Stream } from "../streams"
import { DocRepository } from "./repository"

/** How a prompt names a doc with no title. */
export const UNTITLED_DOC_LABEL = "Untitled"
const MAX_HOSTED_DOCS = 20
const MAX_DOC_FIRST_LINE_CHARS = 120

export interface HostedDoc {
  docId: string
  title: string | null
  firstLine: string | null
  /** Open in a pane on the invoking user's latest reported device. */
  open: boolean
}

/**
 * A turn works on its current or nearest ancestor doc, otherwise its root's docs.
 * Null where that root cannot host docs or the stream is sealed (a doc is server-side plaintext).
 */
export async function docHostFor(
  db: Querier,
  workspaceId: string,
  stream: Pick<Stream, "id" | "type" | "rootStreamId" | "e2eEnabled">,
  rootStreamType: StreamType | null
): Promise<string | null> {
  if (!rootStreamType || !streamTypeCapabilities(rootStreamType).hostsDocs || stream.e2eEnabled) return null
  if (stream.type === StreamTypes.DOC) return stream.id
  if (!stream.rootStreamId) return resolveBriefStreamId(stream)
  const nearestDoc = await StreamRepository.findNearestDocAncestor(db, workspaceId, stream.id)
  if (nearestDoc) return nearestDoc
  return resolveBriefStreamId(stream)
}

export async function listHostedDocCandidates(
  db: Querier,
  workspaceId: string,
  hostStreamId: string
): Promise<Stream[]> {
  const host = await StreamRepository.listByIds(db, workspaceId, [hostStreamId], { types: [StreamTypes.DOC] })
  const children = await StreamRepository.list(db, workspaceId, {
    types: [StreamTypes.DOC],
    parentStreamId: hostStreamId,
    archiveStatus: ["active"],
  })
  return [...host, ...children]
}

/** A host's active docs, newest first with the open ones ahead, capped at 20 with each doc's first line of text. */
export async function listHostedDocs(
  db: Querier,
  workspaceId: string,
  hostStreamId: string,
  userId: string,
  openDocIds: readonly string[] = []
): Promise<HostedDoc[]> {
  const open = new Set(openDocIds)
  const candidates = await listHostedDocCandidates(db, workspaceId, hostStreamId)
  const accessible = await listAccessibleStreamIds(
    db,
    workspaceId,
    userId,
    candidates.map((doc) => doc.id)
  )
  const docs = candidates.filter((doc) => accessible.has(doc.id))
  const kept = [
    ...docs.filter((doc) => doc.id === hostStreamId),
    ...docs.filter((doc) => doc.id !== hostStreamId && open.has(doc.id)),
    ...docs.filter((doc) => doc.id !== hostStreamId && !open.has(doc.id)),
  ].slice(0, MAX_HOSTED_DOCS)
  const firstSections = await DocRepository.listFirstSections(
    db,
    workspaceId,
    kept.map((doc) => doc.id)
  )
  return kept.map((doc) => ({
    docId: doc.id,
    title: doc.displayName ?? null,
    firstLine: docFirstLine(firstSections.get(doc.id)),
    open: open.has(doc.id),
  }))
}

export function docFirstLine(markdown: string | undefined): string | null {
  const line = (markdown === undefined ? [] : markdownLines(markdown)).map((l) => l.trim()).find((l) => l.length > 0)
  return line === undefined ? null : truncateCodePoints(line, MAX_DOC_FIRST_LINE_CHARS, "…")
}
