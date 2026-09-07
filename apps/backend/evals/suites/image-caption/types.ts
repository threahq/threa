/**
 * Image Caption Evaluation Types
 */

import type { ExtractionContentType } from "@threahq/types"
import type { ImageAnalysisOutput } from "../../../src/features/attachments"

export interface ImageCaptionInput {
  /** PNG file name under ./fixtures */
  fixture: string
  /** What the fixture depicts, for report output only. */
  description: string
}

export interface ImageCaptionOutput {
  input: ImageCaptionInput
  analysis: ImageAnalysisOutput | null
  /** `extractedText` flattened exactly the way production stores `full_text`. */
  flatText: string | null
  error?: string
}

export interface ImageCaptionExpected {
  contentType: ExtractionContentType
  /**
   * Strings a downstream reader would look up later: identifiers, error text,
   * amounts, labels. Compared against the flattened transcription.
   */
  requiredText: string[]
  /** Facts the summary must name on its own, without the transcription. */
  summaryMentions: string[]
  /** Whether the case is one `structuredData` exists for. */
  structuredData: "required" | "absent"
  /** Strings that only appear if the model translated or invented. */
  forbiddenText?: string[]
}
