import { Readable } from "node:stream"
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { S3Config } from "../env"

export interface SignedDownloadUrlOptions {
  expiresIn?: number
  responseContentDisposition?: string
}

export interface ObjectContent {
  stream: Readable
  contentLength?: number
  /** Set when the request carried a Range header — the S3 Content-Range of the partial response. */
  contentRange?: string
}

export interface StorageProvider {
  getObjectSize(key: string): Promise<number>
  /**
   * Size + ETag of the stored object in one HeadObject (quotes stripped from
   * the ETag). The authoritative source for "what actually landed" — multer's
   * reported size is 0 for large bodies (lib-storage multipart never emits
   * `total` for streams) and its ETag shape varies by upload mode.
   */
  getObjectStat(key: string): Promise<{ sizeBytes: number; etag: string }>
  getSignedDownloadUrl(key: string, options?: SignedDownloadUrlOptions): Promise<string>
  getObject(key: string): Promise<Buffer>
  /** Fetch first N bytes of an object using HTTP Range header */
  getObjectRange(key: string, start: number, end: number): Promise<Buffer>
  getObjectStream(key: string): Promise<Readable>
  /** Stream an object with the metadata needed to proxy it over HTTP (optionally a Range slice). */
  getObjectContent(key: string, options?: { range?: string }): Promise<ObjectContent>
  putObject(key: string, body: Buffer, contentType: string): Promise<void>
  /**
   * Server-side copy of an existing object to a new key (no bytes transit the
   * app). Used by persona knowledge-by-reference: attaching an existing file to
   * a persona copies its bytes to a fresh key so the persona owns an independent
   * copy (copy-on-attach). `srcKey` is URL-encoded into `CopySource` so keys with
   * spaces/unicode filenames round-trip.
   */
  copyObject(srcKey: string, destKey: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Creates an S3 storage provider for download URLs and deletions.
 * Uploads are handled by multer-s3 middleware (streaming, no temp files).
 */
export function createS3Storage(config: S3Config): StorageProvider {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint && {
      endpoint: config.endpoint,
      forcePathStyle: true,
    }),
  })

  return {
    async getObjectSize(key: string): Promise<number> {
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })
      )

      const contentLength = response.ContentLength

      if (typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error(`S3 HeadObject missing valid ContentLength for key: ${key}`)
      }

      return contentLength
    },

    async getObjectStat(key: string): Promise<{ sizeBytes: number; etag: string }> {
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })
      )
      const contentLength = response.ContentLength
      if (typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error(`S3 HeadObject missing valid ContentLength for key: ${key}`)
      }
      const etag = response.ETag
      if (!etag) {
        throw new Error(`S3 HeadObject missing ETag for key: ${key}`)
      }
      return { sizeBytes: contentLength, etag: etag.replaceAll('"', "") }
    },

    async getSignedDownloadUrl(key: string, options?: SignedDownloadUrlOptions): Promise<string> {
      const { expiresIn = 900, responseContentDisposition } = options ?? {}
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(responseContentDisposition && { ResponseContentDisposition: responseContentDisposition }),
      })
      return getSignedUrl(client, command, { expiresIn })
    },

    async getObject(key: string): Promise<Buffer> {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      })
      const response = await client.send(command)

      if (!response.Body) {
        throw new Error(`No body in S3 response for key: ${key}`)
      }

      const chunks: Uint8Array[] = []
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },

    async getObjectRange(key: string, start: number, end: number): Promise<Buffer> {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
      })
      const response = await client.send(command)

      if (!response.Body) {
        throw new Error(`No body in S3 response for key: ${key}`)
      }

      const chunks: Uint8Array[] = []
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },

    async getObjectStream(key: string): Promise<Readable> {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      })
      const response = await client.send(command)

      if (!response.Body) {
        throw new Error(`No body in S3 response for key: ${key}`)
      }

      return response.Body as Readable
    },

    async getObjectContent(key: string, options?: { range?: string }): Promise<ObjectContent> {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(options?.range && { Range: options.range }),
      })
      const response = await client.send(command)

      if (!response.Body) {
        throw new Error(`No body in S3 response for key: ${key}`)
      }

      return {
        stream: response.Body as Readable,
        contentLength: response.ContentLength,
        contentRange: response.ContentRange,
      }
    },

    async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      )
    },

    async copyObject(srcKey: string, destKey: string): Promise<void> {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: destKey,
          CopySource: `${config.bucket}/${encodeURIComponent(srcKey)}`,
        })
      )
    },

    async delete(key: string): Promise<void> {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })
      )
    },
  }
}
