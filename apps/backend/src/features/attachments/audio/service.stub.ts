import type { Pool } from "pg"
import { ProcessingStatuses } from "@threahq/types"
import { withTransaction } from "../../../db"
import { settleAudioWithoutResult, type AudioProcessingServiceLike } from "./service"

/** Without ffmpeg the raw upload is the playable form: marks audio SKIPPED so clients stop waiting. */
export class StubAudioProcessingService implements AudioProcessingServiceLike {
  constructor(private readonly pool: Pool) {}

  async process(workspaceId: string, attachmentId: string): Promise<void> {
    await withTransaction(this.pool, (client) =>
      settleAudioWithoutResult(client, workspaceId, attachmentId, ProcessingStatuses.SKIPPED)
    )
  }
}
