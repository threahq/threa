import { StreamTypes } from "@threa/types"
import type { CachedStream } from "@/stores/workspace-store"
import type { BoardPostTarget } from "@/hooks/use-conversations"

// Sentinel target values for the two "create a new scratchpad" options, kept
// distinct from any stream id (which is what the rest of the picker holds).
export const NEW_SCRATCHPAD = "new:scratchpad"
export const NEW_QUICK_NOTE = "new:quick-note"

// Existing streams a board post can target: live channels and DMs. Scratchpads
// are created via a post (the two "New …" options), not appended to from the
// board (user ruling). Threads/system aren't user-authored surfaces; archived
// and E2E streams are excluded (the composer can't client-seal yet).
const POSTABLE_TYPES = new Set<string>([StreamTypes.CHANNEL, StreamTypes.DM])

export function isPostableStream(stream: Pick<CachedStream, "type" | "archivedAt" | "e2eEnabled">): boolean {
  return POSTABLE_TYPES.has(stream.type) && !stream.archivedAt && stream.e2eEnabled !== true
}

/** Map a picker value (sentinel or stream id) to the API target. `""` → null. */
export function targetForValue(value: string): BoardPostTarget | null {
  if (!value) return null
  if (value === NEW_SCRATCHPAD) return { type: "newScratchpad", companionMode: "on" }
  if (value === NEW_QUICK_NOTE) return { type: "newScratchpad", companionMode: "off" }
  return { type: "stream", streamId: value }
}
