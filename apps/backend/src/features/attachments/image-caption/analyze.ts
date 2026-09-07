import type { AI } from "@threahq/agent-runtime"
import type { ConfigResolver, ImageCaptionConfig } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import { detectImageMediaType, imageAnalysisSchema, type ImageAnalysisOutput } from "./config"

export interface AnalyzeImageDeps {
  ai: AI
  configResolver: ConfigResolver
}

export interface AnalyzeImageContext {
  workspaceId: string
  attachmentId?: string
  filename?: string
}

/**
 * The model call on its own: bytes in, structured analysis out, no database
 * and no object store. `ImageCaptionService.processImage` wraps it with the
 * attachment plumbing; the `image-caption` eval suite calls it directly, so
 * both run the same prompt, schema and resolved config (INV-45).
 */
export async function analyzeImage(
  deps: AnalyzeImageDeps,
  imageBuffer: Buffer,
  mimeType: string,
  context: AnalyzeImageContext
): Promise<ImageAnalysisOutput> {
  const config = await deps.configResolver.resolve<ImageCaptionConfig>(COMPONENT_PATHS.ATTACHMENT_IMAGE_CAPTION)

  // Octet-stream uploads reach here on their extension alone, so the media type
  // sent to the provider comes off the bytes: a mislabelled one is rejected.
  const mediaType = mimeType.startsWith("image/") ? mimeType : detectImageMediaType(imageBuffer)
  if (!mediaType) {
    throw new Error(`Unrecognised image bytes for mime type ${mimeType}`)
  }

  const { value } = await deps.ai.generateObject({
    model: config.modelId,
    schema: imageAnalysisSchema,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    messages: [
      { role: "system", content: config.systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: config.userPrompt },
          { type: "image", image: imageBuffer.toString("base64"), mimeType: mediaType },
        ],
      },
    ],
    telemetry: {
      functionId: "image-caption",
      metadata: {
        ...(context.attachmentId ? { attachment_id: context.attachmentId } : {}),
        workspace_id: context.workspaceId,
        ...(context.filename ? { filename: context.filename } : {}),
        mime_type: mimeType,
      },
    },
    context: { workspaceId: context.workspaceId },
  })

  return value
}

/**
 * Flatten an analysis into the single `full_text` column. Headings and labels
 * lead so a keyword match on a chart legend still hits, then the transcription.
 */
export function flattenExtractedText(analysis: ImageAnalysisOutput): string | null {
  const parts: string[] = []
  if (analysis.extractedText?.headings?.length) {
    parts.push(...analysis.extractedText.headings)
  }
  if (analysis.extractedText?.labels?.length) {
    parts.push(...analysis.extractedText.labels)
  }
  if (analysis.extractedText?.body) {
    parts.push(analysis.extractedText.body)
  }
  return parts.length > 0 ? parts.join("\n") : null
}
