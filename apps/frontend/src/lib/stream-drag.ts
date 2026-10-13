import { buildStreamLink } from "@/lib/stream-links"

/**
 * A dragged stream, as Threa's drop targets (sidebar sections, panes) and
 * everything outside Threa read it: its id under its own MIME type, its
 * permalink under the link flavours.
 */

/**
 * Marks a drag as carrying a stream. Only `dataTransfer.types` is
 * readable during `dragover`, so the id needs its own MIME type for a target to
 * decide whether it accepts the drop before it lands.
 */
export const STREAM_DRAG_TYPE = "application/x-threa-stream+json"

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char])

/**
 * The payload a stream drag carries. A native drag crosses windows, so the
 * workspace rides along: dropping a row from one workspace's window onto
 * another's sidebar must not file an id that workspace has never heard of.
 */
export function readStreamDrag(data: DataTransfer, workspaceId: string): string | null {
  try {
    const payload = JSON.parse(data.getData(STREAM_DRAG_TYPE)) as { workspaceId?: string; streamId?: string }
    return payload.workspaceId === workspaceId && payload.streamId ? payload.streamId : null
  } catch {
    return null
  }
}

/**
 * A drag that lands on nothing — the timeline, the header, empty sidebar space —
 * would otherwise hit the document's default handler, which navigates the whole
 * page to the dragged URL. Swallow only the drops nobody claimed: a zone that
 * handled the drag has already called `preventDefault`.
 */
function swallowUnclaimedDrop(event: globalThis.DragEvent) {
  if (event.defaultPrevented) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
}

/**
 * A drop ends the drag, so it also disarms — the row's `dragend` is not the only
 * way out. A row that unmounts mid-drag (a rename re-sorts its section, a socket
 * event re-renders the list) never fires `dragend`, and a guard left armed
 * swallows every unclaimed drop in the app for the rest of the session.
 */
function endMissedDropGuard(event: globalThis.DragEvent) {
  swallowUnclaimedDrop(event)
  setMissedDropGuard(false)
}

export function setMissedDropGuard(armed: boolean) {
  if (armed) {
    window.addEventListener("dragover", swallowUnclaimedDrop)
    window.addEventListener("drop", endMissedDropGuard)
    return
  }
  window.removeEventListener("dragover", swallowUnclaimedDrop)
  window.removeEventListener("drop", endMissedDropGuard)
}

/** Fills a drag with a stream: its id for Threa's own drop targets, its permalink for everything else. */
export function writeStreamDrag(data: DataTransfer, workspaceId: string, streamId: string, label: string) {
  const link = buildStreamLink(workspaceId, streamId)
  data.setData(STREAM_DRAG_TYPE, JSON.stringify({ workspaceId, streamId }))
  data.setData("text/uri-list", link)
  data.setData("text/plain", link)
  // Rich-text targets (mail, docs, other chat apps) prefer this flavour.
  data.setData("text/html", `<a href="${escapeHtml(link)}">${escapeHtml(label)}</a>`)
}

/**
 * The URL a drop carries, if any. `text/uri-list` (RFC 2483) is what a dragged
 * anchor or a browser tab puts on the clipboard: CRLF-separated URLs with `#`
 * comment lines. Chrome mirrors it into `text/plain`, Safari sometimes doesn't.
 */
export function readDroppedUrl(data: DataTransfer | null | undefined): string | null {
  if (!data) return null
  const uriList = data.getData("text/uri-list")
  const first = uriList.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))
  const candidate = first?.trim() || data.getData("text/plain").trim()
  // A dragged text selection lands on `text/plain` too. The URL parser strips
  // newlines and percent-encodes spaces, so a whole sentence containing a link
  // would parse as one and the rest of the text would be swallowed into the
  // chip — a URL has no raw whitespace, so anything that does is not one.
  if (!candidate || /\s/.test(candidate)) return null
  return candidate
}
