import type { MemoServiceLike, ProcessResult } from "./service"
import { logger } from "../../lib/logger"

export class StubMemoService implements MemoServiceLike {
  async processBatch(workspaceId: string, streamId: string): Promise<ProcessResult> {
    logger.debug({ workspaceId, streamId }, "Stub memo service - skipping batch processing")
    return { processed: 0, memosCreated: 0 }
  }
}
