import { OfficeParser } from "officeparser"
import WordExtractor from "word-extractor"
import JSZip from "jszip"
import type { WordFormat } from "./detector"

export interface ExtractedImage {
  data: Buffer
  mimeType: string
  index: number
}

export interface ExtractionResult {
  text: string
  /** Embedded images (DOCX only - DOC doesn't support image extraction) */
  images: ExtractedImage[]
  properties: DocumentProperties
}

export interface DocumentProperties {
  author: string | null
  createdAt: Date | null
  modifiedAt: Date | null
  /** Often unavailable; the extractors don't reliably surface page count */
  pageCount: number | null
}

export async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const ast = await OfficeParser.parseOffice(buffer, {
    extractAttachments: false,
    includeRawContent: false,
  })

  const text = ast.toText()

  const images = await extractDocxImages(buffer)

  const properties: DocumentProperties = {
    author: ast.metadata?.author ?? null,
    createdAt: ast.metadata?.created ?? null,
    modifiedAt: ast.metadata?.modified ?? null,
    pageCount: ast.metadata?.pages ?? null,
  }

  return { text, images, properties }
}

/**
 * Extract embedded images from DOCX file.
 *
 * DOCX files are ZIP archives with images stored in word/media/
 */
async function extractDocxImages(buffer: Buffer): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = []

  try {
    const zip = await JSZip.loadAsync(buffer)

    const mediaFolder = zip.folder("word/media")
    if (!mediaFolder) {
      return images
    }

    let index = 0
    const imageEntries: Array<{ name: string; file: JSZip.JSZipObject | null }> = []

    mediaFolder.forEach((relativePath, file) => {
      if (!file.dir) {
        imageEntries.push({ name: relativePath, file })
      }
    })

    for (const entry of imageEntries) {
      const file = entry.file
      if (!file) continue

      const data = await file.async("nodebuffer")
      const mimeType = getMimeTypeFromFilename(entry.name)

      if (mimeType) {
        images.push({ data, mimeType, index })
        index++
      }
    }
  } catch {
    // If image extraction fails, continue without images
  }

  return images
}

function getMimeTypeFromFilename(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop()
  switch (ext) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "bmp":
      return "image/bmp"
    case "tiff":
    case "tif":
      return "image/tiff"
    case "emf":
      return "image/x-emf"
    case "wmf":
      return "image/x-wmf"
    default:
      return null
  }
}

export async function extractDoc(buffer: Buffer): Promise<ExtractionResult> {
  const extractor = new WordExtractor()
  const doc = await extractor.extract(buffer)

  const text = doc.getBody()

  // word-extractor doesn't support image extraction for DOC files
  const images: ExtractedImage[] = []

  const properties: DocumentProperties = {
    author: null,
    createdAt: null,
    modifiedAt: null,
    pageCount: null,
  }

  return { text, images, properties }
}

export async function extractWord(buffer: Buffer, format: WordFormat): Promise<ExtractionResult> {
  switch (format) {
    case "docx":
      return extractDocx(buffer)
    case "doc":
      return extractDoc(buffer)
    default:
      throw new Error(`Unsupported Word format: ${format}`)
  }
}
