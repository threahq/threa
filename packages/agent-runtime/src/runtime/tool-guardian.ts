import type { ModelMessage } from "ai"

/**
 * The review a host performs before a tier-2 tool call executes: does this
 * conversation show the user wants this action, with these arguments?
 *
 * The runtime owns WHEN this runs (before `execute`, for every tool at tier 2
 * or above) and the host owns HOW it decides. Keeping the interface here rather
 * than importing a backend service is what lets the check sit at the single
 * chokepoint every host shares, instead of being re-added per tool.
 *
 * This is a check on INTENT, not an authorization boundary. Authorization stays
 * where it already is — in which dependencies the host constructs for a stream
 * and in the ids those dependencies are bound to. If a guardian is talked out
 * of a denial by stream content, the blast radius is still only what the tool
 * was already scoped to touch.
 */
export interface ToolGuardianRequest {
  toolName: string
  /** The tool's own description — what the guardian is being asked to permit. */
  toolDescription: string
  /** The arguments the model chose. Judged, not just the intent to act. */
  input: unknown
  /** The turn's conversation so far, newest last. */
  messages: ModelMessage[]
}

export interface ToolGuardianVerdict {
  allowed: boolean
  /**
   * One sentence addressed to the model. On a denial this is what it tells the
   * user it wanted to do and why, so it must be specific enough to act on.
   */
  reason: string
}

export interface ToolGuardian {
  review(request: ToolGuardianRequest): Promise<ToolGuardianVerdict>
}
