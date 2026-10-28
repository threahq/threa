import { LabelableResourceTypes, StreamTypes, type DocEditor, type DocListItem, type StreamType } from "@threahq/types"
import { collectSealedStreamIds, streamLabel } from "@/lib/streams"

/** The `/docs` page's filters, each one search param (INV-59). */
export const DOC_LIST_PARAMS = { query: "q", host: "host", label: "label", editor: "editor" } as const

export interface DocListFilters {
  query: string
  host: string | null
  label: string | null
  editor: string | null
}

export interface DocListStream {
  id: string
  type: StreamType
  slug?: string | null
  displayName?: string | null
  parentStreamId?: string | null
  createdAt: string
  archivedAt?: string | null
}

interface DocListAssignment {
  labelId: string
  resourceType: string
  resourceId: string
}

export interface DocRow {
  doc: DocListStream
  title: string
  /** Null when the viewer cannot read the host (a doc readable only through a share grant). */
  host: DocListStream | null
  /** The last edit, else when the doc was created. */
  activityAt: string
  edited: boolean
  /** Newest first. */
  editors: DocEditor[]
  labelIds: string[]
}

export function readDocListFilters(params: URLSearchParams): DocListFilters {
  return {
    query: params.get(DOC_LIST_PARAMS.query) ?? "",
    host: params.get(DOC_LIST_PARAMS.host) || null,
    label: params.get(DOC_LIST_PARAMS.label) || null,
    editor: params.get(DOC_LIST_PARAMS.editor) || null,
  }
}

export function writeDocListFilters(params: URLSearchParams, patch: Partial<DocListFilters>): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of Object.keys(patch) as (keyof DocListFilters)[]) {
    const value = patch[key]
    if (value) next.set(DOC_LIST_PARAMS[key], value)
    else next.delete(DOC_LIST_PARAMS[key])
  }
  return next
}

/** The `/docs` page's URL with `patch` applied to the filters in `params`; other params are kept. */
export function docListHref(workspaceId: string, params: URLSearchParams, patch: Partial<DocListFilters> = {}) {
  const search = writeDocListFilters(params, patch).toString()
  return search ? `/w/${workspaceId}/docs?${search}` : `/w/${workspaceId}/docs`
}

/**
 * The viewer's live docs, last activity first. `items` (the backend's list, fetched at `listedAt`) decides
 * which docs list; a cached doc missing from it lists only when created after the fetch. The cached streams
 * give fresher titles, hosts and archival: a doc archived, or under an archived ancestor, drops out. A doc
 * the cache lacks lists under its listed title, and a doc whose host the viewer cannot read has no host.
 */
export function buildDocRows({
  streams,
  items,
  assignments,
  listedAt,
}: {
  streams: readonly DocListStream[]
  items: readonly DocListItem[]
  assignments: readonly DocListAssignment[]
  listedAt: number
}): DocRow[] {
  const streamById = new Map(streams.map((stream) => [stream.id, stream]))
  const itemById = new Map(items.map((item) => [item.id, item]))
  const sealed = collectSealedStreamIds(streams)
  const labelIdsByStream = new Map<string, string[]>()
  for (const assignment of assignments) {
    if (assignment.resourceType !== LabelableResourceTypes.STREAM) continue
    const ids = labelIdsByStream.get(assignment.resourceId) ?? []
    if (!ids.includes(assignment.labelId)) ids.push(assignment.labelId)
    labelIdsByStream.set(assignment.resourceId, ids)
  }

  const docs: DocListStream[] = items.map(
    (item) =>
      streamById.get(item.id) ?? {
        id: item.id,
        type: StreamTypes.DOC,
        displayName: item.displayName,
        createdAt: item.createdAt,
      }
  )
  for (const stream of streams) {
    if (stream.type === StreamTypes.DOC && !itemById.has(stream.id) && Date.parse(stream.createdAt) > listedAt) {
      docs.push(stream)
    }
  }

  return docs
    .filter((doc) => !sealed.has(doc.id))
    .map((doc) => {
      const item = itemById.get(doc.id)
      const lastEditedAt = item?.lastEditedAt ?? null
      return {
        doc,
        title: streamLabel(doc, "generic"),
        host: doc.parentStreamId ? (streamById.get(doc.parentStreamId) ?? null) : null,
        activityAt: lastEditedAt ?? doc.createdAt,
        edited: lastEditedAt !== null,
        editors: item?.editors ?? [],
        labelIds: labelIdsByStream.get(doc.id) ?? [],
      }
    })
    .sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt))
}

export function filterDocRows(rows: readonly DocRow[], filters: DocListFilters) {
  const query = filters.query.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (query === "" || row.title.toLowerCase().includes(query)) &&
      (filters.host === null || row.doc.parentStreamId === filters.host) &&
      (filters.label === null || row.labelIds.includes(filters.label)) &&
      (filters.editor === null || row.editors.some((editor) => editor.actorId === filters.editor))
  )
}

/** What each filter can pick from: hosts by name, labels in use, and editors by their latest edit. */
export function docFilterOptions(rows: readonly DocRow[]) {
  const hosts = new Map<string, DocListStream>()
  const labelIds = new Set<string>()
  const latestByEditor = new Map<string, DocEditor>()
  for (const row of rows) {
    if (row.host) hosts.set(row.host.id, row.host)
    for (const id of row.labelIds) labelIds.add(id)
    for (const editor of row.editors) {
      const seen = latestByEditor.get(editor.actorId)
      if (!seen || Date.parse(editor.lastEditedAt) > Date.parse(seen.lastEditedAt)) {
        latestByEditor.set(editor.actorId, editor)
      }
    }
  }
  return {
    hosts: [...hosts.values()]
      .map((host) => ({ host, name: streamLabel(host) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    labelIds,
    editors: [...latestByEditor.values()].sort((a, b) => Date.parse(b.lastEditedAt) - Date.parse(a.lastEditedAt)),
  }
}
