import type { BotOutputManifest, BotRuntimeManifest } from "@threa/types"
import { HttpError } from "@threa/backend-common"

/**
 * Reject-undeclared at the verb boundary (INV-11): a runtime that declared a
 * manifest may only emit what it declared; using an output it left off is a
 * loud `400`, never a silent drop. A null manifest is the legacy default
 * profile (predates the manifest, or opted out) and stays unenforced so
 * existing harnesses keep working — enforcement turns on once a runtime
 * declares.
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
