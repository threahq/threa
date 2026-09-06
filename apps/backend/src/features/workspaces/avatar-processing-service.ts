import { Pool } from "pg"
import { withTransaction } from "../../db"
import { UserRepository } from "./user-repository"
import { AvatarUploadRepository } from "./avatar-upload-repository"
import { OutboxRepository } from "../../lib/outbox"
import { serializeBigInt } from "@threahq/backend-common"
import { logger } from "../../lib/logger"
import type { AvatarService } from "./avatar-service"

export class AvatarProcessingService {
  private pool: Pool
  private avatarService: AvatarService

  constructor(pool: Pool, avatarService: AvatarService) {
    this.pool = pool
    this.avatarService = avatarService
  }

  async processUpload(avatarUploadId: string): Promise<void> {
    const upload = await AvatarUploadRepository.findById(this.pool, avatarUploadId)
    if (!upload) {
      logger.info({ avatarUploadId }, "Upload row gone (removed or superseded), skipping")
      return
    }

    const { workspaceId, userId, rawS3Key, replacesAvatarUrl } = upload

    logger.info({ avatarUploadId, userId }, "Processing avatar")

    // S3 download + image processing run with no DB connection held (INV-41).
    const buffer = await this.avatarService.downloadRaw(rawS3Key)

    const basePath = this.avatarService.rawKeyToBasePath(rawS3Key)
    const images = await this.avatarService.processImages(buffer)
    await this.avatarService.uploadImages(basePath, images)

    // Update the user only if this is still the latest upload (INV-20).
    let variantsUsed = false
    await withTransaction(this.pool, async (client) => {
      const updated = await UserRepository.updateAvatarIfLatestUpload(
        client,
        workspaceId,
        userId,
        avatarUploadId,
        basePath
      )

      if (updated) {
        variantsUsed = true
        const fullUser = await UserRepository.findById(client, workspaceId, userId)
        if (fullUser) {
          await OutboxRepository.insert(client, "workspace_user:updated", {
            workspaceId,
            user: serializeBigInt(fullUser),
          })
        }
      } else {
        logger.info({ avatarUploadId, userId }, "Upload gone or superseded, skipping user update")
      }

      await AvatarUploadRepository.deleteById(client, avatarUploadId)
    })

    // Cleanup is fire-and-forget: raw file always; variants + old avatar only if we used them.
    this.avatarService.deleteRawFile(rawS3Key)
    if (variantsUsed && replacesAvatarUrl) {
      this.avatarService.deleteAvatarFiles(replacesAvatarUrl)
    }
    if (!variantsUsed) {
      this.avatarService.deleteAvatarFiles(basePath)
    }

    logger.info({ avatarUploadId, userId }, "Avatar processing completed")
  }
}
