import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import type { KnowledgeType, MemoType } from "@threa/types"
import { useMemoDetail } from "./use-memos"

/**
 * Resolved memo for an embed card. Carries only the title + meta the card
 * renders — not the abstract or key points (the embed is a title-and-meta
 * pointer; the full memo lives behind the link to the memory explorer).
 */
export interface MemoEmbedResolved {
  status: "resolved"
  title: string
  knowledgeType: KnowledgeType
  memoType: MemoType
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface MemoEmbedMissing {
  status: "missing"
}

export interface MemoEmbedPending {
  /** Still resolving. UI stays blank until the staggered-skeleton delay. */
  status: "pending"
  /** Becomes true once the staggered-skeleton delay has elapsed. */
  showSkeleton: boolean
}

export type MemoEmbedSource = MemoEmbedResolved | MemoEmbedMissing | MemoEmbedPending

const SKELETON_DELAY_MS = 300

/**
 * Resolve a memo-embed pointer's card content from the memo detail API, with
 * the same staggered-skeleton semantics as `useSharedMessageSource`: stay blank
 * until 300ms, then show a skeleton, so the common fast path doesn't flicker.
 *
 * The viewer's read access is enforced server-side — the detail endpoint 404s
 * for memos the viewer can't see, which surfaces here as `missing`.
 */
export function useMemoEmbedSource(memoId: string): MemoEmbedSource {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { data, isError } = useMemoDetail(workspaceId ?? "", memoId)

  const resolved = useMemo<MemoEmbedSource | null>(() => {
    const memo = data?.memo?.memo
    if (memo) {
      return {
        status: "resolved",
        title: memo.title,
        knowledgeType: memo.knowledgeType,
        memoType: memo.memoType,
        tags: memo.tags,
        createdAt: memo.createdAt,
        updatedAt: memo.updatedAt,
      }
    }
    if (isError) return { status: "missing" }
    return null
  }, [data, isError])

  const [showSkeleton, setShowSkeleton] = useState(false)

  useEffect(() => {
    setShowSkeleton(false)
  }, [memoId])

  useEffect(() => {
    if (resolved) {
      setShowSkeleton(false)
      return
    }
    const timer = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [resolved])

  if (resolved) return resolved
  return { status: "pending", showSkeleton }
}
