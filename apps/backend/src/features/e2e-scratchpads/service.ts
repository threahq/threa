import type { Pool } from "pg"
import { E2eScratchpadsRepository, type E2eScratchpad } from "./repository"

/**
 * Read-only consumer surface for outbox handlers that need to gate their
 * behavior on whether a stream is end-to-end encrypted (Phase 1 audit list).
 *
 * The write path lives in the streams feature: creating an E2E scratchpad
 * inserts into `e2e_scratchpads` in the same transaction as the stream row
 * via {@link E2eScratchpadsRepository.markStreamE2e}, so no transactional
 * coordination is needed here — outbox handlers only ever read.
 */
export class E2eScratchpadsService {
  constructor(private pool: Pool) {}

  async isE2eStream(workspaceId: string, streamId: string): Promise<boolean> {
    return E2eScratchpadsRepository.isE2eStream(this.pool, workspaceId, streamId)
  }

  async getByStreamId(workspaceId: string, streamId: string): Promise<E2eScratchpad | null> {
    return E2eScratchpadsRepository.getByStreamId(this.pool, workspaceId, streamId)
  }
}
