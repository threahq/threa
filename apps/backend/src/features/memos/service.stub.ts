import type {
  MemoServiceLike,
  ProcessResult,
  SaveMemoParams,
  SaveMemoResult,
  CaptureSessionReflectionParams,
  CaptureSessionReflectionResult,
} from "./service"
import { memoId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { StreamWritePrincipal } from "../streams"

export class StubMemoService implements MemoServiceLike {
  async processBatch(workspaceId: string, streamId: string): Promise<ProcessResult> {
    logger.debug({ workspaceId, streamId }, "Stub memo service - skipping batch processing")
    return { processed: 0, memosCreated: 0 }
  }

  async saveMemo(params: SaveMemoParams): Promise<SaveMemoResult> {
    logger.debug({ workspaceId: params.workspaceId, streamId: params.streamId }, "Stub memo service - save_memo no-op")
    if (params.sourceMessageIds.length === 0) return { ok: false, reason: "no_source_messages" }
    return { ok: true, memoId: memoId(), title: params.title, deduped: false }
  }

  async saveMemoGenerated(_principal: StreamWritePrincipal, params: SaveMemoParams): Promise<SaveMemoResult> {
    return this.saveMemo(params)
  }

  async captureSessionReflection(params: CaptureSessionReflectionParams): Promise<CaptureSessionReflectionResult> {
    logger.debug(
      { workspaceId: params.workspaceId, sessionId: params.sessionId },
      "Stub memo service - reflective capture no-op"
    )
    return { classified: false, captured: 0, deduped: 0 }
  }
}
