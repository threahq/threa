import type { Pool } from "pg"
import { E2eStreamsRepository, type E2eStream } from "./repository"

/**
 * Read-only consumer surface for outbox handlers that need to gate their
 * behavior on whether a stream is end-to-end encrypted (Phase 1 audit list).
 *
 * The write path lives in the streams feature: creating an E2E stream
 * inserts into `e2e_streams` in the same transaction as the stream row
 * via {@link E2eStreamsRepository.markStreamE2e}, so no transactional
 * coordination is needed here — outbox handlers only ever read.
 */
export class E2eStreamsService {
  constructor(private pool: Pool) {}

  async isE2eStream(workspaceId: string, streamId: string): Promise<boolean> {
    return E2eStreamsRepository.isE2eStream(this.pool, workspaceId, streamId)
  }

  async getByStreamId(workspaceId: string, streamId: string): Promise<E2eStream | null> {
    return E2eStreamsRepository.getByStreamId(this.pool, workspaceId, streamId)
  }
}
