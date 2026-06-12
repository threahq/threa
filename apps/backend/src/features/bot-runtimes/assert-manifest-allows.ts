import type { BotOutputManifest, BotRuntimeManifest } from "@threa/types"
import { HttpError } from "@threa/backend-common"

/**
 * Reject-undeclared at the verb boundary (Phase 2.3b, INV-11). A runtime that
 * declared a manifest may only emit what it declared; using an output it left
 * off is a loud `400`, never a silent drop.
 *
 * A null manifest is the legacy default profile (a runtime that predates the
 * manifest, or one that opted out): unenforced, so existing Pi/OpenClaw
 * harnesses keep working. Enforcement turns on only once a runtime declares.
 */
export function assertManifestAllows(manifest: BotRuntimeManifest | null, output: keyof BotOutputManifest): void {
  if (!manifest) return
  if (!manifest.output[output]) {
    throw new HttpError(`Bot runtime did not declare the "${output}" output capability`, {
      status: 400,
      code: "CAPABILITY_NOT_DECLARED",
    })
  }
}
