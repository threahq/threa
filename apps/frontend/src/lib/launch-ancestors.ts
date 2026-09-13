import { pageStreamId } from "@/lib/navigation-journal"
import { hiddenStreamIds } from "@/lib/streams"

/** The fields of a cached stream row the ancestor walk reads. */
export interface AncestorStream {
  id: string
  type: string
  parentStreamId: string | null
  rootStreamId: string | null
}

export interface LaunchHop {
  to: string
  state?: { launchRebuild: true; panelPopsToClose?: true }
}

/**
 * The history a fresh JS context should hold beneath the page it launched on,
 * bottom to top, ending with the launch URL itself. Reached from the sidebar
 * or a card, the same page sits on: its stream's visible ancestors (parent
 * chain; the root when a link in the chain is not cached), the page without
 * its `?panel=`, then the launch URL. A single hop means nothing to rebuild.
 */
export function launchAncestors(
  location: { pathname: string; search: string },
  workspaceId: string,
  streams: readonly AncestorStream[]
): LaunchHop[] {
  const top = `${location.pathname}${location.search}`
  const hops: LaunchHop[] = [{ to: top, state: { launchRebuild: true } }]

  const params = new URLSearchParams(location.search)
  if (params.has("panel")) {
    params.delete("panel")
    const query = params.toString()
    hops.unshift({ to: query ? `${location.pathname}?${query}` : location.pathname, state: { launchRebuild: true } })
    hops[hops.length - 1].state = { launchRebuild: true, panelPopsToClose: true }
  }

  const streamId = pageStreamId(location.pathname, workspaceId)
  if (streamId) {
    for (const id of visibleAncestors(streamId, streams)) {
      hops.unshift({ to: `/w/${workspaceId}/s/${id}`, state: { launchRebuild: true } })
    }
  }

  hops[0] = { to: hops[0].to }
  return hops
}

/** Nearest ancestor first. Hidden (aside-rooted) streams are never pages, so they are skipped. */
function visibleAncestors(streamId: string, streams: readonly AncestorStream[]): string[] {
  const byId = new Map(streams.map((stream) => [stream.id, stream]))
  const hidden = hiddenStreamIds(streams)
  const out: string[] = []
  const seen = new Set([streamId])
  let cursor = byId.get(streamId)?.parentStreamId ?? null
  let uncached = false
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const parent = byId.get(cursor)
    if (!parent) {
      uncached = true
      break
    }
    if (!hidden.has(parent.id)) out.push(parent.id)
    cursor = parent.parentStreamId
  }
  // The walk stopped at an uncached link (a lazily hydrated thread): the root
  // is in the bootstrap, so it still goes underneath.
  const rootId = byId.get(streamId)?.rootStreamId
  if (uncached && rootId && !seen.has(rootId) && byId.has(rootId) && !hidden.has(rootId)) out.push(rootId)
  return out
}
