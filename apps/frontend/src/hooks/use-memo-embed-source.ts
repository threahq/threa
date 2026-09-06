import { useMemo } from "react"
import { useParams } from "react-router-dom"
import type { KnowledgeType, MemoType } from "@threahq/types"
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
  /** Still resolving. The card renders the label it already has, at full size. */
  status: "pending"
}

export type MemoEmbedSource = MemoEmbedResolved | MemoEmbedMissing | MemoEmbedPending

/**
 * Resolve a memo-embed pointer's card content from the memo detail API.
 *
 * There is no loading state to stagger: `MemoEmbedCardBody` gives every status
 * the same geometry and falls back to the title parsed from the reference, so a
 * pending card is a complete card with a thinner eyebrow, not a placeholder.
 *
 * The viewer's read access is enforced server-side — the detail endpoint 404s
 * for memos the viewer can't see, which surfaces here as `missing`.
 */
export function useMemoEmbedSource(memoId: string): MemoEmbedSource {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { data, isError } = useMemoDetail(workspaceId ?? "", memoId)

  return useMemo<MemoEmbedSource>(() => {
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
    return { status: "pending" }
  }, [data, isError])
}
