import type { Pool } from "pg"
import type { TextMetadata } from "@threa/types"
import { withClient, withTransaction } from "../../../db"
import { extractionId } from "../../../lib/id"
import { AttachmentRepository } from "../repository"
import { AttachmentExtractionRepository } from "../extraction-repository"
import { ProcessingStatuses, TextSizeTiers, InjectionStrategies, TextFormats } from "@threa/types"
import { logger } from "../../../lib/logger"
import type { TextProcessingServiceLike } from "./types"

export interface StubTextProcessingServiceDeps {
  pool: Pool
}

export class StubTextProcessingService implements TextProcessingServiceLike {
  private readonly pool: Pool

  constructor(deps: StubTextProcessingServiceDeps) {
    this.pool = deps.pool
  }

  async processText(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId, stub: true })

    const attachment = await withClient(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      if (!att) return null

      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.PROCESSING)
      return att
    })

    if (!attachment) {
      log.warn("Attachment not found")
      return
    }

    const textMetadata: TextMetadata = {
      format: TextFormats.PLAIN,
      sizeTier: TextSizeTiers.SMALL,
      injectionStrategy: InjectionStrategies.FULL,
      totalLines: 10,
      totalBytes: 256,
      encoding: "utf-8",
      sections: [],
      structure: null,
    }

    await withTransaction(this.pool, async (client) => {
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        contentType: "document",
        summary: `[Stub] Text file "${attachment.filename}" with 10 lines.`,
        fullText: `[Stub] Content of ${attachment.filename}`,
        structuredData: null,
        sourceType: "text",
        textMetadata,
      })

      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.COMPLETED)
    })

    log.info({ filename: attachment.filename }, "Stub text processing complete")
  }
}
