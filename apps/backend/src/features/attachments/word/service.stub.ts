import type { Pool } from "pg"
import type { WordMetadata } from "@threahq/types"
import { withClient, withTransaction } from "../../../db"
import { extractionId } from "../../../lib/id"
import { AttachmentRepository } from "../repository"
import { AttachmentExtractionRepository } from "../extraction-repository"
import { ProcessingStatuses, TextSizeTiers, InjectionStrategies } from "@threahq/types"
import { logger } from "../../../lib/logger"
import type { WordProcessingServiceLike } from "./types"

export interface StubWordProcessingServiceDeps {
  pool: Pool
}

export class StubWordProcessingService implements WordProcessingServiceLike {
  private readonly pool: Pool

  constructor(deps: StubWordProcessingServiceDeps) {
    this.pool = deps.pool
  }

  async processWord(attachmentId: string): Promise<void> {
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

    const isDocx = attachment.filename.toLowerCase().endsWith(".docx")
    const format = isDocx ? "docx" : "doc"

    const wordMetadata: WordMetadata = {
      format,
      sizeTier: TextSizeTiers.SMALL,
      injectionStrategy: InjectionStrategies.FULL,
      pageCount: 3,
      wordCount: 500,
      characterCount: 3000,
      author: "Test Author",
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      embeddedImageCount: isDocx ? 2 : 0,
      sections: [
        {
          type: "heading",
          path: "Introduction",
          title: "Introduction",
          startLine: 1,
          endLine: 10,
        },
        {
          type: "heading",
          path: "Main Content",
          title: "Main Content",
          startLine: 11,
          endLine: 30,
        },
      ],
    }

    await withTransaction(this.pool, async (client) => {
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId,
        workspaceId: attachment.workspaceId,
        contentType: "document",
        summary: `[Stub] Word document "${attachment.filename}" with 500 words.`,
        fullText: `[Stub] Content of ${attachment.filename}\n\nThis is a stub extraction for testing purposes.`,
        structuredData: null,
        sourceType: "word",
        wordMetadata,
      })

      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.COMPLETED)
    })

    log.info({ filename: attachment.filename }, "Stub word processing complete")
  }
}
