import type { Querier } from "../../db"
import { MemoryModes, StreamTypes } from "@threahq/types"
import { StreamRepository, type Stream } from "./repository"

/**
 * The stream whose `memoryMode` governs memory automation for `streamId`: a
 * thread follows its root (INV-62), every other type governs itself. `null`
 * when that stream is gone — {@link isMemoryAutomationOn} reads a missing
 * authority as off, so an orphan never captures against a stream nobody can
 * open.
 */
export async function findMemoryModeStream(
  db: Querier,
  workspaceId: string,
  streamId: string
): Promise<Stream | null> {
  const stream = await StreamRepository.findByIdForWorkspace(db, streamId, workspaceId)
  if (!stream || stream.type !== StreamTypes.THREAD) return stream
  const rootStreamId = stream.rootStreamId ?? stream.id
  if (rootStreamId === stream.id) return stream
  return StreamRepository.findByIdForWorkspace(db, rootStreamId, workspaceId)
}

/**
 * Whether automatic memory capture runs for a {@link findMemoryModeStream}
 * result. Every automatic path answers this one question — passive memo
 * extraction, passive to-do capture, reflective session capture — so `off`
 * means the same thing on all of them. The explicit `save_memo` tool is NOT
 * gated here: it acts on in-conversation direction, not on automation.
 */
export function isMemoryAutomationOn(memoryModeStream: Stream | null): memoryModeStream is Stream {
  return memoryModeStream !== null && memoryModeStream.memoryMode !== MemoryModes.OFF
}
