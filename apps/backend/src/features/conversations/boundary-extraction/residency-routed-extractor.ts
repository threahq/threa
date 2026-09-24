import { AISpendDeniedError, type DecisionsAvailability } from "@threahq/agent-runtime"
import type { AIResidencyPolicy } from "../../ai-usage"
import { logger } from "../../../lib/logger"
import type { BoundaryExtractor, ExtractionContext, ExtractionResult, SplitContext, SplitProposal } from "./types"

/**
 * Picks the extraction path by the workspace's AI residency pin.
 *
 * Pinned means the workspace keeps the models Threa can run in its own region,
 * so it stays on the inference path. Unpinned — the default, and what every
 * workspace is today — trades that option away for the decision model, which
 * classifies faster, cheaper and with calibrated confidence but exists in one
 * region only.
 *
 * Fallback only ever runs toward the stricter path. A decision-model failure on
 * an unpinned workspace degrades to inference, which costs more and is slower
 * but promises nothing the workspace did not already accept. A pinned workspace
 * never reaches the decision model, failure or not. A spend denial is not a
 * path failure and is rethrown: inference would only spend more.
 */
export class ResidencyRoutedBoundaryExtractor implements BoundaryExtractor {
  private readonly residency: AIResidencyPolicy
  private readonly decisions: Pick<BoundaryExtractor, "extract">
  private readonly inference: BoundaryExtractor
  private readonly availability: DecisionsAvailability

  constructor(deps: {
    residency: AIResidencyPolicy
    decisions: Pick<BoundaryExtractor, "extract">
    inference: BoundaryExtractor
    availability: DecisionsAvailability
  }) {
    this.residency = deps.residency
    this.decisions = deps.decisions
    this.inference = deps.inference
    this.availability = deps.availability
  }

  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    if ((await this.residency.isPinned(context.workspaceId)) || !this.availability.isAvailable) {
      return this.inference.extract(context)
    }

    try {
      return await this.decisions.extract(context)
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      this.availability.recordFailure(error)
      logger.warn(
        { error, workspaceId: context.workspaceId, streamType: context.streamType },
        "Decision-model boundary extraction failed, falling back to the inference path"
      )
      return this.inference.extract(context)
    }
  }

  /**
   * Always inference. A split is a prose task end to end — it regroups a whole
   * conversation and writes a title and summary for every group — so there is
   * no decision-model equivalent to route to.
   */
  splitConversation(context: SplitContext): Promise<SplitProposal> {
    return this.inference.splitConversation(context)
  }
}
