import { StreamTypes, streamTypeCapabilities, type StreamType } from "@threahq/types"
import type { Querier } from "../../db"
import { truncateCodePoints } from "../../lib/truncate"
import { StreamRepository, resolveBriefStreamId, type Stream } from "../streams"
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
 * The stream whose docs a turn on `stream` reads and edits: a thread's turn works on its root's docs.
 * Null where that root cannot host docs or the stream is sealed (a doc is server-side plaintext).
 */
export function docHostFor(
  stream: Pick<Stream, "id" | "rootStreamId" | "e2eEnabled">,
  rootStreamType: StreamType | null
): string | null {
  if (!rootStreamType || !streamTypeCapabilities(rootStreamType).hostsDocs || stream.e2eEnabled) return null
  return resolveBriefStreamId(stream)
}

/** A host's active docs, newest first with the open ones ahead, capped at 20 with each doc's first line of text. */
export async function listHostedDocs(
  db: Querier,
  workspaceId: string,
  hostStreamId: string,
  openDocIds: readonly string[] = []
): Promise<HostedDoc[]> {
  const open = new Set(openDocIds)
  const docs = await StreamRepository.list(db, workspaceId, {
    types: [StreamTypes.DOC],
    parentStreamId: hostStreamId,
    archiveStatus: ["active"],
  })
  const kept = [...docs.filter((doc) => open.has(doc.id)), ...docs.filter((doc) => !open.has(doc.id))].slice(
    0,
    MAX_HOSTED_DOCS
  )
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
  const line = markdown
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line === undefined ? null : truncateCodePoints(line, MAX_DOC_FIRST_LINE_CHARS, "…")
}
