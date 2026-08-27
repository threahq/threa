/**
 * Brief Correction Eval Config
 *
 * Model/temperature come from the production companion config (INV-44) so the
 * eval drives Ariadne exactly as production does. Thresholds live here as the
 * single source for the suite's gates.
 */

import { EVAL_JUDGE_MODEL } from "../../framework/judge-config"
import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "../../../src/features/agents"

export { COMPANION_MODEL_ID, COMPANION_TEMPERATURE }

/** Judge model for the semantic brief-content checks — same as the companion/memorizer judges. */
export const BRIEF_JUDGE_MODEL = EVAL_JUDGE_MODEL

/**
 * The suite's hard floor (roadmap 4.4): the fraction of chitchat conversations
 * that must leave the brief untouched. Over-eager brief writes are the failure
 * mode that erodes trust, so the chitchat arm is gated tighter than accuracy.
 */
export const CHITCHAT_NO_WRITE_GATE = 0.9

/** Run-level accuracy floor across every case (matches the other suites). */
export const BRIEF_ACCURACY_GATE = 0.8
