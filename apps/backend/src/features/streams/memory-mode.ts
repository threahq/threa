import type { Querier } from "../../db"
import { MemoryModes } from "@threahq/types"
import { StreamRepository, type Stream } from "./repository"

/**
 * The stream whose `memoryMode` governs memory automation for `streamId`: a
 * thread follows its root (INV-62), every other type governs itself. `null`
 * when that stream is gone, which {@link isMemoryAutomationOn} reads as off.
 */
export async function findMemoryModeStream(
  db: Querier,
  workspaceId: string,
  streamId: string
): Promise<Stream | null> {
  const stream = await StreamRepository.findByIdForWorkspace(db, streamId, workspaceId)
  if (!stream?.rootStreamId) return stream
  return StreamRepository.findByIdForWorkspace(db, stream.rootStreamId, workspaceId)
}

/**
 * Whether automatic capture runs for a {@link findMemoryModeStream} result —
 * the one question passive memo extraction, passive to-do capture and
 * reflective session capture all ask, so `off` means the same on each. The
 * explicit `save_memo` tool is deliberately not gated here.
 */
export function isMemoryAutomationOn(memoryModeStream: Stream | null): memoryModeStream is Stream {
  return memoryModeStream !== null && memoryModeStream.memoryMode !== MemoryModes.OFF
}
