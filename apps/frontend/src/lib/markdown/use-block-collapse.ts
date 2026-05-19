import { useCallback, useMemo } from "react"
import {
  composeBlockCollapseKey,
  hashMarkdownBlock,
  useIsInsideCollapsibleBlock,
  useMarkdownBlockContext,
  type MarkdownBlockKind,
} from "./markdown-block-context"
import { setBlockCollapse, useBlockCollapseStore } from "./collapse-cache"

export interface BlockCollapseState {
  collapsed: boolean
  /** True when a MarkdownBlockProvider is mounted so toggles can be persisted. */
  canToggle: boolean
  toggle: () => void
}

interface UseBlockCollapseOptions {
  kind: MarkdownBlockKind
  /**
   * Distinguishes otherwise-identical content within a single kind
   * (code uses `language`, quote-replies use `${streamId}/${messageId}`).
   * Defaults to `kind` when a block type has no secondary axis.
   */
  hashNamespace?: string
  content: string
  /**
   * Whether the block is long enough to be worth collapsing at all. Short
   * blocks (≤ threshold) render plain with no fold chrome — there is nothing
   * worth hiding. When true the block also starts collapsed unless the user
   * has a persisted override expanding it.
   */
  collapsible: boolean
}

/**
 * Shared collapse-state hook for collapsible markdown blocks. Persists
 * toggles per `(messageId, kind, contentHash)` in IDB so choices survive
 * reloads without leaking between messages. Reads are synchronous via the
 * shared `collapse-cache` so the first paint already reflects the persisted
 * state — preventing the timeline from resizing rows after mount.
 */
export function useBlockCollapse({
  kind,
  hashNamespace = kind,
  content,
  collapsible,
}: UseBlockCollapseOptions): BlockCollapseState {
  const messageContext = useMarkdownBlockContext()
  const nested = useIsInsideCollapsibleBlock()

  const collapseKey = useMemo(() => {
    // No key — and therefore no fold chrome — when there is nothing to persist
    // to (standalone preview), when nested inside another foldable block, or
    // when the block is too short to be worth collapsing.
    if (!messageContext || nested || !collapsible) return null
    return composeBlockCollapseKey(messageContext.messageId, kind, hashMarkdownBlock(content, hashNamespace))
  }, [messageContext, nested, collapsible, kind, hashNamespace, content])

  const persistedOverride = useBlockCollapseStore(collapseKey)

  // Render plain (expanded, no toggle) whenever there is nothing to fold
  // against: nested inside another foldable block, too short to collapse, or
  // no persistence key (standalone preview) — collapsing with no way to
  // toggle would strand the content clamped. Otherwise start collapsed unless
  // the user persisted an expand.
  const collapsed = !collapseKey ? false : (persistedOverride ?? true)

  const toggle = useCallback(() => {
    if (!collapseKey || !messageContext) return
    setBlockCollapse(collapseKey, messageContext.messageId, kind, !collapsed)
  }, [collapseKey, messageContext, collapsed, kind])

  return {
    collapsed,
    canToggle: Boolean(collapseKey),
    toggle,
  }
}
