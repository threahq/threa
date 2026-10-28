/**
 * Doc Edit Eval Config
 *
 * Model/temperature come from the production companion config (INV-44) so the
 * eval drives Ariadne exactly as production does. Thresholds live here as the
 * single source for the suite's gates.
 */

import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "../../../src/features/agents"

export { COMPANION_MODEL_ID, COMPANION_TEMPERATURE }

/** Run-level accuracy floor across every case (matches the other suites). */
export const DOC_EDIT_ACCURACY_GATE = 0.8
