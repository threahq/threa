import { ulid } from "ulid"
import { asideDraftScope } from "@threa/types"

/**
 * Minting side of the aside draft scope. The grammar itself lives in
 * `@threa/types` — the aside's agent reads these drafts server-side, so both
 * ends parse the same format. Only the id minting is client business.
 *
 * Aside drafts sit deliberately outside every host pile — an aside is private,
 * and its drafts must never surface in a stream's "save for later" picker.
 * That falls out of `resolveDraftHomeStream` returning null for them
 * (home-stream.ts).
 */
export function newAsideDraftScope(asideId: string): string {
  return asideDraftScope(asideId, `draft_${ulid()}`)
}

export { asideDraftScope, isAsideDraftScope, parseAsideDraftScope, type AsideDraftScope } from "@threa/types"
