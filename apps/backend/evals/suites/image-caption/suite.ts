/**
 * Image Caption Evaluation Suite
 *
 * Measures what `image-caption` reduces an image to. Captions are the only
 * representation of an image that search, memo extraction and agent prompts
 * ever read, so a regression here is invisible in production until someone
 * notices an agent answering from nothing — this suite is what makes a model
 * or prompt change on that path a measured decision.
 *
 * ## Usage
 *
 *   # Run the whole suite on the production model
 *   bun run eval -- -s image-caption
 *
 *   # One case
 *   bun run eval -- -s image-caption -c caption-swedish-invoice
 *
 *   # Compare models (five images per arm, one call each)
 *   bun run eval -- -s image-caption -m openrouter:openai/gpt-5.6-luna,openrouter:google/gemini-2.5-flash
 *
 * ## Evaluators
 *
 * - content-type: chart/table/diagram/screenshot/photo/document classification
 * - text-coverage: how much of the looked-up text (ids, errors, amounts) survives
 * - summary-detail: does the summary name specifics, or only describe the genre
 * - structured-data: populated for charts/tables/diagrams, null elsewhere
 * - no-invention: no translation, no text that is not on the page
 */

import { readFileSync } from "fs"
import { join } from "path"
import type { EvalSuite, EvalContext } from "../../framework/types"
import {
  analyzeImage,
  flattenExtractedText,
  IMAGE_CAPTION_MODEL_ID,
  IMAGE_CAPTION_TEMPERATURE,
} from "../../../src/features/attachments"
import { imageCaptionCases } from "./cases"
import type { ImageCaptionInput, ImageCaptionOutput, ImageCaptionExpected } from "./types"
import {
  contentTypeEvaluator,
  textCoverageEvaluator,
  summaryDetailEvaluator,
  structuredDataEvaluator,
  noInventionEvaluator,
  transcriptionCoverageEvaluator,
} from "./evaluators"

const FIXTURE_DIR = join(import.meta.dir, "fixtures")

/** Calls the production captioner entry point (INV-45). */
async function runImageCaptionTask(input: ImageCaptionInput, ctx: EvalContext): Promise<ImageCaptionOutput> {
  const imageBuffer = readFileSync(join(FIXTURE_DIR, input.fixture))

  try {
    const analysis = await analyzeImage({ ai: ctx.ai, configResolver: ctx.configResolver }, imageBuffer, "image/png", {
      workspaceId: ctx.workspaceId,
      filename: input.fixture,
    })
    return { input, analysis, flatText: flattenExtractedText(analysis) }
  } catch (error) {
    return {
      input,
      analysis: null,
      flatText: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const imageCaptionSuite: EvalSuite<ImageCaptionInput, ImageCaptionOutput, ImageCaptionExpected> = {
  name: "image-caption",
  description: "Tests how much of an image survives into its caption and transcription",

  cases: imageCaptionCases,

  task: runImageCaptionTask,

  evaluators: [
    contentTypeEvaluator,
    textCoverageEvaluator,
    summaryDetailEvaluator,
    structuredDataEvaluator,
    noInventionEvaluator,
  ],

  runEvaluators: [transcriptionCoverageEvaluator],

  defaultPermutations: [
    {
      model: IMAGE_CAPTION_MODEL_ID,
      temperature: IMAGE_CAPTION_TEMPERATURE,
    },
  ],
}

export default imageCaptionSuite
