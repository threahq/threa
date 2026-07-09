import type { MemoServiceLike, ProcessResult, SaveMemoParams, SaveMemoResult } from "./service"
import { memoId } from "../../lib/id"
import { logger } from "../../lib/logger"

export class StubMemoService implements MemoServiceLike {
  async processBatch(workspaceId: string, streamId: string): Promise<ProcessResult> {
    logger.debug({ workspaceId, streamId }, "Stub memo service - skipping batch processing")
    return { processed: 0, memosCreated: 0 }
  }

  async saveMemo(params: SaveMemoParams): Promise<SaveMemoResult> {
    logger.debug({ workspaceId: params.workspaceId, streamId: params.streamId }, "Stub memo service - save_memo no-op")
    return { ok: true, memoId: memoId(), title: params.title, deduped: false }
  }
}
