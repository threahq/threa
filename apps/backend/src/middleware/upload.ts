import multer from "multer"
import multerS3 from "multer-s3"
import { S3Client } from "@aws-sdk/client-s3"
import type { Request, RequestHandler } from "express"
import type { S3Config } from "../lib/env"
import { attachmentId } from "../lib/id"

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB

declare global {
  namespace Express {
    namespace Multer {
      interface File {
        bucket?: string
        key?: string
        location?: string
        etag?: string
      }
    }
  }
}

declare module "express" {
  interface Request {
    attachmentId?: string
  }
}

export interface UploadMiddlewareConfig {
  s3Config: S3Config
}

type MulterS3Client = NonNullable<Parameters<typeof multerS3>[0]>["s3"]

/**
 * Creates an upload middleware that streams files directly to S3.
 * No temp files are written to disk - prevents DoS via disk exhaustion.
 */
export function createUploadMiddleware({ s3Config }: UploadMiddlewareConfig): RequestHandler {
  const s3Client = new S3Client({
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
    ...(s3Config.endpoint && {
      endpoint: s3Config.endpoint,
      forcePathStyle: true,
    }),
  })

  const storage = multerS3({
    // Bun currently installs two compatible @aws-sdk/client-s3 versions through multer-s3 typings.
    // Runtime behavior is correct; this narrows the mismatch to the integration boundary.
    s3: s3Client as unknown as MulterS3Client,
    bucket: s3Config.bucket,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req: Request, file: Express.Multer.File, cb) => {
      const { workspaceId } = req.params
      // Reserved-content route: bytes MUST land at the storage_path fixed at
      // reserve time — a caller-influenced key (fresh id or filename) would let
      // the bytes and the row's storage_path diverge. The route's validation
      // middleware authorized this id; fail loudly if it didn't run.
      if (req.params.attachmentId) {
        const reserved = req.reservedAttachment
        if (!reserved) {
          return cb(new Error("Reserved upload reached S3 middleware without validation"))
        }
        req.attachmentId = reserved.id
        return cb(null, reserved.storagePath)
      }
      const id = attachmentId()
      req.attachmentId = id
      // Workspace-scoped path (no streamId - set when attached to message)
      const key = `${workspaceId}/${id}/${file.originalname}`
      cb(null, key)
    },
  })

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1,
    },
  })

  return upload.single("file")
}

const AVATAR_MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])

/**
 * Memory storage is correct here: the size cap keeps memory bounded,
 * and we need the buffer for sharp processing before uploading to S3.
 */
export function createAvatarUploadMiddleware(): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: AVATAR_MAX_FILE_SIZE,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        cb(null, true)
      } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: JPEG, PNG, GIF, WebP`))
      }
    },
  })

  return upload.single("avatar")
}

export { MAX_FILE_SIZE }
