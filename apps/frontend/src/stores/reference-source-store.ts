import type { JSONContent } from "@threa/types"

/**
 * The content a mounted message row was rendered from, keyed by message id.
 *
 * The floating selection toolbar sees only DOM ids — it walks up from the
 * browser's selection to `[data-message-id]` — but pinning a quote to a span
 * needs the row's `contentJson` and revision, which the rendering row already
 * holds in memory. Rows publish it here on mount so the toolbar can read it
 * synchronously at click time, instead of re-reading IndexedDB or smuggling a
 * document through a DOM attribute.
 */
export interface ReferenceSource {
  contentJson: JSONContent
  revision: number | null
  contentMarkdown: string
}

const sources = new Map<string, ReferenceSource>()

/**
 * Publish a row's content while it is mounted. Returns the unregister. The same
 * message can be mounted on two surfaces at once (timeline + open thread), so
 * unregistering only drops the entry it installed.
 */
export function registerReferenceSource(messageId: string, source: ReferenceSource): () => void {
  sources.set(messageId, source)
  return () => {
    if (sources.get(messageId) === source) sources.delete(messageId)
  }
}

export function getReferenceSource(messageId: string): ReferenceSource | null {
  return sources.get(messageId) ?? null
}

/** Module-level map survives an account-switch remount; AccountScope clears it. */
export function resetReferenceSourceStoreCache(): void {
  sources.clear()
}
