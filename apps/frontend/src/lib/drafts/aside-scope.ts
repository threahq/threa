import { ulid } from "ulid"

/**
 * Draft scopes inside an aside: `aside:{asideId}:{draftId}`. An aside holds
 * several living drafts at once, and a draft scope holds exactly one draft, so
 * the draft id is part of the scope rather than a column beside it.
 *
 * The backend treats a scope as opaque, so these live entirely on the client.
 * They are deliberately outside every host pile — an aside is private, and its
 * drafts must never surface in a stream's "save for later" picker. That falls
 * out of `resolveDraftHomeStream` returning null for them (home-stream.ts).
 */
const ASIDE_SCOPE_PREFIX = "aside:"

export interface AsideDraftScope {
  asideId: string
  draftId: string
}

export function asideDraftScope(asideId: string, draftId: string): string {
  return `${ASIDE_SCOPE_PREFIX}${asideId}:${draftId}`
}

/** A fresh scope for a new draft in this aside. */
export function newAsideDraftScope(asideId: string): string {
  return asideDraftScope(asideId, `draft_${ulid()}`)
}

export function parseAsideDraftScope(scope: string): AsideDraftScope | null {
  if (!scope.startsWith(ASIDE_SCOPE_PREFIX)) return null
  const [asideId, draftId, ...rest] = scope.slice(ASIDE_SCOPE_PREFIX.length).split(":")
  if (!asideId || !draftId || rest.length > 0) return null
  return { asideId, draftId }
}

export function isAsideDraftScope(scope: string): boolean {
  return parseAsideDraftScope(scope) !== null
}

/** The scopes of `asideId`'s own drafts, out of a workspace-wide list. */
export function asideDraftScopesOf(asideId: string, scopes: readonly string[]): string[] {
  return scopes.filter((scope) => parseAsideDraftScope(scope)?.asideId === asideId)
}
